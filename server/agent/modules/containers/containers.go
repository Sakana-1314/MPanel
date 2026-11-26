// Package containers exposes Docker containers, images and compose stacks for
// the agent. Every operation goes through the shared command Runner with an
// argument array; no shell string is ever built. When the docker CLI or daemon
// is unavailable, lists degrade to {available:false,reason,items:[]} and write
// operations return UNAVAILABLE with an actionable hint, never a 500.
package containers

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/sakana-1314/mpanel/server/agent"
	"github.com/sakana-1314/mpanel/server/core/httpapi"
	"github.com/sakana-1314/mpanel/server/core/protocol"
)

// Module implements the container, image and stack endpoints of contract §9.
type Module struct {
	ctx    *agent.Context
	docker *dockerClient
	stacks *stackManager
	logger *slog.Logger
	// daemonConfigPath is the docker daemon.json read/written by §9.5.
	daemonConfigPath string

	// opMu serialises stack file mutations and compose actions so two requests
	// cannot race on the same compose.yaml.
	opMu sync.Mutex
}

// New returns the containers module.
func New() *Module { return &Module{} }

// Name implements agent.Module.
func (m *Module) Name() string { return "containers" }

// Register implements agent.Module.
func (m *Module) Register(ctx *agent.Context) error {
	if ctx == nil || ctx.Mux == nil {
		return errors.New("containers: 缺少 agent.Context")
	}
	if ctx.Runner == nil {
		return errors.New("containers: 缺少命令执行器")
	}
	logger := ctx.Logger
	if logger == nil {
		logger = slog.Default()
	}
	bin := dockerDefaultBin
	dataDir := ""
	daemonConfig := defaultDaemonConfigPath
	if ctx.Cfg != nil {
		if strings.TrimSpace(ctx.Cfg.Agent.DockerBin) != "" {
			bin = ctx.Cfg.Agent.DockerBin
		}
		if strings.TrimSpace(ctx.Cfg.Agent.DockerConfig) != "" {
			daemonConfig = ctx.Cfg.Agent.DockerConfig
		}
		dataDir = ctx.DataDir()
	}
	m.docker = newDockerClient(ctx.Runner, bin)
	m.stacks = newStackManager(dataDir)
	m.daemonConfigPath = daemonConfig
	m.logger = logger
	m.ctx = ctx

	mux := ctx.Mux
	mux.HandleFunc("GET /api/v1/containers", m.handleListContainers)
	// 面板的「一键运行」：用可视化表单创建并启动容器。
	mux.HandleFunc("POST /api/v1/containers", m.handleCreateContainer)
	mux.HandleFunc("GET /api/v1/containers/{id}", m.handleGetContainer)
	mux.HandleFunc("POST /api/v1/containers/{id}/start", m.handleContainerAction("start"))
	mux.HandleFunc("POST /api/v1/containers/{id}/stop", m.handleContainerAction("stop"))
	mux.HandleFunc("POST /api/v1/containers/{id}/restart", m.handleContainerAction("restart"))
	mux.HandleFunc("DELETE /api/v1/containers/{id}", m.handleRemoveContainer)
	// Contract §9.2 uses DELETE. The POST alias is additive and keeps clients
	// that model removal as an action working.
	mux.HandleFunc("POST /api/v1/containers/{id}/remove", m.handleRemoveContainer)
	mux.HandleFunc("GET /api/v1/containers/{id}/logs", m.handleContainerLogs)
	mux.HandleFunc("GET /api/v1/containers/{id}/stats", m.handleContainerStats)
	mux.HandleFunc("POST /api/v1/containers/{id}/exec", m.handleContainerExec)

	mux.HandleFunc("GET /api/v1/images", m.handleListImages)
	mux.HandleFunc("POST /api/v1/images/pull", m.handlePullImage)
	mux.HandleFunc("POST /api/v1/images/prune", m.handlePruneImages)
	mux.HandleFunc("DELETE /api/v1/images/{id}", m.handleRemoveImage)

	// §9.5 网络与守护进程配置。静态路径比 /containers/{id} 更具体，不会冲突。
	mux.HandleFunc("GET /api/v1/containers/networks", m.handleListNetworks)
	mux.HandleFunc("POST /api/v1/containers/networks", m.handleCreateNetwork)
	// Go 1.22 ServeMux cannot distinguish /containers/networks/{name} from
	// /containers/{id}/logs (both 3 segments with one wildcard); the /inspect
	// suffix keeps the route unambiguous.
	mux.HandleFunc("GET /api/v1/containers/networks/{name}/inspect", m.handleGetNetwork)
	mux.HandleFunc("DELETE /api/v1/containers/networks/{name}", m.handleRemoveNetwork)
	mux.HandleFunc("GET /api/v1/containers/config", m.handleGetDaemonConfig)
	mux.HandleFunc("PUT /api/v1/containers/config", m.handleUpdateDaemonConfig)

	mux.HandleFunc("GET /api/v1/stacks", m.handleListStacks)
	mux.HandleFunc("POST /api/v1/stacks", m.handleCreateStack)
	mux.HandleFunc("GET /api/v1/stacks/{name}", m.handleGetStack)
	mux.HandleFunc("PUT /api/v1/stacks/{name}", m.handleUpdateStack)
	mux.HandleFunc("DELETE /api/v1/stacks/{name}", m.handleDeleteStack)
	mux.HandleFunc("GET /api/v1/stacks/{name}/compose", m.handleGetStack)
	mux.HandleFunc("PUT /api/v1/stacks/{name}/compose", m.handleUpdateStack)
	mux.HandleFunc("POST /api/v1/stacks/{name}/up", m.handleStackAction("up"))
	mux.HandleFunc("POST /api/v1/stacks/{name}/down", m.handleStackAction("down"))
	mux.HandleFunc("POST /api/v1/stacks/{name}/restart", m.handleStackAction("restart"))
	mux.HandleFunc("POST /api/v1/stacks/{name}/pull", m.handleStackAction("pull"))
	mux.HandleFunc("GET /api/v1/stacks/{name}/logs", m.handleStackLogs)

	if ctx.WS != nil {
		ctx.WS.Handle("/ws/containers/", m.handleContainerLogsWS)
	}
	return nil
}

/* ------------------------------- containers ------------------------------- */

func (m *Module) handleListContainers(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	all, ok := parseQueryBool(query.Get("all"), false)
	if !ok {
		httpapi.Fail(w, protocol.BadRequest("all 必须是布尔值"))
		return
	}
	status := strings.TrimSpace(query.Get("status"))
	if status != "" && !containerStatuses[status] {
		httpapi.Fail(w, protocol.BadRequest("status 不是 Docker 支持的容器状态"))
		return
	}
	limit, cursor, pErr := parsePageQuery(query)
	if pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}

	available, reason := m.docker.check(r.Context())
	if !available {
		httpapi.OK(w, protocol.UnavailableList[ContainerSummary](reason))
		return
	}
	items, pErr := m.docker.listContainers(r.Context(), all, status)
	if pErr != nil {
		httpapi.OK(w, protocol.UnavailableList[ContainerSummary](panelErrorReason(pErr)))
		return
	}
	needle := strings.ToLower(strings.TrimSpace(query.Get("q")))
	if needle != "" {
		filtered := items[:0]
		for _, item := range items {
			if containerMatches(item, needle) {
				filtered = append(filtered, item)
			}
		}
		items = filtered
	}
	httpapi.OK(w, makeListResult(items, limit, cursor))
}

func containerMatches(container ContainerSummary, needle string) bool {
	candidates := []string{
		container.ID, container.Image, container.ImageID, container.State,
		container.Status, container.Command,
	}
	candidates = append(candidates, container.Names...)
	if container.ComposeProject != nil {
		candidates = append(candidates, *container.ComposeProject)
	}
	if container.ComposeService != nil {
		candidates = append(candidates, *container.ComposeService)
	}
	for _, value := range candidates {
		if strings.Contains(strings.ToLower(value), needle) {
			return true
		}
	}
	return false
}

func (m *Module) handleGetContainer(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !validContainerRef(id) {
		httpapi.Fail(w, protocol.BadRequest("容器 id 不合法"))
		return
	}
	if pErr := m.docker.ensure(r.Context()); pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}
	detail, pErr := m.docker.inspectContainer(r.Context(), id)
	if pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}
	httpapi.OK(w, detail)
}

type containerActionInput struct {
	TimeoutSec *int `json:"timeoutSec"`
}

func (m *Module) handleContainerAction(action string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if !validContainerRef(id) {
			httpapi.Fail(w, protocol.BadRequest("容器 id 不合法"))
			return
		}
		var timeoutSec *int
		if action == "stop" || action == "restart" {
			var body containerActionInput
			if !httpapi.DecodeJSON(w, r, &body) {
				return
			}
			if body.TimeoutSec != nil {
				if *body.TimeoutSec < 0 || *body.TimeoutSec > 600 {
					httpapi.Fail(w, protocol.BadRequest("timeoutSec 必须在 0..600 之间"))
					return
				}
				timeoutSec = body.TimeoutSec
			}
		}
		if pErr := m.docker.ensure(r.Context()); pErr != nil {
			httpapi.Fail(w, pErr)
			return
		}
		args := []string{action}
		if timeoutSec != nil {
			args = append(args, "--time", strconv.Itoa(*timeoutSec))
		}
		args = append(args, id)
		timeout := 60 * time.Second
		if timeoutSec != nil && *timeoutSec > 0 {
			timeout = time.Duration(*timeoutSec+60) * time.Second
		}
		res, err := m.docker.run(r.Context(), timeout, args...)
		if err != nil {
			httpapi.Fail(w, m.docker.unavailable("无法执行 docker "+action+"："+err.Error()))
			return
		}
		if res.Code != 0 {
			if isNoSuchContainerOutput(res) {
				httpapi.Fail(w, protocol.NotFound("容器", id))
				return
			}
			httpapi.Fail(w, dockerCommandFailed(action, res))
			return
		}
		httpapi.OK(w, containerActionResult{OK: true, Action: action, ID: id})
	}
}

type containerRemoveInput struct {
	Force         *bool `json:"force"`
	RemoveVolumes *bool `json:"removeVolumes"`
}

func (m *Module) handleRemoveContainer(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !validContainerRef(id) {
		httpapi.Fail(w, protocol.BadRequest("容器 id 不合法"))
		return
	}
	query := r.URL.Query()
	force, ok := parseQueryBool(query.Get("force"), false)
	if !ok {
		httpapi.Fail(w, protocol.BadRequest("force 必须是布尔值"))
		return
	}
	removeVolumes, ok := parseQueryBool(query.Get("removeVolumes"), false)
	if !ok {
		httpapi.Fail(w, protocol.BadRequest("removeVolumes 必须是布尔值"))
		return
	}
	if r.Method == http.MethodPost {
		var body containerRemoveInput
		if !httpapi.DecodeJSON(w, r, &body) {
			return
		}
		if body.Force != nil {
			force = *body.Force
		}
		if body.RemoveVolumes != nil {
			removeVolumes = *body.RemoveVolumes
		}
	}
	if pErr := m.docker.ensure(r.Context()); pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}
	args := []string{"rm"}
	if force {
		args = append(args, "--force")
	}
	if removeVolumes {
		args = append(args, "--volumes")
	}
	args = append(args, id)
	res, err := m.docker.run(r.Context(), 120*time.Second, args...)
	if err != nil {
		httpapi.Fail(w, m.docker.unavailable("无法执行 docker rm："+err.Error()))
		return
	}
	if res.Code != 0 {
		if isNoSuchContainerOutput(res) {
			httpapi.Fail(w, protocol.NotFound("容器", id))
			return
		}
		pErr := dockerCommandFailed("rm", res)
		text := strings.ToLower(res.Stderr + "\n" + res.Stdout)
		if strings.Contains(text, "cannot remove") || strings.Contains(text, "is running") ||
			strings.Contains(text, "in use") || strings.Contains(text, "conflict") {
			pErr.Hint = "容器仍在运行或被占用；可先 stop，或在确认后使用 force=true。"
		}
		httpapi.Fail(w, pErr)
		return
	}
	httpapi.OK(w, containerRemoveResult{Removed: true, ID: id})
}

/* --------------------------------- logs ---------------------------------- */

type containerLogsQuery struct {
	Tail       int
	Since      string
	Timestamps bool
	Stdout     bool
	Stderr     bool
	Follow     bool
}

func parseContainerLogsQuery(query url.Values, allowFollow bool) (containerLogsQuery, *protocol.PanelError) {
	options := containerLogsQuery{Tail: 200, Stdout: true, Stderr: true}
	if raw := strings.TrimSpace(query.Get("tail")); raw != "" {
		tail, err := strconv.Atoi(raw)
		if err != nil || tail < 0 || tail > maxTailLines {
			return options, protocol.BadRequest("tail 必须是 0.." + strconv.Itoa(maxTailLines) + " 的整数")
		}
		options.Tail = tail
	}
	if since := strings.TrimSpace(query.Get("since")); since != "" {
		if !validSince(since) {
			return options, &protocol.PanelError{
				Code:    protocol.CodeBadRequest,
				Message: "since 必须是 RFC3339 时间、Unix 时间戳或 Docker 时长（如 10m）",
			}
		}
		options.Since = since
	}
	for key, target := range map[string]*bool{
		"timestamps": &options.Timestamps,
		"stdout":     &options.Stdout,
		"stderr":     &options.Stderr,
	} {
		value, ok := parseQueryBool(query.Get(key), *target)
		if !ok {
			return options, protocol.BadRequest(key + " 必须是布尔值")
		}
		*target = value
	}
	if allowFollow {
		follow, ok := parseQueryBool(query.Get("follow"), false)
		if !ok {
			return options, protocol.BadRequest("follow 必须是布尔值")
		}
		options.Follow = follow
	}
	return options, nil
}

func buildLogsArgs(id string, options containerLogsQuery, follow bool) []string {
	args := []string{"logs", "--tail", strconv.Itoa(options.Tail)}
	if options.Since != "" {
		args = append(args, "--since", options.Since)
	}
	if options.Timestamps {
		args = append(args, "--timestamps")
	}
	if follow {
		args = append(args, "--follow")
	}
	args = append(args, id)
	return args
}

func (m *Module) handleContainerLogs(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !validContainerRef(id) {
		httpapi.Fail(w, protocol.BadRequest("容器 id 不合法"))
		return
	}
	options, pErr := parseContainerLogsQuery(r.URL.Query(), false)
	if pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}
	if pErr := m.docker.ensure(r.Context()); pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}
	if !options.Stdout && !options.Stderr {
		httpapi.OK(w, ContainerLogsResult{Logs: "", Truncated: false})
		return
	}
	res, err := m.docker.run(r.Context(), 60*time.Second, buildLogsArgs(id, options, false)...)
	if err != nil {
		httpapi.Fail(w, m.docker.unavailable("无法执行 docker logs："+err.Error()))
		return
	}
	if res.Code != 0 {
		if isNoSuchContainerOutput(res) {
			httpapi.Fail(w, protocol.NotFound("容器", id))
			return
		}
		httpapi.Fail(w, dockerCommandFailed("logs", res))
		return
	}
	combined := ""
	if options.Stdout {
		combined += res.Stdout
	}
	if options.Stderr && res.Stderr != "" {
		if combined != "" && !strings.HasSuffix(combined, "\n") {
			combined += "\n"
		}
		combined += res.Stderr
	}
	logs, truncated := truncateText(combined, maxLogBytes)
	httpapi.OK(w, ContainerLogsResult{Logs: logs, Truncated: truncated})
}

/* --------------------------------- stats --------------------------------- */

func (m *Module) handleContainerStats(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !validContainerRef(id) {
		httpapi.Fail(w, protocol.BadRequest("容器 id 不合法"))
		return
	}
	if pErr := m.docker.ensure(r.Context()); pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}
	res, err := m.docker.run(r.Context(), 30*time.Second, "stats", "--no-stream", "--format", "json", id)
	if err != nil {
		httpapi.Fail(w, m.docker.unavailable("无法执行 docker stats："+err.Error()))
		return
	}
	if res.Code != 0 {
		if isNoSuchContainerOutput(res) {
			httpapi.Fail(w, protocol.NotFound("容器", id))
			return
		}
		httpapi.Fail(w, dockerCommandFailed("stats", res))
		return
	}
	stats, ok := parseStatsOutput(res.Stdout)
	if !ok {
		httpapi.Fail(w, &protocol.PanelError{
			Code:    protocol.CodeUpstreamError,
			Message: "无法解析 docker stats 输出",
			Details: map[string]any{"output": truncateTextString(strings.TrimSpace(res.Stdout), dockerOutputDetails)},
		})
		return
	}
	httpapi.OK(w, ContainerStatsResult{Stats: stats})
}

/* --------------------------------- exec ---------------------------------- */

type execRequest struct {
	Command   []string `json:"command"`
	TimeoutMS *int     `json:"timeoutMs"`
	Workdir   string   `json:"workdir"`
	User      string   `json:"user"`
}

func validateExecRequest(request execRequest) (time.Duration, *protocol.PanelError) {
	if len(request.Command) == 0 {
		return 0, protocol.BadRequest("command 不能为空")
	}
	if len(request.Command) > maxExecArgs {
		return 0, protocol.BadRequest("command 参数过多，最多 " + strconv.Itoa(maxExecArgs) + " 个")
	}
	if strings.TrimSpace(request.Command[0]) == "" {
		return 0, protocol.BadRequest("command 的可执行文件不能为空")
	}
	total := 0
	for _, arg := range request.Command {
		if strings.ContainsRune(arg, 0) {
			return 0, protocol.BadRequest("command 参数不能包含 NUL 字符")
		}
		if len(arg) > maxExecArgBytes {
			return 0, protocol.BadRequest("command 单个参数过长，最多 4096 字节")
		}
		total += len(arg)
	}
	if total > maxExecTotalBytes {
		return 0, protocol.BadRequest("command 总长度超过 64 KiB 上限")
	}
	timeout := defaultExecTimeout
	if request.TimeoutMS != nil {
		if *request.TimeoutMS <= 0 || *request.TimeoutMS > maxExecTimeoutMs {
			return 0, protocol.BadRequest("timeoutMs 必须在 1..300000 之间")
		}
		timeout = time.Duration(*request.TimeoutMS) * time.Millisecond
	}
	if workdir := strings.TrimSpace(request.Workdir); workdir != "" {
		if len(request.Workdir) > 512 || hasControlChars(request.Workdir) {
			return 0, protocol.BadRequest("workdir 不合法")
		}
	}
	if user := strings.TrimSpace(request.User); user != "" && !userPattern.MatchString(user) {
		return 0, protocol.BadRequest("user 不合法")
	}
	return timeout, nil
}

func (m *Module) handleContainerExec(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !validContainerRef(id) {
		httpapi.Fail(w, protocol.BadRequest("容器 id 不合法"))
		return
	}
	var request execRequest
	if !httpapi.DecodeJSON(w, r, &request) {
		return
	}
	timeout, pErr := validateExecRequest(request)
	if pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}
	if pErr := m.docker.ensure(r.Context()); pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}
	// Existence is checked with inspect (docker's own JSON), never by matching
	// the command's stderr: a container command may legitimately print anything.
	if _, pErr := m.docker.inspectContainer(r.Context(), id); pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}

	args := []string{"exec"}
	if workdir := strings.TrimSpace(request.Workdir); workdir != "" {
		args = append(args, "--workdir", request.Workdir)
	}
	if user := strings.TrimSpace(request.User); user != "" {
		args = append(args, "--user", user)
	}
	// Terminate docker's own option parsing before the container name so a
	// command that starts with "-" can never be read as a docker flag.
	args = append(args, "--", id)
	args = append(args, request.Command...)

	started := time.Now()
	res, err := m.docker.runner.RunTimeout(r.Context(), timeout, m.docker.bin, args...)
	duration := time.Since(started)
	if err != nil {
		if r.Context().Err() != nil {
			httpapi.Fail(w, m.docker.unavailable("请求已取消"))
			return
		}
		timedOut := strings.Contains(err.Error(), "超时") ||
			strings.Contains(strings.ToLower(err.Error()), "timeout") ||
			errors.Is(err, context.DeadlineExceeded)
		if !timedOut {
			httpapi.Fail(w, m.docker.unavailable("无法执行 docker exec："+err.Error()))
			return
		}
		stdout, _ := truncateText(res.Stdout, maxExecStreamBytes)
		stderr, _ := truncateText(res.Stderr, maxExecStreamBytes)
		httpapi.OK(w, ExecResult{
			ExitCode:   nil,
			Stdout:     stdout,
			Stderr:     stderr,
			DurationMs: duration.Milliseconds(),
			Truncated:  true,
		})
		return
	}
	stdout, stdoutTruncated := truncateText(res.Stdout, maxExecStreamBytes)
	stderr, stderrTruncated := truncateText(res.Stderr, maxExecStreamBytes)
	exitCode := res.Code
	httpapi.OK(w, ExecResult{
		ExitCode:   &exitCode,
		Stdout:     stdout,
		Stderr:     stderr,
		DurationMs: duration.Milliseconds(),
		Truncated:  stdoutTruncated || stderrTruncated,
	})
}

/* ------------------------------- pagination ------------------------------- */

func parsePageQuery(query url.Values) (int, string, *protocol.PanelError) {
	limit := 50
	if raw := strings.TrimSpace(query.Get("limit")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > 200 {
			return 0, "", protocol.BadRequest("limit 必须是 1..200 的整数")
		}
		limit = parsed
	}
	cursor := strings.TrimSpace(query.Get("cursor"))
	if cursor != "" && !isDigits(cursor) {
		return 0, "", protocol.BadRequest("cursor 无效")
	}
	return limit, cursor, nil
}

func parseQueryBool(raw string, fallback bool) (bool, bool) {
	return parseBoolValue(raw, fallback)
}

func makeListResult[T any](items []T, limit int, cursor string) protocol.ListResult[T] {
	pageItems, next, total := protocol.Page(items, limit, cursor)
	if pageItems == nil {
		pageItems = []T{}
	}
	return protocol.ListResult[T]{
		Available:  true,
		Items:      pageItems,
		NextCursor: next,
		Total:      &total,
	}
}
