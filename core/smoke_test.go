package core

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/sakana-1314/mpanel/core/config"
)

type smokeClient struct {
	t      *testing.T
	base   string
	client *http.Client
}

func (c *smokeClient) do(method, path string, body any, out any) int {
	c.t.Helper()
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			c.t.Fatalf("marshal body: %v", err)
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequest(method, c.base+path, reader)
	if err != nil {
		c.t.Fatalf("new request: %v", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.client.Do(req)
	if err != nil {
		c.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if out != nil && len(data) > 0 {
		if err := json.Unmarshal(data, out); err != nil {
			c.t.Fatalf("%s %s decode: %v (%s)", method, path, err, string(data[:min(len(data), 300)]))
		}
	}
	return resp.StatusCode
}

type envelope[T any] struct {
	OK    bool `json:"ok"`
	Data  T    `json:"data"`
	Error *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func (c *smokeClient) ok(method, path string, body any, out any) {
	c.t.Helper()
	status := c.do(method, path, body, out)
	if status < 200 || status >= 300 {
		c.t.Fatalf("%s %s: status %d", method, path, status)
	}
}

func (c *smokeClient) waitFor(what string, timeout time.Duration, condition func() bool) {
	c.t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(150 * time.Millisecond)
	}
	c.t.Fatalf("timeout waiting for %s", what)
}

func repoRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	return filepath.Dir(filepath.Dir(file))
}

func freePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port
}

// TestSmoke boots a real core plus real agent binaries and exercises login,
// machine registration over http and reverse-ws, the proxy, edge enrollment and
// one queued edge job.
func TestSmoke(t *testing.T) {
	if testing.Short() {
		t.Skip("smoke test skipped in -short mode")
	}
	if runtime.GOOS == "windows" && os.Getenv("MPANEL_SMOKE") == "" {
		// Windows is supported; set MPANEL_SMOKE=1 to run it there as well.
	}
	root := repoRoot(t)
	binDir := t.TempDir()
	agentBin := filepath.Join(binDir, "mpanel-agent")
	if runtime.GOOS == "windows" {
		agentBin += ".exe"
	}
	build := exec.Command("go", "build", "-o", agentBin, "./cmd/mpanel-agent")
	build.Dir = root
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build agent: %v\n%s", err, output)
	}

	baseDir := t.TempDir()
	webDir := filepath.Join(baseDir, "web")
	if err := os.MkdirAll(webDir, 0o755); err != nil {
		t.Fatalf("mkdir web: %v", err)
	}
	if err := os.WriteFile(filepath.Join(webDir, "index.html"), []byte("<!doctype html><title>MPanel smoke</title>"), 0o644); err != nil {
		t.Fatalf("write index: %v", err)
	}
	cfg := config.NewApp(baseDir)
	cfg.System.WebDir = webDir
	cfg.System.Secret = "smoke-test-secret"
	cfg.System.Port = 8790
	app, err := New(cfg, nil)
	if err != nil {
		t.Fatalf("core.New: %v", err)
	}
	defer app.Close()

	server := httptest.NewServer(app.Handler())
	defer server.Close()
	oldPublic := os.Getenv("MPANEL_PUBLIC_URL")
	os.Setenv("MPANEL_PUBLIC_URL", server.URL)
	defer os.Setenv("MPANEL_PUBLIC_URL", oldPublic)

	jar, _ := cookiejar.New(nil)
	client := &smokeClient{t: t, base: server.URL, client: &http.Client{Jar: jar, Timeout: 60 * time.Second}}

	bootstrap, ok := app.Auth().BootstrapToken()
	if !ok {
		t.Fatal("bootstrap token missing")
	}
	// The SPA must be public: index, deep link fallback and runtime config.
	for _, path := range []string{"/", "/edge"} {
		resp, err := http.Get(server.URL + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != 200 || !strings.Contains(string(body), "MPanel smoke") {
			t.Fatalf("static %s = %d %q", path, resp.StatusCode, string(body[:min(len(body), 80)]))
		}
	}
	resp, err := http.Get(server.URL + "/config.json")
	if err != nil {
		t.Fatalf("GET config.json: %v", err)
	}
	var runtimeConfig map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&runtimeConfig)
	resp.Body.Close()
	if runtimeConfig["appName"] != "MPanel" {
		t.Fatalf("runtime config = %#v", runtimeConfig)
	}

	var setup envelope[map[string]any]
	client.ok(http.MethodPost, "/api/v1/auth/setup", map[string]any{
		"bootstrapToken": bootstrap,
		"username":       "admin",
		"password":       "smoke-password-123",
	}, &setup)
	if !setup.OK {
		t.Fatal("setup failed")
	}
	var me envelope[map[string]any]
	client.ok(http.MethodGet, "/api/v1/auth/me", nil, &me)
	if me.Data["role"] != "core" {
		t.Fatalf("me.role = %v", me.Data["role"])
	}

	// ---- http machine ----
	httpPort := freePort(t)
	httpAgentHome := filepath.Join(baseDir, "agent-http")
	httpAgent := startAgent(t, agentBin, httpAgentHome, []string{
		"MPANEL_AGENT_TRANSPORT=http",
		fmt.Sprintf("MPANEL_AGENT_LISTEN=127.0.0.1:%d", httpPort),
		"MPANEL_AGENT_TOKEN=http-agent-token",
	})
	defer httpAgent.stop()
	waitHTTP(t, fmt.Sprintf("http://127.0.0.1:%d/healthz", httpPort), 15*time.Second)

	var created envelope[struct {
		Machine protocolMachine `json:"machine"`
	}]
	client.ok(http.MethodPost, "/api/v1/machines", map[string]any{
		"name":      "本机 http",
		"transport": "http",
		"url":       fmt.Sprintf("http://127.0.0.1:%d", httpPort),
		"token":     "http-agent-token",
	}, &created)
	httpID := created.Data.Machine.ID
	if httpID == "" {
		t.Fatal("machine id empty")
	}
	client.waitFor("http machine online", 20*time.Second, func() bool {
		var machine envelope[protocolMachine]
		client.do(http.MethodGet, "/api/v1/machines/"+httpID, nil, &machine)
		return machine.Data.Status == "online"
	})
	var proxied envelope[map[string]any]
	client.ok(http.MethodGet, "/api/v1/machines/"+httpID+"/proxy/system/info", nil, &proxied)
	if proxied.Data["role"] != "worker" {
		t.Fatalf("proxy role = %v", proxied.Data["role"])
	}

	// ---- feature modules through the core proxy ----
	proxy := func(path string) string { return "/api/v1/machines/" + httpID + "/proxy" + path }

	var roots envelope[struct {
		Items []struct {
			Name string `json:"name"`
		} `json:"items"`
	}]
	client.ok(http.MethodGet, proxy("/files/roots"), nil, &roots)
	if len(roots.Data.Items) == 0 {
		t.Fatal("files roots empty")
	}
	rootName := roots.Data.Items[0].Name
	client.ok(http.MethodPost, proxy("/files/mkdir"), map[string]any{"root": rootName, "path": "smoke"}, nil)
	client.ok(http.MethodPut, proxy("/files/write"), map[string]any{
		"root": rootName, "path": "smoke/hello.txt", "content": "hello mpanel",
	}, nil)
	var read envelope[struct {
		Content string `json:"content"`
	}]
	client.ok(http.MethodGet, proxy("/files/read?root="+rootName+"&path=smoke/hello.txt"), nil, &read)
	if read.Data.Content != "hello mpanel" {
		t.Fatalf("file content = %q", read.Data.Content)
	}
	client.ok(http.MethodDelete, proxy("/files?root="+rootName+"&path=smoke"), nil, nil)

	var site envelope[struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}]
	client.ok(http.MethodPost, proxy("/sites"), map[string]any{
		"name": "smoke-site",
		"config": map[string]any{
			"domains": []string{"smoke.example.test"},
			"handler": map[string]any{"type": "reverse_proxy", "upstreams": []string{"127.0.0.1:4321"}},
		},
	}, &site)
	var preview envelope[struct {
		Caddyfile string `json:"caddyfile"`
	}]
	client.ok(http.MethodPost, proxy("/sites/"+site.Data.ID+"/preview"), map[string]any{}, &preview)
	if !strings.Contains(preview.Data.Caddyfile, "smoke.example.test") {
		t.Fatalf("preview missing domain: %q", preview.Data.Caddyfile)
	}
	var applyErr envelope[map[string]any]
	status := client.do(http.MethodPost, proxy("/sites/apply"), map[string]any{"siteIds": []string{site.Data.ID}}, &applyErr)
	if status != 503 || applyErr.Error == nil || applyErr.Error.Code != "UNAVAILABLE" {
		t.Fatalf("apply without caddy = %d %#v", status, applyErr.Error)
	}

	var task envelope[struct {
		ID string `json:"id"`
	}]
	client.ok(http.MethodPost, proxy("/tasks"), map[string]any{
		"name": "smoke-task", "cron": "*/5 * * * *", "command": "echo smoke",
	}, &task)
	var run envelope[struct {
		Run struct {
			ID string `json:"id"`
		} `json:"run"`
	}]
	client.ok(http.MethodPost, proxy("/tasks/"+task.Data.ID+"/run"), map[string]any{}, &run)
	if run.Data.Run.ID == "" {
		t.Fatal("task run id empty")
	}

	var containers envelope[struct {
		Available bool   `json:"available"`
		Reason    string `json:"reason"`
		Items     []any  `json:"items"`
	}]
	client.ok(http.MethodGet, proxy("/containers"), nil, &containers)
	// CI runners ship Docker, developer machines usually do not: both must
	// produce a valid list result rather than an error.
	if containers.Data.Available && containers.Data.Items == nil {
		t.Fatal("containers available but items missing")
	}
	if !containers.Data.Available && containers.Data.Reason == "" {
		t.Fatal("containers unavailable without a reason")
	}

	var profile envelope[struct {
		ID       string `json:"id"`
		Password string `json:"password"`
	}]
	client.ok(http.MethodPost, proxy("/databases/profiles"), map[string]any{
		"name": "smoke-pg", "kind": "postgres", "host": "127.0.0.1", "port": 5432,
		"username": "postgres", "password": "secret-value", "database": "postgres",
	}, &profile)
	if profile.Data.Password == "secret-value" {
		t.Fatal("profile list leaked the password")
	}

	// ---- edge: key -> reverse-ws agent enrollment ----
	var keyResult envelope[struct {
		Key struct {
			ID string `json:"id"`
		} `json:"key"`
		Secret string `json:"secret"`
	}]
	client.ok(http.MethodPost, "/api/v1/edge/keys", map[string]any{"name": "smoke-edge"}, &keyResult)
	if keyResult.Data.Secret == "" {
		t.Fatal("edge key secret empty")
	}
	edgeHome := filepath.Join(baseDir, "agent-edge")
	edgeAgent := startAgent(t, agentBin, edgeHome, []string{
		"MPANEL_AGENT_TRANSPORT=reverse-ws",
		"MPANEL_CORE_URL=" + server.URL,
		"MPANEL_EDGE_KEY=" + keyResult.Data.Secret,
	})
	defer edgeAgent.stop()

	var edgeID string
	client.waitFor("edge machine online", 30*time.Second, func() bool {
		var list envelope[struct {
			Items []protocolMachine `json:"items"`
		}]
		client.do(http.MethodGet, "/api/v1/machines?transport=reverse-ws", nil, &list)
		for _, machine := range list.Data.Items {
			if machine.Edge && machine.Status == "online" {
				edgeID = machine.ID
				return true
			}
		}
		return false
	})

	var snapshot envelope[map[string]any]
	client.ok(http.MethodGet, "/api/v1/machines/"+edgeID+"/proxy/system/snapshot", nil, &snapshot)
	if snapshot.Data["hostname"] == "" || snapshot.Data["platform"] == "" {
		t.Fatalf("snapshot missing fields: %#v", snapshot.Data)
	}

	var job envelope[struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}]
	client.ok(http.MethodPost, "/api/v1/edge/jobs", map[string]any{
		"machineId": edgeID,
		"kind":      "snapshot",
	}, &job)
	if job.Data.ID == "" {
		t.Fatal("edge job id empty")
	}
	client.waitFor("edge job succeeded", 40*time.Second, func() bool {
		var current envelope[struct {
			Status string `json:"status"`
			Result any    `json:"result"`
		}]
		client.do(http.MethodGet, "/api/v1/edge/jobs/"+job.Data.ID, nil, &current)
		return current.Data.Status == "succeeded"
	})

	var audit envelope[struct {
		Items []AuditEntry `json:"items"`
	}]
	client.ok(http.MethodGet, "/api/v1/system/audit?limit=200", nil, &audit)
	actions := map[string]bool{}
	for _, entry := range audit.Data.Items {
		actions[entry.Action] = true
	}
	for _, want := range []string{"auth.setup", "machine.create", "edge.key.create", "edge.enroll", "edge.job.create"} {
		if !actions[want] {
			t.Fatalf("audit missing %s (have %v)", want, actions)
		}
	}
}

// protocolMachine mirrors the fields the smoke test inspects.
type protocolMachine struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status"`
	Edge   bool   `json:"edge"`
}

type agentProcess struct {
	cmd *exec.Cmd
}

func startAgent(t *testing.T, binary, home string, env []string) *agentProcess {
	t.Helper()
	cmd := exec.Command(binary, "serve")
	cmd.Env = append(os.Environ(), append(env, "MPANEL_AGENT_BASE_DIR="+home, "MPANEL_LOG_LEVEL=warn")...)
	if err := cmd.Start(); err != nil {
		t.Fatalf("start agent: %v", err)
	}
	return &agentProcess{cmd: cmd}
}

func (p *agentProcess) stop() {
	if p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
		_, _ = p.cmd.Process.Wait()
	}
}

func waitHTTP(t *testing.T, url string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		resp, err := http.Get(url)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return
			}
		}
		time.Sleep(150 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %s", url)
}
