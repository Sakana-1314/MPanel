package sites

import (
	"context"
	"encoding/json"
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

// fakeRunner simulates docker + the Caddy container. Capability probing
// (`docker version`, `docker ps`, `docker exec ... caddy version`) and apply
// (`docker exec ... caddy validate/reload`) all go through it.
type fakeRunner struct {
	mu           sync.Mutex
	failValidate bool
	failReloads  int
	noContainer  bool
	calls        [][]string
}

func (f *fakeRunner) record(name string, args []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	call := append([]string{name}, args...)
	f.calls = append(f.calls, call)
}

func (f *fakeRunner) handle(args []string) (agent.Result, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(args) == 0 {
		return agent.Result{}, nil
	}
	switch args[0] {
	case "version":
		return agent.Result{Stdout: "v27.0.0"}, nil
	case "ps":
		if f.noContainer {
			return agent.Result{Stdout: ""}, nil
		}
		return agent.Result{Stdout: `{"ID":"caddycid","Names":"mpanel-caddy","Image":"caddy:2-alpine","State":"running","Labels":"com.docker.compose.project=mpanel-caddy,com.docker.compose.service=caddy"}` + "\n"}, nil
	case "exec":
		if len(args) < 4 || args[2] != "caddy" {
			return agent.Result{Stderr: "unexpected exec", Code: 1}, nil
		}
		switch args[3] {
		case "version":
			return agent.Result{Stdout: "v2.8.4"}, nil
		case "validate":
			if f.failValidate {
				return agent.Result{Stdout: "Error: invalid caddyfile", Stderr: "line 1: bad", Code: 1}, nil
			}
			return agent.Result{Stdout: "Valid configuration"}, nil
		case "reload":
			if f.failReloads > 0 {
				f.failReloads--
				return agent.Result{Stderr: "reload failed: connection refused", Code: 1}, nil
			}
			return agent.Result{Stdout: "config reloaded"}, nil
		}
	}
	return agent.Result{}, nil
}

func (f *fakeRunner) Run(ctx context.Context, name string, args ...string) (agent.Result, error) {
	return f.RunTimeout(ctx, time.Second, name, args...)
}

func (f *fakeRunner) RunTimeout(ctx context.Context, timeout time.Duration, name string, args ...string) (agent.Result, error) {
	f.record(name, args)
	return f.handle(args)
}

func (f *fakeRunner) Stream(ctx context.Context, name string, args []string, onLine func(string)) (agent.Result, error) {
	f.record(name, args)
	return f.handle(args)
}

func (f *fakeRunner) setFailValidate(value bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failValidate = value
}

func (f *fakeRunner) setFailReloads(count int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failReloads = count
}

// caddyExecCount counts `docker exec <id> caddy <sub>` invocations.
func (f *fakeRunner) caddyExecCount(sub string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	count := 0
	for _, call := range f.calls {
		if len(call) >= 5 && call[1] == "exec" && call[3] == "caddy" && call[4] == sub {
			count++
		}
	}
	return count
}

func newTestModule(t *testing.T) (*Module, *agent.Context, *fakeRunner, string) {
	t.Helper()
	base := t.TempDir()
	cfg := config.NewAgent(base)
	cfg.Agent.DataDir = filepath.Join(base, "data")
	runner := &fakeRunner{}
	runner.failReloads = 0
	ctx := &agent.Context{
		Mux:    http.NewServeMux(),
		Cfg:    cfg,
		Runner: runner,
		Caps:   agent.NewProber(cfg, runner),
		Logger: slog.Default(),
	}
	module := New()
	if err := module.Register(ctx); err != nil {
		t.Fatalf("Register: %v", err)
	}
	root := filepath.Join(cfg.Agent.DataDir, "sites", "demo")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	return module, ctx, runner, root
}

func createDemoSite(t *testing.T, module *Module, root string) Site {
	t.Helper()
	site, perr := module.store.Create("demo", true, SiteConfig{
		Domains: []string{"example.com"},
		Handler: SiteHandler{Type: HandlerFileServer, Root: root},
	})
	if perr != nil {
		t.Fatalf("Create: %v", perr)
	}
	return site
}

func TestApplyPipelineWithFakeCaddy(t *testing.T) {
	module, ctx, runner, root := newTestModule(t)
	site := createDemoSite(t, module, root)
	confDir, _ := ctx.Cfg.CaddyDirs()
	liveFragment := filepath.Join(confDir, "sites.d", site.ID+".caddy")

	result, err := module.apply(context.Background(), applyPlan{})
	if err != nil {
		t.Fatalf("首次 apply 失败: %v", err)
	}
	if !result.Reloaded || result.RolledBack || result.BackupPath == nil || result.Revision != 1 {
		t.Fatalf("apply 结果错误: %+v", result)
	}
	if len(result.Sites) != 1 || result.Sites[0].Status != StatusApplied {
		t.Fatalf("apply sites 状态错误: %+v", result.Sites)
	}
	fragment, err := os.ReadFile(liveFragment)
	if err != nil {
		t.Fatalf("站点片段未写入: %v", err)
	}
	if !strings.Contains(string(fragment), "example.com") {
		t.Fatalf("片段内容错误: %s", fragment)
	}
	caddyfile, err := os.ReadFile(filepath.Join(confDir, "Caddyfile"))
	if err != nil {
		t.Fatalf("根 Caddyfile 未写入: %v", err)
	}
	if !strings.Contains(string(caddyfile), "import sites.d/*.caddy") {
		t.Fatalf("根 Caddyfile 缺少 import: %s", caddyfile)
	}
	if _, err := os.Stat(*result.BackupPath); err != nil {
		t.Fatalf("备份目录不存在: %v", err)
	}
	stored, ok := module.store.Get(site.ID)
	if !ok || stored.Status != StatusApplied || stored.AppliedRevision == nil || *stored.AppliedRevision != 1 {
		t.Fatalf("apply 记账错误: %+v", stored)
	}
	if stored.LastApply == nil || !stored.LastApply.OK || stored.LastApply.Revision != 1 || stored.LastApply.CaddyfileHash == "" {
		t.Fatalf("lastApply 错误: %+v", stored.LastApply)
	}

	// A second apply without force is a no-op and must not reload caddy.
	before := runner.caddyExecCount("reload")
	noop, err := module.apply(context.Background(), applyPlan{})
	if err != nil {
		t.Fatalf("第二次 apply 失败: %v", err)
	}
	if noop.Reloaded || noop.Revision != 1 || noop.BackupPath != nil {
		t.Fatalf("无变化 apply 应跳过: %+v", noop)
	}
	if runner.caddyExecCount("reload") != before {
		t.Fatal("无变化 apply 不应 reload caddy")
	}

	// force rewrites even without a revision change.
	forced, err := module.apply(context.Background(), applyPlan{force: true})
	if err != nil {
		t.Fatalf("force apply 失败: %v", err)
	}
	if !forced.Reloaded || forced.Revision != 2 {
		t.Fatalf("force apply 结果错误: %+v", forced)
	}

	// Reload failure rolls the files back and marks the site as error.
	successFragment, err := os.ReadFile(liveFragment)
	if err != nil {
		t.Fatal(err)
	}
	runner.setFailReloads(1)
	_, err = module.apply(context.Background(), applyPlan{force: true})
	if err == nil {
		t.Fatal("reload 失败应返回错误")
	}
	panelErr, ok := err.(*protocol.PanelError)
	if !ok || panelErr.Code != protocol.CodeUpstreamError {
		t.Fatalf("期望 UPSTREAM_ERROR，得到 %v", err)
	}
	if rolledBack, _ := panelErr.Details["rolledBack"].(bool); !rolledBack {
		t.Fatalf("details.rolledBack 应为 true: %+v", panelErr.Details)
	}
	if stage, _ := panelErr.Details["stage"].(string); stage != "reload" {
		t.Fatalf("details.stage 应为 reload: %+v", panelErr.Details)
	}
	restored, err := os.ReadFile(liveFragment)
	if err != nil {
		t.Fatalf("回滚后片段丢失: %v", err)
	}
	if string(restored) != string(successFragment) {
		t.Fatal("回滚后片段内容与上一成功版本不一致")
	}
	failed, _ := module.store.Get(site.ID)
	if failed.Status != StatusError || failed.LastApply == nil || failed.LastApply.OK {
		t.Fatalf("失败后状态错误: %+v", failed)
	}

	// Validate failure happens before any live write.
	runner.setFailValidate(true)
	beforeCaddyfile, _ := os.ReadFile(filepath.Join(confDir, "Caddyfile"))
	_, err = module.apply(context.Background(), applyPlan{force: true})
	if err == nil {
		t.Fatal("validate 失败应返回错误")
	}
	panelErr, ok = err.(*protocol.PanelError)
	if !ok || panelErr.Code != protocol.CodeBadRequest {
		t.Fatalf("期望 BAD_REQUEST，得到 %v", err)
	}
	if stage, _ := panelErr.Details["stage"].(string); stage != "validate" {
		t.Fatalf("details.stage 应为 validate: %+v", panelErr.Details)
	}
	afterCaddyfile, _ := os.ReadFile(filepath.Join(confDir, "Caddyfile"))
	if string(beforeCaddyfile) != string(afterCaddyfile) {
		t.Fatal("validate 失败不应修改线上 Caddyfile")
	}
}

func TestApplyRejectsRootOutsideWhitelist(t *testing.T) {
	module, _, _, root := newTestModule(t)
	site := createDemoSite(t, module, root)
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := site.Config
	cfg.Handler.Root = outside
	if _, perr := module.store.Update(site.ID, UpdateInput{Config: &cfg}); perr != nil {
		t.Fatalf("Update: %v", perr)
	}
	_, err := module.apply(context.Background(), applyPlan{})
	if err == nil {
		t.Fatal("越界 root 应导致 apply 失败")
	}
	panelErr, ok := err.(*protocol.PanelError)
	if !ok || panelErr.Code != protocol.CodeBadRequest {
		t.Fatalf("期望 BAD_REQUEST，得到 %v", err)
	}
	if stage, _ := panelErr.Details["stage"].(string); stage != "render" {
		t.Fatalf("details.stage 应为 render: %+v", panelErr.Details)
	}
}

func TestApplyNotFoundAndEmptySiteIDs(t *testing.T) {
	module, _, _, _ := newTestModule(t)
	_, err := module.apply(context.Background(), applyPlan{partial: true, siteIDs: []string{"site_missing"}})
	if err == nil {
		t.Fatal("不存在的 siteId 应返回错误")
	}
	if panelErr, ok := err.(*protocol.PanelError); !ok || panelErr.Code != protocol.CodeNotFound {
		t.Fatalf("期望 NOT_FOUND，得到 %v", err)
	}
	if _, err := module.apply(context.Background(), applyPlan{partial: true, siteIDs: []string{}}); err == nil {
		t.Fatal("空 siteIds 应返回 BAD_REQUEST")
	}
}

func TestBootstrapPreparesDirsAndMounts(t *testing.T) {
	module, ctx, _, _ := newTestModule(t)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/v1/sites/bootstrap", strings.NewReader("{}"))
	module.handleBootstrap(recorder, request)

	var envelope struct {
		OK   bool                `json:"ok"`
		Data SiteBootstrapResult `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("响应不是信封 JSON: %v\n%s", err, recorder.Body.String())
	}
	if !envelope.OK {
		t.Fatalf("bootstrap 失败: %s", recorder.Body.String())
	}
	result := envelope.Data
	confDir, dataDir := ctx.Cfg.CaddyDirs()
	if result.ConfigDir == "" || result.DataDir == "" || result.CaddyfilePath == "" {
		t.Fatalf("bootstrap 返回路径不完整: %+v", result)
	}
	content, err := os.ReadFile(filepath.Join(confDir, "Caddyfile"))
	if err != nil {
		t.Fatalf("Caddyfile 未写入: %v", err)
	}
	if !strings.Contains(string(content), "import sites.d/*.caddy") {
		t.Fatalf("Caddyfile 内容错误: %s", content)
	}
	if !pathIsDir(filepath.Join(confDir, "sites.d")) || !pathIsDir(dataDir) {
		t.Fatal("bootstrap 未创建 sites.d 或 data 目录")
	}
	targets := map[string]bool{}
	for _, mount := range result.Mounts {
		targets[mount.Target] = true
	}
	if !targets["/etc/caddy"] || !targets["/data"] {
		t.Fatalf("缺少 Caddy config/data 挂载: %+v", result.Mounts)
	}
	if !targets[strings.ReplaceAll(result.SitesRoot, "\\", "/")] {
		t.Fatalf("缺少站点根挂载: %+v", result.Mounts)
	}
}

func TestSitesUnavailableWithoutCaddyContainer(t *testing.T) {
	_, ctx, runner, root := newTestModule(t)
	runner.mu.Lock()
	runner.noContainer = true
	runner.mu.Unlock()

	list := doRequest(t, ctx.Mux, http.MethodGet, "/api/v1/sites", "")
	if !list.OK {
		t.Fatalf("列表信封错误: %+v", list.Error)
	}
	var listData struct {
		Available bool   `json:"available"`
		Reason    string `json:"reason"`
		Items     []Site `json:"items"`
	}
	if err := json.Unmarshal(list.Data, &listData); err != nil {
		t.Fatal(err)
	}
	if listData.Available || len(listData.Items) != 0 || listData.Reason == "" {
		t.Fatalf("未部署时应返回 available=false: %+v", listData)
	}

	createBody, err := json.Marshal(map[string]any{
		"name": "blocked",
		"config": map[string]any{
			"domains": []string{"example.com"},
			"handler": map[string]any{"type": "file_server", "root": root},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	created := doRequest(t, ctx.Mux, http.MethodPost, "/api/v1/sites", string(createBody))
	if created.OK || created.Error == nil || created.Error.Code != "UNAVAILABLE" {
		t.Fatalf("未部署时创建站点应返回 UNAVAILABLE: %+v", created)
	}
}
