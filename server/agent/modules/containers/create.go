package containers

import (
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/sakana-1314/mpanel/server/core/httpapi"
	"github.com/sakana-1314/mpanel/server/core/protocol"
)

// 运行新容器的输入上限。面板上这些值来自表单，数量级远超正常使用即可，
// 目的是挡住误粘贴与恶意构造，而不是限制正常场景。
const (
	maxRunPorts    = 32
	maxRunVolumes  = 32
	maxRunEnv      = 64
	maxRunLabels   = 32
	maxRunCommands = 32
	runTimeout     = 180 * time.Second
)

var (
	// 允许 8080:80、127.0.0.1:8080:80、8080:80/udp 三种写法。
	portMapPattern = regexp.MustCompile(`^(?:(?:[0-9]{1,3}\.){3}[0-9]{1,3}:)?[0-9]{1,5}:[0-9]{1,5}(?:/(?:tcp|udp))?$`)
	restartPattern = regexp.MustCompile(`^(?:no|always|unless-stopped|on-failure(?::[1-9][0-9]{0,2})?)$`)
	envKeyPattern  = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)
	volumePattern  = regexp.MustCompile(`^(?:[A-Za-z0-9._/-]+):([A-Za-z0-9._/-]+)(?::(?:ro|rw))?$`)
)

// ContainerCreateInput 是 POST /containers 的请求体。
//
// 面板的「一键运行」把可视化表单映射到这里：镜像、端口、环境变量、卷、重启策略
// 都是 docker run 的常用参数，不暴露 --privileged 之类的高危开关。
type ContainerCreateInput struct {
	Name    string            `json:"name,omitempty"`
	Image   string            `json:"image"`
	Command []string          `json:"command,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
	Ports   []string          `json:"ports,omitempty"`
	Volumes []string          `json:"volumes,omitempty"`
	Network string            `json:"network,omitempty"`
	Restart string            `json:"restart,omitempty"`
	Labels  map[string]string `json:"labels,omitempty"`
}

// ContainerCreated 是创建成功的返回值。
type ContainerCreated struct {
	ID    string           `json:"id"`
	OK    bool             `json:"ok"`
	Name  string           `json:"name,omitempty"`
	Image string           `json:"image"`
	Ports []string         `json:"ports"`
	Info  *ContainerDetail `json:"container,omitempty"`
}

func (m *Module) handleCreateContainer(w http.ResponseWriter, r *http.Request) {
	var input ContainerCreateInput
	if !httpapi.DecodeJSON(w, r, &input) {
		return
	}
	args, created, pErr := buildRunArgs(input)
	if pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}
	if pErr := m.docker.ensure(r.Context()); pErr != nil {
		httpapi.Fail(w, pErr)
		return
	}

	result, err := m.docker.run(r.Context(), runTimeout, args...)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	if result.Code != 0 {
		httpapi.Fail(w, dockerCommandFailed("run", result))
		return
	}
	if id := strings.TrimSpace(result.Stdout); id != "" {
		created.ID = id
		if detail, pErr := m.docker.inspectContainer(r.Context(), id); pErr == nil {
			created.Info = &detail
			if name := firstContainerName(&detail); name != "" {
				created.Name = name
			}
		}
	}
	httpapi.Created(w, created)
}

// buildRunArgs 校验输入并拼出 docker run 的 argv。所有参数都是独立元素，
// 不经过 shell，因此镜像名里的特殊字符不会被解释。
func buildRunArgs(input ContainerCreateInput) ([]string, *ContainerCreated, *protocol.PanelError) {
	image := strings.TrimSpace(input.Image)
	if !imageRefPattern.MatchString(image) {
		return nil, nil, badRequestWithHint("镜像名不合法", "例如 postgres:16、redis:7-alpine、nginx:alpine。")
	}
	name := strings.TrimSpace(input.Name)
	if name != "" && !containerRefPattern.MatchString(name) {
		return nil, nil, protocol.BadRequest("容器名只能包含字母、数字、下划线、点和短横线，且以字母或数字开头")
	}
	restart := strings.TrimSpace(input.Restart)
	if restart == "" {
		restart = "unless-stopped"
	}
	if !restartPattern.MatchString(restart) {
		return nil, nil, protocol.BadRequest("重启策略只允许 no、always、unless-stopped、on-failure[:次数]")
	}
	if len(input.Ports) > maxRunPorts || len(input.Volumes) > maxRunVolumes ||
		len(input.Env) > maxRunEnv || len(input.Labels) > maxRunLabels ||
		len(input.Command) > maxRunCommands {
		return nil, nil, protocol.BadRequest("端口/卷/环境变量/标签/命令数量超出上限")
	}

	args := []string{"run", "-d"}
	if name != "" {
		args = append(args, "--name", name)
	}
	args = append(args, "--restart", restart)

	for _, raw := range input.Ports {
		port := strings.TrimSpace(raw)
		if port == "" {
			continue
		}
		if !portMapPattern.MatchString(port) {
			return nil, nil, badRequestWithHint("端口映射不合法："+port, "格式为 宿主端口:容器端口，例如 8080:80。")
		}
		if !portNumbersValid(port) {
			return nil, nil, protocol.BadRequest("端口超出 1–65535：" + port)
		}
		args = append(args, "--publish", port)
	}

	for _, raw := range input.Volumes {
		volume := strings.TrimSpace(raw)
		if volume == "" {
			continue
		}
		if !volumePattern.MatchString(volume) {
			return nil, nil, badRequestWithHint("卷挂载不合法："+volume, "格式为 宿主路径:容器路径[:ro|rw]，例如 /opt/mpanel/data/pg:/var/lib/postgresql/data。")
		}
		args = append(args, "--volume", volume)
	}

	for _, key := range sortedKeys(input.Env) {
		if !envKeyPattern.MatchString(key) {
			return nil, nil, protocol.BadRequest("环境变量名不合法：" + key)
		}
		args = append(args, "--env", key+"="+input.Env[key])
	}
	for _, key := range sortedKeys(input.Labels) {
		if !envKeyPattern.MatchString(strings.ReplaceAll(key, ".", "_")) {
			return nil, nil, protocol.BadRequest("标签名不合法：" + key)
		}
		args = append(args, "--label", key+"="+input.Labels[key])
	}

	if network := strings.TrimSpace(input.Network); network != "" {
		if !containerRefPattern.MatchString(network) {
			return nil, nil, protocol.BadRequest("网络名不合法")
		}
		args = append(args, "--network", network)
	}

	args = append(args, image)
	for _, cmd := range input.Command {
		if trimmed := strings.TrimSpace(cmd); trimmed != "" {
			args = append(args, trimmed)
		}
	}

	return args, &ContainerCreated{OK: true, Image: image, Ports: input.Ports}, nil
}

func badRequestWithHint(message, hint string) *protocol.PanelError {
	return &protocol.PanelError{Code: protocol.CodeBadRequest, Message: message, Hint: hint}
}

func portNumbersValid(mapping string) bool {
	body := mapping
	if idx := strings.IndexByte(body, '/'); idx >= 0 {
		body = body[:idx]
	}
	parts := strings.Split(body, ":")
	for _, part := range parts[len(parts)-2:] {
		n, err := strconv.Atoi(part)
		if err != nil || n < 1 || n > 65535 {
			return false
		}
	}
	return true
}

func sortedKeys(input map[string]string) []string {
	keys := make([]string, 0, len(input))
	for key := range input {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func firstContainerName(detail *ContainerDetail) string {
	if detail == nil || len(detail.Names) == 0 {
		return ""
	}
	return strings.TrimPrefix(detail.Names[0], "/")
}
