package containers

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/sakana-1314/mpanel/server/agent"
	"github.com/sakana-1314/mpanel/server/core/config"
	"github.com/sakana-1314/mpanel/server/core/protocol"
)

/* ------------------------------- test harness ----------------------------- */

type fakeRunner struct {
	mu      sync.Mutex
	calls   [][]string
	handler func(args []string) (agent.Result, error)
}

func (f *fakeRunner) Run(ctx context.Context, name string, args ...string) (agent.Result, error) {
	return f.RunTimeout(ctx, 0, name, args...)
}

func (f *fakeRunner) RunTimeout(_ context.Context, _ time.Duration, name string, args ...string) (agent.Result, error) {
	f.mu.Lock()
	copied := append([]string{}, args...)
	f.calls = append(f.calls, copied)
	handler := f.handler
	f.mu.Unlock()
	if handler == nil {
		return agent.Result{}, nil
	}
	return handler(copied)
}

func (f *fakeRunner) Stream(ctx context.Context, name string, args []string, onLine func(string)) (agent.Result, error) {
	result, err := f.RunTimeout(ctx, 0, name, args...)
	if err != nil {
		return result, err
	}
	if onLine != nil && result.Stdout != "" {
		for _, line := range strings.Split(strings.TrimRight(result.Stdout, "\n"), "\n") {
			onLine(line)
		}
	}
	return result, nil
}

func (f *fakeRunner) callCount(prefix string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	count := 0
	for _, call := range f.calls {
		if len(call) > 0 && call[0] == prefix {
			count++
		}
	}
	return count
}

func (f *fakeRunner) findCall(first string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, call := range f.calls {
		if len(call) > 0 && call[0] == first {
			return append([]string{}, call...)
		}
	}
	return nil
}

func (f *fakeRunner) lastCall(first string) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := len(f.calls) - 1; i >= 0; i-- {
		if len(f.calls[i]) > 0 && f.calls[i][0] == first {
			return append([]string{}, f.calls[i]...)
		}
	}
	return nil
}

type testEnv struct {
	module  *Module
	handler http.Handler
	runner  *fakeRunner
	dataDir string
}

func newTestEnv(t *testing.T, handler func(args []string) (agent.Result, error)) *testEnv {
	t.Helper()
	dataDir := t.TempDir()
	runner := &fakeRunner{handler: handler}
	cfg := &config.Agent{Agent: config.AgentSystem{DockerBin: "docker", DataDir: dataDir}}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	ctx := &agent.Context{
		Mux:    http.NewServeMux(),
		WS:     agent.NewWSRegistry(),
		Cfg:    cfg,
		Runner: runner,
		Jobs:   agent.NewJobManager(filepath.Join(dataDir, "jobs"), logger),
		Logger: logger,
	}
	module := New()
	if err := module.Register(ctx); err != nil {
		t.Fatalf("Register: %v", err)
	}
	return &testEnv{module: module, handler: ctx.Mux, runner: runner, dataDir: dataDir}
}

type testEnvelope struct {
	OK    bool               `json:"ok"`
	Data  json.RawMessage    `json:"data"`
	Error *protocol.APIError `json:"error"`
}

func apiCall(t *testing.T, handler http.Handler, method, path, body string) (int, testEnvelope) {
	t.Helper()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	var envelope testEnvelope
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("%s %s: 响应不是信封 JSON: %v\n%s", method, path, err, recorder.Body.String())
	}
	return recorder.Code, envelope
}

func decodeData[T any](t *testing.T, raw json.RawMessage) T {
	t.Helper()
	var value T
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatalf("解析 data 失败: %v\n%s", err, string(raw))
	}
	return value
}

func dockerVersionOnly(args []string) (agent.Result, error) {
	if args[0] == "version" {
		return agent.Result{}, nil
	}
	return agent.Result{Code: 1, Stderr: "unexpected command"}, nil
}

/* ---------------------------------- fixtures ------------------------------ */

const psFixture = `{"ID":"aaa111","Names":"/web-1","Image":"nginx:latest","Command":"nginx","CreatedAt":"2024-01-03 04:05:06 +0800 CST","State":"running","Status":"Up 2 hours","Ports":"0.0.0.0:8080->80/tcp, :::8080->80/tcp","Labels":"com.docker.compose.project=web,com.docker.compose.service=frontend,maintainer=mpanel"}
{"ID":"bbb222","Names":"/db-1","Image":"postgres:16","CreatedAt":"2024-01-02 04:05:06 +0000 UTC","State":"exited","Status":"Exited (0)","Ports":"5432/tcp","Labels":""}
not-a-json-line
{"ID":"ccc333","Names":"/solo","Image":"alpine","CreatedAt":"2024-01-01 04:05:06 +0000 UTC","State":"running","Status":"Up 1 day","Ports":""}`

const inspectFixture = `[{"Id":"abc123","Name":"/web-1","Image":"sha256:image","Created":"2024-01-03T04:05:06.123456789Z","Platform":"linux","Config":{"Image":"nginx:latest","Cmd":["nginx","-g","daemon off;"],"Env":["PATH=/usr/bin","FOO=bar"],"Labels":{"com.docker.compose.project":"web","com.docker.compose.service":"frontend"},"ExposedPorts":{"80/tcp":{}}},"State":{"Status":"running","Running":true,"StartedAt":"2024-01-03T04:05:07Z","Health":{"Status":"healthy"}},"HostConfig":{"RestartPolicy":{"Name":"always"},"NetworkMode":"bridge"},"Mounts":[{"Type":"bind","Source":"/data","Destination":"/usr/share/nginx/html","Mode":"rw","RW":true}],"NetworkSettings":{"Ports":{"80/tcp":[{"HostIp":"0.0.0.0","HostPort":"8080"}]}}}]`

const stackPSFixture = `{"ID":"aaa111","Names":"/web-app-1","Image":"nginx","CreatedAt":"2024-01-03 04:05:06 +0000 UTC","State":"running","Status":"Up","Ports":"","Labels":"com.docker.compose.project=web,com.docker.compose.service=app"}`

const imageInspectFixture = `[{"Id":"sha256:aaa","RepoTags":["nginx:latest"],"RepoDigests":["nginx@sha256:111"],"Created":"2024-01-03T04:05:06.123456789Z","Size":187000000,"Config":{"Labels":{"maintainer":"nginx"}}}]`

/* ---------------------------------- tests --------------------------------- */

func TestValidContainerRef(t *testing.T) {
	valid := []string{"a", "abc", "a_b.c-1", "0123456789", strings.Repeat("a", 128)}
	for _, id := range valid {
		if !validContainerRef(id) {
			t.Fatalf("应接受容器 id %q", id)
		}
	}
	invalid := []string{"", "-abc", ".abc", "abc/def", "abc def", "容器", strings.Repeat("a", 129), "abc\n"}
	for _, id := range invalid {
		if validContainerRef(id) {
			t.Fatalf("应拒绝容器 id %q", id)
		}
	}
}

func TestValidStackName(t *testing.T) {
	valid := []string{"a", "web", "my-stack_1", strings.Repeat("a", 63)}
	for _, name := range valid {
		if !validStackName(name) {
			t.Fatalf("应接受编排名称 %q", name)
		}
	}
	invalid := []string{"", "Web", "-web", "_web", "web/app", "web app", strings.Repeat("a", 64), "con", ".."}
	for _, name := range invalid {
		if validStackName(name) {
			t.Fatalf("应拒绝编排名称 %q", name)
		}
	}
}

func TestValidImageRef(t *testing.T) {
	valid := []string{"nginx", "nginx:1.25", "ghcr.io/owner/app:v1", "sha256:abc", "registry:5000/a_b-c@sha256:deadbeef"}
	for _, ref := range valid {
		if !validImageRef(ref) {
			t.Fatalf("应接受镜像引用 %q", ref)
		}
	}
	invalid := []string{"", "-nginx", "nginx latest", "nginx\nlatest", strings.Repeat("a", 600)}
	for _, ref := range invalid {
		if validImageRef(ref) {
			t.Fatalf("应拒绝镜像引用 %q", ref)
		}
	}
}

func TestParseContainerSummaries(t *testing.T) {
	containers := parseContainerSummaries(psFixture)
	if len(containers) != 3 {
		t.Fatalf("应解析 3 个容器，实际 %d", len(containers))
	}
	if containers[0].ID != "aaa111" {
		t.Fatalf("默认应按创建时间倒序，首项为 %q", containers[0].ID)
	}
	web := containers[0]
	if len(web.Names) != 1 || web.Names[0] != "web-1" {
		t.Fatalf("names 解析错误: %#v", web.Names)
	}
	if web.Labels["maintainer"] != "mpanel" {
		t.Fatalf("labels 解析错误: %#v", web.Labels)
	}
	if web.ComposeProject == nil || *web.ComposeProject != "web" {
		t.Fatalf("composeProject 解析错误: %#v", web.ComposeProject)
	}
	if web.ComposeService == nil || *web.ComposeService != "frontend" {
		t.Fatalf("composeService 解析错误: %#v", web.ComposeService)
	}
	if _, err := time.Parse(time.RFC3339, web.Created); err != nil {
		t.Fatalf("created 未归一化为 RFC3339: %q", web.Created)
	}
	if len(web.Ports) != 2 {
		t.Fatalf("应解析出 2 个端口，实际 %#v", web.Ports)
	}
	if web.Ports[0].PrivatePort != 80 || web.Ports[0].PublicPort == nil || *web.Ports[0].PublicPort != 8080 {
		t.Fatalf("端口解析错误: %#v", web.Ports[0])
	}
	db := containers[1]
	if len(db.Ports) != 1 || db.Ports[0].PrivatePort != 5432 || db.Ports[0].PublicPort != nil {
		t.Fatalf("未映射端口解析错误: %#v", db.Ports)
	}
	if db.ComposeProject != nil {
		t.Fatalf("无 compose label 时应为 nil")
	}

	tolerant := parseContainerSummaries(`{"ID":"minimal"}`)
	if len(tolerant) != 1 {
		t.Fatalf("缺字段行应被容错解析")
	}
	if tolerant[0].Names == nil || tolerant[0].Ports == nil || tolerant[0].Labels == nil {
		t.Fatalf("缺字段行应填充空集合: %#v", tolerant[0])
	}
}

func TestParseImageSummaries(t *testing.T) {
	fixture := `{"ID":"sha256:aaa","Repository":"nginx","Tag":"latest","Digest":"sha256:111","CreatedAt":"2024-01-03 04:05:06 +0000 UTC","Size":"187MB"}
{"ID":"sha256:aaa","Repository":"nginx","Tag":"1.25","Digest":"<none>","CreatedAt":"2024-01-03 04:05:06 +0000 UTC","Size":"187MB"}
{"ID":"sha256:bbb","Repository":"<none>","Tag":"<none>","Digest":"<none>","CreatedAt":"2024-01-02 04:05:06 +0000 UTC","Size":"100MB"}
broken line`
	images := parseImageSummaries(fixture)
	if len(images) != 2 {
		t.Fatalf("应按镜像 ID 聚合为 2 项，实际 %d", len(images))
	}
	if images[0].ID != "sha256:aaa" || images[0].Dangling {
		t.Fatalf("首个镜像解析错误: %#v", images[0])
	}
	if len(images[0].RepoTags) != 2 {
		t.Fatalf("应聚合同一镜像的 2 个 tag: %#v", images[0].RepoTags)
	}
	if len(images[0].RepoDigests) != 1 || images[0].RepoDigests[0] != "nginx@sha256:111" {
		t.Fatalf("digest 聚合错误: %#v", images[0].RepoDigests)
	}
	if images[0].SizeBytes != 187000000 {
		t.Fatalf("size 解析错误: %d", images[0].SizeBytes)
	}
	if !images[1].Dangling || len(images[1].RepoTags) != 0 {
		t.Fatalf("dangling 镜像解析错误: %#v", images[1])
	}
}

func TestParseDockerSizeAndStats(t *testing.T) {
	cases := map[string]int64{
		"0B": 0, "1kB": 1000, "2MB": 2000000, "1.5MiB": 1572864,
		"7.6GiB": 8160437862, "N/A": 0, "": 0,
	}
	for input, want := range cases {
		if got := parseDockerSize(input); got != want {
			t.Fatalf("parseDockerSize(%q)=%d，期望 %d", input, got, want)
		}
	}

	stats, ok := parseStatsOutput(`{"CPUPerc":"1.23%","MemUsage":"10MiB / 1GiB","MemPerc":"0.98%","NetIO":"1kB / 2kB","BlockIO":"3kB / 4kB","PIDs":"7","ID":"abc"}`)
	if !ok {
		t.Fatal("stats 应解析成功")
	}
	if stats.CPUPercent != 1.23 || stats.MemoryUsageBytes != 10<<20 ||
		stats.MemoryLimitBytes != 1<<30 || stats.MemoryPercent != 0.98 {
		t.Fatalf("stats 解析错误: %#v", stats)
	}
	if stats.NetworkRxBytes != 1000 || stats.NetworkTxBytes != 2000 ||
		stats.BlockReadBytes != 3000 || stats.BlockWriteBytes != 4000 || stats.PIDs != 7 {
		t.Fatalf("stats IO/PIDs 解析错误: %#v", stats)
	}
	if _, err := time.Parse(time.RFC3339, stats.ReadAt); err != nil {
		t.Fatalf("readAt 不是 RFC3339: %q", stats.ReadAt)
	}

	if _, ok := parseStatsOutput("not json"); ok {
		t.Fatal("非法 stats 输出应返回 false")
	}
}

func TestParseContainerLogsQuery(t *testing.T) {
	query := httptest.NewRequest(http.MethodGet, "/?tail=50&follow=1&stdout=0&stderr=1&timestamps=1", nil).URL.Query()
	options, pErr := parseContainerLogsQuery(query, true)
	if pErr != nil {
		t.Fatalf("合法 query 不应报错: %v", pErr)
	}
	if options.Tail != 50 || !options.Follow || options.Stdout || !options.Stderr || !options.Timestamps {
		t.Fatalf("query 解析错误: %#v", options)
	}
	bad := httptest.NewRequest(http.MethodGet, "/?tail=10001", nil).URL.Query()
	if _, pErr := parseContainerLogsQuery(bad, false); pErr == nil || pErr.Code != protocol.CodeBadRequest {
		t.Fatal("越界 tail 应返回 BAD_REQUEST")
	}
	badSince := httptest.NewRequest(http.MethodGet, "/?since=2024-01-01%2000:00:00", nil).URL.Query()
	if _, pErr := parseContainerLogsQuery(badSince, false); pErr == nil {
		t.Fatal("带空格的 since 应返回 BAD_REQUEST")
	}
}

func TestWSLogsPathAndTimestampSplit(t *testing.T) {
	id, ok := parseWSLogsPath("/ws/containers/abc123/logs")
	if !ok || id != "abc123" {
		t.Fatalf("WS 路径解析错误: %q %v", id, ok)
	}
	for _, path := range []string{
		"/ws/containers/abc123", "/ws/containers//logs",
		"/ws/containers/abc123/logs/extra", "/ws/terminal/abc/logs",
	} {
		if _, ok := parseWSLogsPath(path); ok {
			t.Fatalf("应拒绝 WS 路径 %q", path)
		}
	}
	ts, data := splitLogTimestamp("2024-01-02T03:04:05.123456789Z hello world", true)
	if ts != "2024-01-02T03:04:05.123456789Z" || data != "hello world" {
		t.Fatalf("时间戳拆分错误: %q %q", ts, data)
	}
	ts, data = splitLogTimestamp("plain line", true)
	if ts != "" || data != "plain line" {
		t.Fatalf("无时间戳行不应拆分: %q %q", ts, data)
	}
	ts, data = splitLogTimestamp("2024-01-02T03:04:05Z hello", false)
	if ts != "" || data != "2024-01-02T03:04:05Z hello" {
		t.Fatalf("未启用 timestamps 时不应拆分: %q %q", ts, data)
	}
}

func TestListContainersSuccessAndPagination(t *testing.T) {
	env := newTestEnv(t, func(args []string) (agent.Result, error) {
		if args[0] == "version" {
			return agent.Result{}, nil
		}
		if args[0] == "ps" {
			return agent.Result{Stdout: psFixture}, nil
		}
		return agent.Result{Code: 1, Stderr: "unexpected"}, nil
	})

	status, envelope := apiCall(t, env.handler, http.MethodGet, "/api/v1/containers?limit=2", "")
	if status != http.StatusOK || !envelope.OK {
		t.Fatalf("列表失败: %d %#v", status, envelope.Error)
	}
	list := decodeData[protocol.ListResult[ContainerSummary]](t, envelope.Data)
	if !list.Available || list.Total == nil || *list.Total != 3 {
		t.Fatalf("列表结果错误: %#v", list)
	}
	if len(list.Items) != 2 || list.NextCursor != "2" {
		t.Fatalf("第一页错误: %#v cursor=%q", list.Items, list.NextCursor)
	}
	if list.Items[0].ID != "aaa111" || list.Items[1].ID != "bbb222" {
		t.Fatalf("默认 created desc 排序错误: %#v", list.Items)
	}

	status, envelope = apiCall(t, env.handler, http.MethodGet, "/api/v1/containers?limit=2&cursor=2", "")
	if status != http.StatusOK {
		t.Fatalf("第二页失败: %d", status)
	}
	second := decodeData[protocol.ListResult[ContainerSummary]](t, envelope.Data)
	if len(second.Items) != 1 || second.NextCursor != "" || second.Items[0].ID != "ccc333" {
		t.Fatalf("第二页错误: %#v cursor=%q", second.Items, second.NextCursor)
	}

	status, envelope = apiCall(t, env.handler, http.MethodGet, "/api/v1/containers?q=postgres", "")
	if status != http.StatusOK {
		t.Fatalf("q 过滤失败: %d", status)
	}
	filtered := decodeData[protocol.ListResult[ContainerSummary]](t, envelope.Data)
	if len(filtered.Items) != 1 || filtered.Items[0].ID != "bbb222" {
		t.Fatalf("q 过滤错误: %#v", filtered.Items)
	}

	status, envelope = apiCall(t, env.handler, http.MethodGet, "/api/v1/containers?cursor=abc", "")
	if status != http.StatusBadRequest || envelope.Error == nil || envelope.Error.Code != protocol.CodeBadRequest {
		t.Fatalf("非法 cursor 应返回 BAD_REQUEST: %d %#v", status, envelope.Error)
	}
	status, envelope = apiCall(t, env.handler, http.MethodGet, "/api/v1/containers?status=bogus", "")
	if status != http.StatusBadRequest {
		t.Fatalf("非法 status 应返回 BAD_REQUEST: %d", status)
	}

	if calls := env.runner.callCount("version"); calls != 1 {
		t.Fatalf("docker 能力探测应缓存，实际调用 %d 次", calls)
	}
}

func TestGetContainerDetail(t *testing.T) {
	env := newTestEnv(t, func(args []string) (agent.Result, error) {
		switch args[0] {
		case "version":
			return agent.Result{}, nil
		case "inspect":
			return agent.Result{Stdout: inspectFixture}, nil
		default:
			return agent.Result{Code: 1, Stderr: "unexpected"}, nil
		}
	})
	status, envelope := apiCall(t, env.handler, http.MethodGet, "/api/v1/containers/abc123", "")
	if status != http.StatusOK {
		t.Fatalf("详情失败: %d %#v", status, envelope.Error)
	}
	detail := decodeData[ContainerDetail](t, envelope.Data)
	if detail.ID != "abc123" || detail.State != "running" || detail.RestartPolicy != "always" {
		t.Fatalf("详情字段错误: %#v", detail)
	}
	if detail.Health == nil || *detail.Health != "healthy" {
		t.Fatalf("health 解析错误: %#v", detail.Health)
	}
	if len(detail.Env) != 2 || len(detail.Mounts) != 1 || detail.Mounts[0].RW != true {
		t.Fatalf("env/mounts 解析错误: %#v %#v", detail.Env, detail.Mounts)
	}
	if len(detail.Ports) != 1 || detail.Ports[0].PublicPort == nil || *detail.Ports[0].PublicPort != 8080 {
		t.Fatalf("端口解析错误: %#v", detail.Ports)
	}
	if detail.ComposeProject == nil || *detail.ComposeProject != "web" {
		t.Fatalf("composeProject 解析错误: %#v", detail.ComposeProject)
	}

	status, envelope = apiCall(t, env.handler, http.MethodGet, "/api/v1/containers/-bad", "")
	if status != http.StatusBadRequest || envelope.Error == nil || envelope.Error.Code != protocol.CodeBadRequest {
		t.Fatalf("非法容器 id 应返回 BAD_REQUEST: %d %#v", status, envelope.Error)
	}
}

func TestExecValidationAndResult(t *testing.T) {
	env := newTestEnv(t, func(args []string) (agent.Result, error) {
		switch args[0] {
		case "version":
			return agent.Result{}, nil
		case "inspect":
			return agent.Result{Stdout: inspectFixture}, nil
		case "exec":
			return agent.Result{Stdout: "hello\n", Stderr: "warn", Code: 3}, nil
		default:
			return agent.Result{Code: 1, Stderr: "unexpected"}, nil
		}
	})

	emptyBody := `{"command":[]}`
	status, envelope := apiCall(t, env.handler, http.MethodPost, "/api/v1/containers/abc123/exec", emptyBody)
	if status != http.StatusBadRequest || envelope.Error == nil || envelope.Error.Code != protocol.CodeBadRequest {
		t.Fatalf("空 command 应返回 BAD_REQUEST: %d %#v", status, envelope.Error)
	}

	manyArgs := make([]string, maxExecArgs+1)
	for i := range manyArgs {
		manyArgs[i] = "x"
	}
	payload, _ := json.Marshal(map[string]any{"command": manyArgs})
	status, envelope = apiCall(t, env.handler, http.MethodPost, "/api/v1/containers/abc123/exec", string(payload))
	if status != http.StatusBadRequest {
		t.Fatalf("过多参数应返回 BAD_REQUEST: %d", status)
	}

	longArg := strings.Repeat("a", maxExecArgBytes+1)
	payload, _ = json.Marshal(map[string]any{"command": []string{"echo", longArg}})
	status, envelope = apiCall(t, env.handler, http.MethodPost, "/api/v1/containers/abc123/exec", string(payload))
	if status != http.StatusBadRequest {
		t.Fatalf("超长参数应返回 BAD_REQUEST: %d", status)
	}

	payload, _ = json.Marshal(map[string]any{"command": []string{"echo", "hi"}, "timeoutMs": 400000})
	status, envelope = apiCall(t, env.handler, http.MethodPost, "/api/v1/containers/abc123/exec", string(payload))
	if status != http.StatusBadRequest {
		t.Fatalf("超时上限应返回 BAD_REQUEST: %d", status)
	}

	payload, _ = json.Marshal(map[string]any{"command": []string{"echo", "hi"}, "workdir": "/tmp\nbad"})
	status, envelope = apiCall(t, env.handler, http.MethodPost, "/api/v1/containers/abc123/exec", string(payload))
	if status != http.StatusBadRequest {
		t.Fatalf("非法 workdir 应返回 BAD_REQUEST: %d", status)
	}

	payload, _ = json.Marshal(map[string]any{"command": []string{"echo", "hi"}, "user": "bad user"})
	status, envelope = apiCall(t, env.handler, http.MethodPost, "/api/v1/containers/abc123/exec", string(payload))
	if status != http.StatusBadRequest {
		t.Fatalf("非法 user 应返回 BAD_REQUEST: %d", status)
	}

	payload, _ = json.Marshal(map[string]any{"command": []string{"echo", "hi"}})
	status, envelope = apiCall(t, env.handler, http.MethodPost, "/api/v1/containers/abc123/exec", string(payload))
	if status != http.StatusOK || !envelope.OK {
		t.Fatalf("exec 失败: %d %#v", status, envelope.Error)
	}
	result := decodeData[ExecResult](t, envelope.Data)
	if result.ExitCode == nil || *result.ExitCode != 3 || result.Stdout != "hello\n" || result.Stderr != "warn" || result.Truncated {
		t.Fatalf("exec 结果错误: %#v", result)
	}
	call := env.runner.findCall("exec")
	want := []string{"exec", "--", "abc123", "echo", "hi"}
	if strings.Join(call, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("exec argv 错误: %#v", call)
	}
}

func TestExecTimeoutReturnsNullExitCode(t *testing.T) {
	env := newTestEnv(t, func(args []string) (agent.Result, error) {
		switch args[0] {
		case "version":
			return agent.Result{}, nil
		case "inspect":
			return agent.Result{Stdout: inspectFixture}, nil
		case "exec":
			return agent.Result{Stdout: "partial"}, errors.New("命令执行超时")
		default:
			return agent.Result{Code: 1, Stderr: "unexpected"}, nil
		}
	})
	payload, _ := json.Marshal(map[string]any{"command": []string{"sleep", "60"}, "timeoutMs": 10})
	status, envelope := apiCall(t, env.handler, http.MethodPost, "/api/v1/containers/abc123/exec", string(payload))
	if status != http.StatusOK {
		t.Fatalf("超时应返回 200 + ExecResult: %d %#v", status, envelope.Error)
	}
	result := decodeData[ExecResult](t, envelope.Data)
	if result.ExitCode != nil || !result.Truncated || result.Stdout != "partial" {
		t.Fatalf("超时结果错误: %#v", result)
	}
}

func TestContainerStatsEndpoint(t *testing.T) {
	env := newTestEnv(t, func(args []string) (agent.Result, error) {
		switch args[0] {
		case "version":
			return agent.Result{}, nil
		case "inspect":
			return agent.Result{Stdout: inspectFixture}, nil
		case "stats":
			return agent.Result{Stdout: `{"CPUPerc":"0.5%","MemUsage":"5MiB / 1GiB","MemPerc":"0.49%","NetIO":"1kB / 2kB","BlockIO":"0B / 0B","PIDs":"3"}`}, nil
		default:
			return agent.Result{Code: 1, Stderr: "unexpected"}, nil
		}
	})
	status, envelope := apiCall(t, env.handler, http.MethodGet, "/api/v1/containers/abc123/stats", "")
	if status != http.StatusOK {
		t.Fatalf("stats 失败: %d %#v", status, envelope.Error)
	}
	result := decodeData[ContainerStatsResult](t, envelope.Data)
	if result.Stats.CPUPercent != 0.5 || result.Stats.MemoryUsageBytes != 5<<20 || result.Stats.PIDs != 3 {
		t.Fatalf("stats 结果错误: %#v", result.Stats)
	}
}

func TestContainerLogsEndpoint(t *testing.T) {
	env := newTestEnv(t, func(args []string) (agent.Result, error) {
		switch args[0] {
		case "version":
			return agent.Result{}, nil
		case "logs":
			return agent.Result{Stdout: "out\n", Stderr: "err\n"}, nil
		default:
			return agent.Result{Code: 1, Stderr: "unexpected"}, nil
		}
	})
	status, envelope := apiCall(t, env.handler, http.MethodGet, "/api/v1/containers/abc123/logs?tail=10", "")
	if status != http.StatusOK {
		t.Fatalf("logs 失败: %d %#v", status, envelope.Error)
	}
	result := decodeData[ContainerLogsResult](t, envelope.Data)
	if result.Logs != "out\nerr\n" || result.Truncated {
		t.Fatalf("logs 结果错误: %#v", result)
	}
	status, envelope = apiCall(t, env.handler, http.MethodGet, "/api/v1/containers/abc123/logs?stdout=0", "")
	if status != http.StatusOK {
		t.Fatalf("logs 过滤失败: %d", status)
	}
	onlyStderr := decodeData[ContainerLogsResult](t, envelope.Data)
	if onlyStderr.Logs != "err\n" {
		t.Fatalf("stdout=0 应只返回 stderr: %#v", onlyStderr)
	}
	status, envelope = apiCall(t, env.handler, http.MethodGet, "/api/v1/containers/abc123/logs?stdout=0&stderr=0", "")
	if status != http.StatusOK {
		t.Fatalf("双流关闭失败: %d", status)
	}
	empty := decodeData[ContainerLogsResult](t, envelope.Data)
	if empty.Logs != "" {
		t.Fatalf("双流关闭应返回空日志: %#v", empty)
	}
}

func TestDockerUnavailableDegradesListsAndWrites(t *testing.T) {
	env := newTestEnv(t, func(args []string) (agent.Result, error) {
		if args[0] == "version" {
			return agent.Result{Code: 1, Stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock"}, nil
		}
		return agent.Result{Code: 1, Stderr: "should not run"}, nil
	})

	for _, path := range []string{"/api/v1/containers", "/api/v1/images", "/api/v1/stacks"} {
		status, envelope := apiCall(t, env.handler, http.MethodGet, path, "")
		if status != http.StatusOK || !envelope.OK {
			t.Fatalf("%s 应返回 200 降级列表: %d %#v", path, status, envelope.Error)
		}
		var list struct {
			Available bool              `json:"available"`
			Reason    string            `json:"reason"`
			Items     []json.RawMessage `json:"items"`
		}
		if err := json.Unmarshal(envelope.Data, &list); err != nil {
			t.Fatalf("%s data 解析失败: %v", path, err)
		}
		if list.Available || list.Reason == "" || len(list.Items) != 0 {
			t.Fatalf("%s 降级形状错误: %#v", path, list)
		}
	}

	writeCalls := []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodPost, "/api/v1/containers/abc/start", ""},
		{http.MethodGet, "/api/v1/containers/abc", ""},
		{http.MethodPost, "/api/v1/images/pull", `{"reference":"nginx"}`},
		{http.MethodPost, "/api/v1/stacks", `{"name":"web","composeYaml":"services: {}"}`},
	}
	for _, call := range writeCalls {
		status, envelope := apiCall(t, env.handler, call.method, call.path, call.body)
		if status != http.StatusServiceUnavailable {
			t.Fatalf("%s %s 应返回 503: %d", call.method, call.path, status)
		}
		if envelope.Error == nil || envelope.Error.Code != protocol.CodeUnavailable {
			t.Fatalf("%s %s 错误码错误: %#v", call.method, call.path, envelope.Error)
		}
		if hint, _ := envelope.Error.Details["hint"].(string); hint == "" {
			t.Fatalf("%s %s UNAVAILABLE 必须带 details.hint: %#v", call.method, call.path, envelope.Error)
		}
	}
}

func TestImagesEndpoints(t *testing.T) {
	env := newTestEnv(t, func(args []string) (agent.Result, error) {
		switch {
		case args[0] == "version":
			return agent.Result{}, nil
		case args[0] == "images":
			return agent.Result{Stdout: `{"ID":"sha256:aaa","Repository":"nginx","Tag":"latest","Digest":"sha256:111","CreatedAt":"2024-01-03 04:05:06 +0000 UTC","Size":"187MB"}`}, nil
		case args[0] == "pull":
			return agent.Result{Stdout: "pulled"}, nil
		case args[0] == "image" && len(args) > 1 && args[1] == "inspect":
			return agent.Result{Stdout: imageInspectFixture}, nil
		case args[0] == "rmi":
			return agent.Result{Code: 1, Stderr: "Error response from daemon: No such image: nginx:missing"}, nil
		case args[0] == "image" && len(args) > 1 && args[1] == "prune":
			return agent.Result{Stdout: "Deleted Images:\ndeleted: sha256:one\ndeleted: sha256:two\n\nTotal reclaimed space: 1.5GB\n"}, nil
		default:
			return agent.Result{Code: 1, Stderr: "unexpected"}, nil
		}
	})

	status, envelope := apiCall(t, env.handler, http.MethodGet, "/api/v1/images?q=nginx", "")
	if status != http.StatusOK {
		t.Fatalf("镜像列表失败: %d %#v", status, envelope.Error)
	}
	list := decodeData[protocol.ListResult[ImageSummary]](t, envelope.Data)
	if !list.Available || len(list.Items) != 1 || list.Items[0].ID != "sha256:aaa" {
		t.Fatalf("镜像列表错误: %#v", list)
	}

	status, envelope = apiCall(t, env.handler, http.MethodPost, "/api/v1/images/pull", `{"reference":"nginx:latest"}`)
	if status != http.StatusOK {
		t.Fatalf("pull 失败: %d %#v", status, envelope.Error)
	}
	pulled := decodeData[ImagePullResult](t, envelope.Data)
	if pulled.Image.ID != "sha256:aaa" || len(pulled.Image.RepoTags) != 1 || pulled.Image.Labels["maintainer"] != "nginx" {
		t.Fatalf("pull 结果错误: %#v", pulled.Image)
	}

	status, envelope = apiCall(t, env.handler, http.MethodDelete, "/api/v1/images/nginx:missing", "")
	if status != http.StatusNotFound || envelope.Error == nil || envelope.Error.Code != protocol.CodeNotFound {
		t.Fatalf("rmi 不存在应返回 NOT_FOUND: %d %#v", status, envelope.Error)
	}

	status, envelope = apiCall(t, env.handler, http.MethodPost, "/api/v1/images/prune", `{"danglingOnly":false}`)
	if status != http.StatusOK {
		t.Fatalf("prune 失败: %d %#v", status, envelope.Error)
	}
	pruned := decodeData[ImagePruneResult](t, envelope.Data)
	if pruned.Deleted != 2 || pruned.ReclaimedBytes != 1500000000 {
		t.Fatalf("prune 结果错误: %#v", pruned)
	}
}

func TestStackPathSandbox(t *testing.T) {
	manager := newStackManager(t.TempDir())
	if _, pErr := manager.resolve("../etc"); pErr == nil || pErr.Code != protocol.CodeBadRequest {
		t.Fatalf("路径穿越应返回 BAD_REQUEST: %#v", pErr)
	}
	if _, pErr := manager.resolve("UPPER"); pErr == nil {
		t.Fatal("大写名称应被拒绝")
	}
	paths, pErr := manager.resolve("web")
	if pErr != nil {
		t.Fatalf("合法名称解析失败: %v", pErr)
	}
	if paths.DirExists || paths.Exists {
		t.Fatalf("新编排不应已存在: %#v", paths)
	}
	if err := os.MkdirAll(paths.Dir, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.ComposePath, []byte("services: {}\n"), 0o640); err != nil {
		t.Fatal(err)
	}
	paths, pErr = manager.resolve("web")
	if pErr != nil || !paths.DirExists || !paths.Exists {
		t.Fatalf("已存在编排解析错误: %#v %v", paths, pErr)
	}
	root, err := manager.realRoot()
	if err != nil {
		t.Fatal(err)
	}
	if !pathWithin(root, paths.ComposePath) {
		t.Fatalf("compose 路径越界: %q 不在 %q 内", paths.ComposePath, root)
	}

	outside := t.TempDir()
	link := filepath.Join(root, "escape")
	if err := os.Symlink(outside, link); err != nil {
		t.Logf("跳过符号链接测试：%v", err)
		return
	}
	if _, pErr := manager.resolve("escape"); pErr == nil || pErr.Code != protocol.CodeBadRequest {
		t.Fatalf("符号链接目录应被拒绝: %#v", pErr)
	}
}

func TestStackCreateUpdateListLogsDelete(t *testing.T) {
	env := newTestEnv(t, func(args []string) (agent.Result, error) {
		switch {
		case args[0] == "version":
			return agent.Result{}, nil
		case args[0] == "compose":
			return agent.Result{Stdout: "services: {}\n"}, nil
		case args[0] == "ps":
			return agent.Result{Stdout: stackPSFixture}, nil
		case args[0] == "logs":
			return agent.Result{Stdout: "hello\nworld\n"}, nil
		default:
			return agent.Result{Code: 1, Stderr: "unexpected"}, nil
		}
	})

	yaml := "services:\n  app:\n    image: nginx\n"
	payload, _ := json.Marshal(map[string]string{"name": "web", "composeYaml": yaml})
	status, envelope := apiCall(t, env.handler, http.MethodPost, "/api/v1/stacks", string(payload))
	if status != http.StatusCreated {
		t.Fatalf("创建编排失败: %d %#v", status, envelope.Error)
	}
	created := decodeData[StackDetail](t, envelope.Data)
	if created.Name != "web" || created.ComposeYAML != yaml || !strings.HasSuffix(filepath.ToSlash(created.ComposePath), "/stacks/web/compose.yaml") {
		t.Fatalf("创建结果错误: %#v", created)
	}
	if created.ContainerCount != 1 || created.RunningCount != 1 || created.Status != "running" || len(created.Containers) != 1 {
		t.Fatalf("创建后聚合错误: %#v", created.StackSummary)
	}
	onDisk, err := os.ReadFile(created.ComposePath)
	if err != nil || string(onDisk) != yaml {
		t.Fatalf("compose 文件未落盘: %v %q", err, string(onDisk))
	}

	status, envelope = apiCall(t, env.handler, http.MethodGet, "/api/v1/stacks", "")
	if status != http.StatusOK {
		t.Fatalf("编排列表失败: %d", status)
	}
	list := decodeData[protocol.ListResult[StackSummary]](t, envelope.Data)
	if !list.Available || len(list.Items) != 1 || list.Items[0].Name != "web" {
		t.Fatalf("编排列表错误: %#v", list)
	}
	if len(list.Items[0].ConfigFiles) != 1 || !strings.HasSuffix(filepath.ToSlash(list.Items[0].ConfigFiles[0]), "/stacks/web/compose.yaml") {
		t.Fatalf("configFiles 错误: %#v", list.Items[0].ConfigFiles)
	}

	status, envelope = apiCall(t, env.handler, http.MethodGet, "/api/v1/stacks/web", "")
	if status != http.StatusOK {
		t.Fatalf("编排详情失败: %d", status)
	}
	detail := decodeData[StackDetail](t, envelope.Data)
	if detail.ComposeYAML != yaml || detail.ComposePath != created.ComposePath {
		t.Fatalf("编排详情错误: %#v", detail)
	}

	status, envelope = apiCall(t, env.handler, http.MethodGet, "/api/v1/stacks/web/compose", "")
	if status != http.StatusOK {
		t.Fatalf("compose 文件 GET 失败: %d", status)
	}

	updatedYAML := "services:\n  app:\n    image: nginx:1.25\n"
	payload, _ = json.Marshal(map[string]string{"composeYaml": updatedYAML})
	status, envelope = apiCall(t, env.handler, http.MethodPut, "/api/v1/stacks/web", string(payload))
	if status != http.StatusOK {
		t.Fatalf("更新编排失败: %d %#v", status, envelope.Error)
	}
	updated := decodeData[StackDetail](t, envelope.Data)
	if updated.ComposeYAML != updatedYAML {
		t.Fatalf("更新结果错误: %#v", updated)
	}
	onDisk, err = os.ReadFile(created.ComposePath)
	if err != nil || string(onDisk) != updatedYAML {
		t.Fatalf("更新未落盘: %v %q", err, string(onDisk))
	}

	status, envelope = apiCall(t, env.handler, http.MethodGet, "/api/v1/stacks/web/logs?tail=5", "")
	if status != http.StatusOK {
		t.Fatalf("编排日志失败: %d %#v", status, envelope.Error)
	}
	logs := decodeData[ContainerLogsResult](t, envelope.Data)
	if !strings.Contains(logs.Logs, "[app] hello") || !strings.Contains(logs.Logs, "[app] world") {
		t.Fatalf("编排日志聚合错误: %q", logs.Logs)
	}

	status, envelope = apiCall(t, env.handler, http.MethodDelete, "/api/v1/stacks/web", "")
	if status != http.StatusConflict || envelope.Error == nil || envelope.Error.Code != protocol.CodeConflict {
		t.Fatalf("运行中的编排删除应返回 CONFLICT: %d %#v", status, envelope.Error)
	}
	status, envelope = apiCall(t, env.handler, http.MethodDelete, "/api/v1/stacks/web?force=true", "")
	if status != http.StatusOK {
		t.Fatalf("force 删除失败: %d %#v", status, envelope.Error)
	}
	removed := decodeData[stackRemoveResult](t, envelope.Data)
	if !removed.Deleted || removed.Name != "web" {
		t.Fatalf("删除结果错误: %#v", removed)
	}
	if _, err := os.Stat(created.ComposePath); !os.IsNotExist(err) {
		t.Fatalf("compose 文件应被删除: %v", err)
	}
}

func TestStackCreateRejectsInvalidComposeAndCleansUp(t *testing.T) {
	env := newTestEnv(t, func(args []string) (agent.Result, error) {
		switch args[0] {
		case "version":
			return agent.Result{}, nil
		case "compose":
			return agent.Result{Code: 1, Stderr: "yaml: line 1: did not find expected key"}, nil
		default:
			return agent.Result{Code: 1, Stderr: "unexpected"}, nil
		}
	})
	payload, _ := json.Marshal(map[string]string{"name": "broken", "composeYaml": "services: ["})
	status, envelope := apiCall(t, env.handler, http.MethodPost, "/api/v1/stacks", string(payload))
	if status != http.StatusBadRequest || envelope.Error == nil || envelope.Error.Code != protocol.CodeBadRequest {
		t.Fatalf("非法 compose 应返回 BAD_REQUEST: %d %#v", status, envelope.Error)
	}
	if output, _ := envelope.Error.Details["output"].(string); !strings.Contains(output, "yaml") {
		t.Fatalf("校验失败应返回 output: %#v", envelope.Error.Details)
	}
	if _, err := os.Stat(filepath.Join(env.dataDir, "stacks", "broken")); !os.IsNotExist(err) {
		t.Fatalf("校验失败后应清理空目录: %v", err)
	}
}

func TestContainerStopExplicitZeroTimeout(t *testing.T) {
	env := newTestEnv(t, func(args []string) (agent.Result, error) {
		switch args[0] {
		case "version":
			return agent.Result{}, nil
		case "stop":
			return agent.Result{}, nil
		default:
			return agent.Result{Code: 1, Stderr: "unexpected"}, nil
		}
	})
	status, envelope := apiCall(t, env.handler, http.MethodPost, "/api/v1/containers/abc123/stop", `{"timeoutSec":0}`)
	if status != http.StatusOK {
		t.Fatalf("stop 失败: %d %#v", status, envelope.Error)
	}
	call := env.runner.findCall("stop")
	want := []string{"stop", "--time", "0", "abc123"}
	if strings.Join(call, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("timeoutSec=0 应显式传 --time 0，实际 %#v", call)
	}
}

func TestStackActionArgs(t *testing.T) {
	env := newTestEnv(t, func(args []string) (agent.Result, error) {
		switch args[0] {
		case "version":
			return agent.Result{}, nil
		case "compose":
			return agent.Result{Stdout: "ok"}, nil
		case "ps":
			return agent.Result{Stdout: ""}, nil
		default:
			return agent.Result{Code: 1, Stderr: "unexpected"}, nil
		}
	})
	paths, pErr := env.module.stacks.resolve("web")
	if pErr != nil {
		t.Fatal(pErr)
	}
	if err := os.MkdirAll(paths.Dir, 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.ComposePath, []byte("services: {}\n"), 0o640); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		action string
		body   string
		want   []string
	}{
		{"up", `{"build":true,"forceRecreate":true}`, []string{"up", "-d", "--build", "--force-recreate"}},
		{"down", `{"removeVolumes":true,"removeImages":true}`, []string{"down", "--volumes", "--rmi", "all"}},
		{"restart", `{}`, []string{"restart"}},
		{"pull", `{}`, []string{"pull"}},
	}
	for _, testCase := range cases {
		status, envelope := apiCall(t, env.handler, http.MethodPost,
			"/api/v1/stacks/web/"+testCase.action, testCase.body)
		if status != http.StatusOK {
			t.Fatalf("%s 失败: %d %#v", testCase.action, status, envelope.Error)
		}
		result := decodeData[stackActionResult](t, envelope.Data)
		if !result.OK {
			t.Fatalf("%s 结果错误: %#v", testCase.action, result)
		}
		call := env.runner.lastCall("compose")
		joined := strings.Join(call, "\x00")
		for _, fragment := range testCase.want {
			if !strings.Contains(joined, fragment) {
				t.Fatalf("%s argv 缺少 %q: %#v", testCase.action, fragment, call)
			}
		}
	}
}

func TestComposePluginMissingDegradesToUnavailable(t *testing.T) {
	env := newTestEnv(t, func(args []string) (agent.Result, error) {
		switch args[0] {
		case "version":
			return agent.Result{}, nil
		case "compose":
			return agent.Result{Code: 1, Stderr: "docker: 'compose' is not a docker command.\nSee 'docker --help'"}, nil
		default:
			return agent.Result{Code: 1, Stderr: "unexpected"}, nil
		}
	})
	yaml := "services:\n  app:\n    image: nginx\n"
	payload, _ := json.Marshal(map[string]string{"name": "web", "composeYaml": yaml})
	status, envelope := apiCall(t, env.handler, http.MethodPost, "/api/v1/stacks", string(payload))
	if status != http.StatusServiceUnavailable || envelope.Error == nil || envelope.Error.Code != protocol.CodeUnavailable {
		t.Fatalf("缺少 compose 插件应返回 UNAVAILABLE: %d %#v", status, envelope.Error)
	}
	if hint, _ := envelope.Error.Details["hint"].(string); !strings.Contains(hint, "Compose") {
		t.Fatalf("缺少 compose 插件应返回安装提示: %#v", envelope.Error.Details)
	}
}

type blockingStreamRunner struct {
	started  chan struct{}
	canceled chan struct{}
}

func (r *blockingStreamRunner) Run(ctx context.Context, name string, args ...string) (agent.Result, error) {
	return r.RunTimeout(ctx, 0, name, args...)
}

func (r *blockingStreamRunner) RunTimeout(_ context.Context, _ time.Duration, _ string, args ...string) (agent.Result, error) {
	if len(args) > 0 && args[0] == "version" {
		return agent.Result{}, nil
	}
	return agent.Result{Code: 1}, nil
}

func (r *blockingStreamRunner) Stream(ctx context.Context, _ string, _ []string, _ func(string)) (agent.Result, error) {
	select {
	case <-r.started:
	default:
		close(r.started)
	}
	<-ctx.Done()
	select {
	case <-r.canceled:
	default:
		close(r.canceled)
	}
	return agent.Result{}, nil
}

type fakeWSConn struct {
	mu        sync.Mutex
	writes    [][]byte
	readCh    chan []byte
	closed    chan struct{}
	closeOnce sync.Once
}

func newFakeWSConn() *fakeWSConn {
	return &fakeWSConn{readCh: make(chan []byte, 4), closed: make(chan struct{})}
}

func (c *fakeWSConn) ReadMessage() (int, []byte, error) {
	select {
	case <-c.closed:
		return 0, nil, io.EOF
	case message := <-c.readCh:
		return protocol.TextMessage, message, nil
	}
}

func (c *fakeWSConn) WriteMessage(_ int, data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.writes = append(c.writes, append([]byte{}, data...))
	return nil
}

func (c *fakeWSConn) Close() error {
	c.closeOnce.Do(func() { close(c.closed) })
	return nil
}

func TestWSLogsFollowCanceledOnClientClose(t *testing.T) {
	runner := &blockingStreamRunner{started: make(chan struct{}), canceled: make(chan struct{})}
	cfg := &config.Agent{Agent: config.AgentSystem{DockerBin: "docker", DataDir: t.TempDir()}}
	ctx := &agent.Context{
		Mux:    http.NewServeMux(),
		WS:     agent.NewWSRegistry(),
		Cfg:    cfg,
		Runner: runner,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	module := New()
	if err := module.Register(ctx); err != nil {
		t.Fatalf("Register: %v", err)
	}
	conn := newFakeWSConn()
	request := httptest.NewRequest(http.MethodGet, "/ws/containers/abc123/logs?tail=5&follow=1", nil)
	done := make(chan struct{})
	go func() {
		module.handleContainerLogsWS(conn, request)
		close(done)
	}()

	select {
	case <-runner.started:
	case <-time.After(3 * time.Second):
		t.Fatal("日志流未启动")
	}
	conn.readCh <- []byte(`{"type":"close"}`)

	select {
	case <-runner.canceled:
	case <-time.After(3 * time.Second):
		t.Fatal("客户端 close 后 docker 日志子进程未被取消")
	}
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("WS 处理函数未退出")
	}
}

func TestStackActionRequiresLocalCompose(t *testing.T) {
	env := newTestEnv(t, dockerVersionOnly)
	status, envelope := apiCall(t, env.handler, http.MethodPost, "/api/v1/stacks/missing/up", `{}`)
	if status != http.StatusNotFound || envelope.Error == nil || envelope.Error.Code != protocol.CodeNotFound {
		t.Fatalf("不存在的编排应返回 NOT_FOUND: %d %#v", status, envelope.Error)
	}
	status, envelope = apiCall(t, env.handler, http.MethodPost, "/api/v1/stacks/Bad_Name/up", `{}`)
	if status != http.StatusBadRequest {
		t.Fatalf("非法名称应返回 BAD_REQUEST: %d", status)
	}
}

func TestUnavailableListShapeForImagesAndStacks(t *testing.T) {
	env := newTestEnv(t, func(args []string) (agent.Result, error) {
		return agent.Result{}, errors.New(`exec: "docker": executable file not found in $PATH`)
	})
	for _, path := range []string{"/api/v1/images", "/api/v1/stacks", "/api/v1/containers"} {
		status, envelope := apiCall(t, env.handler, http.MethodGet, path, "")
		if status != http.StatusOK {
			t.Fatalf("%s 应返回 200: %d", path, status)
		}
		var list struct {
			Available bool   `json:"available"`
			Reason    string `json:"reason"`
		}
		if err := json.Unmarshal(envelope.Data, &list); err != nil {
			t.Fatal(err)
		}
		if list.Available || !strings.Contains(list.Reason, "docker") {
			t.Fatalf("%s 不可用原因错误: %#v", path, list)
		}
	}
}

func asyncCall(t *testing.T, env *testEnv, method, path, body string) (int, testEnvelope) {
	t.Helper()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Prefer", "respond-async")
	recorder := httptest.NewRecorder()
	env.handler.ServeHTTP(recorder, request)
	var envelope testEnvelope
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("response is not envelope JSON: %v\n%s", err, recorder.Body.String())
	}
	return recorder.Code, envelope
}

func waitContainerJob(t *testing.T, env *testEnv, id string) protocol.Job {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		job, ok := env.module.ctx.Jobs.Get(id)
		if !ok {
			t.Fatalf("job %s missing", id)
		}
		if job.Status == protocol.JobStatusSucceeded || job.Status == protocol.JobStatusFailed || job.Status == protocol.JobStatusCancelled {
			return job
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("job %s did not finish", id)
	return protocol.Job{}
}

func TestAsyncImagePullAndStackUp(t *testing.T) {
	env := newTestEnv(t, func(args []string) (agent.Result, error) {
		if len(args) > 0 && args[0] == "pull" {
			return agent.Result{Stdout: "pulled nginx:latest"}, nil
		}
		return agent.Result{}, nil
	})

	status, envelope := asyncCall(t, env, http.MethodPost, "/api/v1/images/pull", `{"reference":"nginx:latest"}`)
	if status != http.StatusAccepted {
		t.Fatalf("async image pull status = %d: %s", status, string(envelope.Data))
	}
	var started struct {
		Job protocol.Job `json:"job"`
	}
	if err := json.Unmarshal(envelope.Data, &started); err != nil {
		t.Fatal(err)
	}
	job := waitContainerJob(t, env, started.Job.ID)
	if job.Status != protocol.JobStatusSucceeded {
		t.Fatalf("image pull job = %+v", job)
	}

	stackDir := filepath.Join(env.dataDir, "stacks", "demo")
	if err := os.MkdirAll(stackDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stackDir, "compose.yaml"), []byte("services:\n  app:\n    image: nginx:latest\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	status, envelope = asyncCall(t, env, http.MethodPost, "/api/v1/stacks/demo/up", `{}`)
	if status != http.StatusAccepted {
		t.Fatalf("async stack up status = %d: %s", status, string(envelope.Data))
	}
	if err := json.Unmarshal(envelope.Data, &started); err != nil {
		t.Fatal(err)
	}
	job = waitContainerJob(t, env, started.Job.ID)
	if job.Status != protocol.JobStatusSucceeded {
		t.Fatalf("stack up job = %+v", job)
	}
}
