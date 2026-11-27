package sites

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/sakana-1314/mpanel/server/agent"
	"github.com/sakana-1314/mpanel/server/core/config"
)

func boolPtr(value bool) *bool { return &value }

func baseSite(cfg SiteConfig) Site {
	return Site{ID: "site_test", Name: "demo", Enabled: true, Config: cfg}
}

func mustRender(t *testing.T, site Site, roots []string) string {
	t.Helper()
	out, err := RenderSiteWithRoots(site, roots)
	if err != nil {
		t.Fatalf("RenderSiteWithRoots 失败: %v", err)
	}
	return out
}

func mustContain(t *testing.T, haystack, needle string) {
	t.Helper()
	if !strings.Contains(haystack, needle) {
		t.Fatalf("渲染结果缺少 %q:\n%s", needle, haystack)
	}
}

func TestRenderFileServer(t *testing.T) {
	root := t.TempDir()
	out := mustRender(t, baseSite(SiteConfig{
		Domains: []string{"example.com", "www.example.com"},
		Listen:  []string{"0.0.0.0:443"},
		Handler: SiteHandler{
			Type:          HandlerFileServer,
			Root:          root,
			IndexNames:    []string{"index.html"},
			SPA:           boolPtr(true),
			Browse:        boolPtr(true),
			Precompressed: []string{"gzip", "zstd"},
		},
		TLS:     &SiteTLS{Mode: TLSModeInternal},
		Headers: map[string]string{"X-Frame-Options": "SAMEORIGIN"},
		Encode:  []string{"gzip", "zstd"},
		Log:     true,
	}), []string{root})

	mustContain(t, out, "example.com, www.example.com {")
	mustContain(t, out, "bind 0.0.0.0:443")
	mustContain(t, out, "tls internal")
	mustContain(t, out, "encode gzip zstd")
	mustContain(t, out, "header X-Frame-Options SAMEORIGIN")
	mustContain(t, out, "output file /var/log/caddy/site_test.log")
	mustContain(t, out, "root * ")
	mustContain(t, out, "index index.html")
	mustContain(t, out, "try_files {path} /index.html")
	mustContain(t, out, "file_server {")
	mustContain(t, out, "browse")
	mustContain(t, out, "precompressed gzip zstd")
}

func TestRenderReverseProxy(t *testing.T) {
	out := mustRender(t, baseSite(SiteConfig{
		Domains: []string{"api.example.com"},
		Handler: SiteHandler{
			Type:          HandlerReverseProxy,
			Upstreams:     []string{"127.0.0.1:8080", "127.0.0.1:8081", "unix:/var/run/app.sock"},
			LoadBalance:   "least_conn",
			Headers:       map[string]string{"X-Real-IP": "client-ip", "X-Space": "hello world"},
			HealthURI:     "/health",
			TLSSkipVerify: boolPtr(true),
		},
		TLS: &SiteTLS{Mode: TLSModeAuto, Email: "ops@example.com"},
	}), nil)

	mustContain(t, out, "reverse_proxy 127.0.0.1:8080 127.0.0.1:8081 unix//var/run/app.sock {")
	mustContain(t, out, "lb_policy least_conn")
	mustContain(t, out, "health_uri /health")
	mustContain(t, out, "header_up X-Real-IP client-ip")
	mustContain(t, out, `header_up X-Space "hello world"`)
	mustContain(t, out, "transport http {")
	mustContain(t, out, "tls_insecure_skip_verify")
	mustContain(t, out, "tls ops@example.com")
}

func TestRenderRedirectPreserveQuery(t *testing.T) {
	out := mustRender(t, baseSite(SiteConfig{
		Domains: []string{"old.example.com"},
		Handler: SiteHandler{
			Type:          HandlerRedirect,
			To:            "https://example.com/new",
			Permanent:     boolPtr(true),
			PreserveQuery: boolPtr(true),
		},
	}), nil)
	mustContain(t, out, `redir "https://example.com/new{uri}" permanent`)
}

func TestRenderTLSOffUsesHTTPAddress(t *testing.T) {
	out := mustRender(t, baseSite(SiteConfig{
		Domains: []string{"plain.example.com"},
		Handler: SiteHandler{Type: HandlerRedirect, To: "/landing"},
		TLS:     &SiteTLS{Mode: TLSModeOff},
	}), nil)
	mustContain(t, out, "http://plain.example.com {")
	if strings.Contains(out, "tls ") {
		t.Fatalf("tls off 不应生成 tls 指令:\n%s", out)
	}
}

func TestRenderPHPFastCGI(t *testing.T) {
	root := t.TempDir()
	out := mustRender(t, baseSite(SiteConfig{
		Domains: []string{"php.example.com"},
		Handler: SiteHandler{
			Type:    HandlerPHPFastCGI,
			Root:    root,
			Address: "unix:/run/php-fpm.sock",
		},
	}), []string{root})
	mustContain(t, out, "root * ")
	mustContain(t, out, "php_fastcgi unix//run/php-fpm.sock")
}

func TestRenderBasicAuthHashesPlaintext(t *testing.T) {
	out := mustRender(t, baseSite(SiteConfig{
		Domains: []string{"secure.example.com"},
		Handler: SiteHandler{Type: HandlerRedirect, To: "/login"},
		BasicAuth: &BasicAuth{Users: []BasicAuthUser{
			{Username: "admin", Password: "s3cret-pass"},
		}},
	}), nil)
	mustContain(t, out, "basic_auth {")
	mustContain(t, out, "admin $2")
	if strings.Contains(out, "s3cret-pass") {
		t.Fatalf("明文密码泄漏进 Caddyfile:\n%s", out)
	}
}

func TestRenderBasicAuthRejectsBadHash(t *testing.T) {
	_, err := RenderSiteWithRoots(baseSite(SiteConfig{
		Domains: []string{"secure.example.com"},
		Handler: SiteHandler{Type: HandlerRedirect, To: "/login"},
		BasicAuth: &BasicAuth{Users: []BasicAuthUser{
			{Username: "admin", PasswordHash: "not-a-bcrypt-hash"},
		}},
	}), nil)
	if err == nil {
		t.Fatal("非法 bcrypt 哈希应被拒绝")
	}
}

func TestRenderRejectsInjection(t *testing.T) {
	root := t.TempDir()
	allowed := []string{root}
	fileServer := SiteHandler{Type: HandlerFileServer, Root: root}

	cases := []struct {
		name string
		cfg  SiteConfig
		root []string
	}{
		{"域名换行", SiteConfig{Domains: []string{"example.com\nevil.example.com"}, Handler: fileServer}, allowed},
		{"域名空格", SiteConfig{Domains: []string{"exa mple.com"}, Handler: fileServer}, allowed},
		{"域名带协议", SiteConfig{Domains: []string{"http://example.com"}, Handler: fileServer}, allowed},
		{"域名带端口", SiteConfig{Domains: []string{"example.com:8080"}, Handler: fileServer}, allowed},
		{"通配符位置错误", SiteConfig{Domains: []string{"foo.*.example.com"}, Handler: fileServer}, allowed},
		{"域名重复", SiteConfig{Domains: []string{"example.com", "EXAMPLE.com"}, Handler: fileServer}, allowed},
		{"IP 当域名", SiteConfig{Domains: []string{"127.0.0.1"}, Handler: fileServer}, allowed},
		{"listen 端口越界", SiteConfig{Domains: []string{"example.com"}, Listen: []string{":70000"}, Handler: fileServer}, allowed},
		{"listen 注入", SiteConfig{Domains: []string{"example.com"}, Listen: []string{":443 {\n}"}, Handler: fileServer}, allowed},
		{"上游带协议", SiteConfig{Domains: []string{"example.com"}, Handler: SiteHandler{Type: HandlerReverseProxy, Upstreams: []string{"http://127.0.0.1:8080"}}}, nil},
		{"上游缺端口", SiteConfig{Domains: []string{"example.com"}, Handler: SiteHandler{Type: HandlerReverseProxy, Upstreams: []string{"127.0.0.1"}}}, nil},
		{"上游换行", SiteConfig{Domains: []string{"example.com"}, Handler: SiteHandler{Type: HandlerReverseProxy, Upstreams: []string{"127.0.0.1:8080\nfoo"}}}, nil},
		{"上游花括号", SiteConfig{Domains: []string{"example.com"}, Handler: SiteHandler{Type: HandlerReverseProxy, Upstreams: []string{"127.0.0.1:8080{"}}}, nil},
		{"unix 相对路径", SiteConfig{Domains: []string{"example.com"}, Handler: SiteHandler{Type: HandlerReverseProxy, Upstreams: []string{"unix:relative.sock"}}}, nil},
		{"healthUri 换行", SiteConfig{Domains: []string{"example.com"}, Handler: SiteHandler{Type: HandlerReverseProxy, Upstreams: []string{"127.0.0.1:8080"}, HealthURI: "/health\n}"}}, nil},
		{"header 名换行", SiteConfig{Domains: []string{"example.com"}, Handler: SiteHandler{Type: HandlerFileServer, Root: root}, Headers: map[string]string{"X-Foo\n": "v"}}, allowed},
		{"header 值换行", SiteConfig{Domains: []string{"example.com"}, Handler: SiteHandler{Type: HandlerFileServer, Root: root}, Headers: map[string]string{"X-Foo": "a\nb"}}, allowed},
		{"header 值花括号", SiteConfig{Domains: []string{"example.com"}, Handler: SiteHandler{Type: HandlerFileServer, Root: root}, Headers: map[string]string{"X-Foo": "a{b}"}}, allowed},
		{"root 相对路径", SiteConfig{Domains: []string{"example.com"}, Handler: SiteHandler{Type: HandlerFileServer, Root: "relative/path"}}, allowed},
		{"root 越界", SiteConfig{Domains: []string{"example.com"}, Handler: SiteHandler{Type: HandlerFileServer, Root: root + "-evil"}}, allowed},
		{"root 花括号", SiteConfig{Domains: []string{"example.com"}, Handler: SiteHandler{Type: HandlerFileServer, Root: root + string(filepath.Separator) + "{bad}"}}, allowed},
		{"redirect 非法协议", SiteConfig{Domains: []string{"example.com"}, Handler: SiteHandler{Type: HandlerRedirect, To: "javascript:alert(1)"}}, nil},
		{"redirect 换行", SiteConfig{Domains: []string{"example.com"}, Handler: SiteHandler{Type: HandlerRedirect, To: "https://example.com\n}"}}, nil},
		{"tls 邮箱注入", SiteConfig{Domains: []string{"example.com"}, Handler: fileServer, TLS: &SiteTLS{Mode: TLSModeAuto, Email: "a@example.com}"}}, allowed},
		{"handler 缺失", SiteConfig{Domains: []string{"example.com"}}, nil},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := RenderSiteWithRoots(baseSite(tc.cfg), tc.root); err == nil {
				t.Fatalf("应拒绝非法配置: %+v", tc.cfg)
			}
		})
	}
}

func TestRenderSiteUsesEnvRootWhitelist(t *testing.T) {
	root := t.TempDir()
	t.Setenv("MPANEL_SITES_ROOTS", root)
	site := baseSite(SiteConfig{
		Domains: []string{"example.com"},
		Handler: SiteHandler{Type: HandlerFileServer, Root: root},
	})
	if _, err := RenderSite(site); err != nil {
		t.Fatalf("白名单内 root 应可渲染: %v", err)
	}
	site.Config.Handler.Root = root + "-outside"
	if _, err := RenderSite(site); err == nil {
		t.Fatal("白名单外 root 应被拒绝")
	}
}

func TestComputeStatus(t *testing.T) {
	applied := 1
	cases := []struct {
		name string
		site Site
		want SiteStatus
	}{
		{"disabled", Site{Enabled: false}, StatusDisabled},
		{"draft", Site{Enabled: true, Revision: 1}, StatusDraft},
		{"error", Site{Enabled: true, Revision: 1, AppliedRevision: &applied, LastApply: &SiteLastApply{OK: false}}, StatusError},
		{"pending-revision", Site{Enabled: true, Revision: 2, AppliedRevision: &applied, LastApply: &SiteLastApply{OK: true}}, StatusPending},
		{"pending-never-applied", Site{Enabled: true, Revision: 1, LastApply: &SiteLastApply{OK: true}}, StatusPending},
		{"applied", Site{Enabled: true, Revision: 1, AppliedRevision: &applied, LastApply: &SiteLastApply{OK: true}}, StatusApplied},
	}
	for _, tc := range cases {
		if got := computeStatus(tc.site); got != tc.want {
			t.Errorf("%s: status=%s, want %s", tc.name, got, tc.want)
		}
	}
}

func TestParseCaddyfileBestEffort(t *testing.T) {
	content := `
example.com, www.example.com {
	root * /var/www/demo
	encode gzip
	index index.html
	header X-Frame-Options SAMEORIGIN
	file_server
}

api.example.com {
	reverse_proxy 127.0.0.1:8080 127.0.0.1:8081 {
		lb_policy least_conn
		health_uri /health
	}
	tls ops@example.com
}

old.example.com {
	redir https://example.com{uri} permanent
}
`
	parsed, warnings := parseCaddyfile(content)
	if len(parsed) != 3 {
		t.Fatalf("期望解析出 3 个站点，得到 %d 个（warnings: %v）", len(parsed), warnings)
	}
	byName := map[string]Site{}
	for _, site := range parsed {
		byName[site.Name] = site
	}
	static, ok := byName["example.com"]
	if !ok {
		t.Fatalf("缺少 example.com 站点: %v", byName)
	}
	if static.Config.Handler.Type != HandlerFileServer || static.Config.Handler.Root != "/var/www/demo" {
		t.Fatalf("静态站解析错误: %+v", static.Config.Handler)
	}
	api, ok := byName["api.example.com"]
	if !ok {
		t.Fatalf("缺少 api.example.com 站点: %v", byName)
	}
	if api.Config.Handler.Type != HandlerReverseProxy || len(api.Config.Handler.Upstreams) != 2 {
		t.Fatalf("反代解析错误: %+v", api.Config.Handler)
	}
	if api.Config.Handler.LoadBalance != "least_conn" || api.Config.Handler.HealthURI != "/health" {
		t.Fatalf("反代块解析错误: %+v", api.Config.Handler)
	}
	redirectSite, ok := byName["old.example.com"]
	if !ok {
		t.Fatalf("缺少 old.example.com 站点: %v", byName)
	}
	if redirectSite.Config.Handler.Type != HandlerRedirect || redirectSite.Config.Handler.To != "https://example.com" {
		t.Fatalf("重定向解析错误: %+v", redirectSite.Config.Handler)
	}
	if redirectSite.Config.Handler.PreserveQuery == nil || !*redirectSite.Config.Handler.PreserveQuery {
		t.Fatalf("preserveQuery 未还原: %+v", redirectSite.Config.Handler)
	}
}

func TestStoreCRUDPersists(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sites.json")
	store, err := OpenStore(path)
	if err != nil {
		t.Fatalf("OpenStore: %v", err)
	}
	root := t.TempDir()
	cfg := SiteConfig{
		Domains: []string{"example.com"},
		Handler: SiteHandler{Type: HandlerFileServer, Root: root},
	}
	site, perr := store.Create("demo", true, cfg)
	if perr != nil {
		t.Fatalf("Create: %v", perr)
	}
	if site.Revision != 1 || site.Status != StatusDraft {
		t.Fatalf("新站点字段错误: %+v", site)
	}
	if _, perr := store.Create("demo", true, cfg); perr == nil || perr.Code != "CONFLICT" {
		t.Fatalf("重名应返回 CONFLICT, got %v", perr)
	}
	name := "renamed"
	updated, perr := store.Update(site.ID, UpdateInput{Name: &name})
	if perr != nil {
		t.Fatalf("Update: %v", perr)
	}
	if updated.Revision != 2 || updated.Name != "renamed" {
		t.Fatalf("Update 结果错误: %+v", updated)
	}
	if len(updated.Config.Domains) != 1 {
		t.Fatalf("Update 未保留 config: %+v", updated.Config)
	}
	if _, perr := store.Delete(site.ID); perr != nil {
		t.Fatalf("Delete: %v", perr)
	}
	reopened, err := OpenStore(path)
	if err != nil {
		t.Fatalf("重新打开失败: %v", err)
	}
	if len(reopened.List()) != 0 {
		t.Fatal("删除后重新加载仍有站点")
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("sites.json 未写入: %v", err)
	}
}

func TestManagedCaddyfileIncludesImportAndAdmin(t *testing.T) {
	content := managedCaddyfile("127.0.0.1:2019")
	mustContain(t, content, "import sites.d/*.caddy")
	mustContain(t, content, "admin 127.0.0.1:2019")
	mustContain(t, content, "output file /var/log/caddy/caddy.log")
}

func TestApplyChangedNoOpDetection(t *testing.T) {
	dir := t.TempDir()
	live := filepath.Join(dir, "sites.d")
	if err := os.MkdirAll(live, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(live, "a.caddy"), []byte("block"), 0o644); err != nil {
		t.Fatal(err)
	}
	staging := t.TempDir()
	if err := os.WriteFile(filepath.Join(staging, "a.caddy"), []byte("block"), 0o644); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(dir, "Caddyfile")
	content := "same"
	if err := os.WriteFile(root, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	module := &Module{}
	applied := 1
	site := Site{ID: "x", Enabled: true, Revision: 1, AppliedRevision: &applied, LastApply: &SiteLastApply{OK: true}}
	if module.applyChanged(applyPlan{}, staging, live, root, content, []renderedSite{{site: site}}) {
		t.Fatal("完全一致且已应用时应判定无变更")
	}
	if !module.applyChanged(applyPlan{force: true}, staging, live, root, content, []renderedSite{{site: site}}) {
		t.Fatal("force=true 必须重写")
	}
	if err := os.WriteFile(filepath.Join(staging, "b.caddy"), []byte("new"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !module.applyChanged(applyPlan{}, staging, live, root, content, []renderedSite{{site: site}}) {
		t.Fatal("片段集合变化应判定有变更")
	}
}

func TestSiteStatusRoundTrip(t *testing.T) {
	now := time.Now().UTC().Format(time.RFC3339)
	site := Site{ID: "site_1", Name: "demo", Enabled: true, CreatedAt: now, UpdatedAt: now}
	if site.Status != "" {
		t.Fatal("原始零值不应有 status")
	}
	if decorate(site).Status != StatusDraft {
		t.Fatal("decorate 应计算 draft")
	}
}

type testEnvelope struct {
	OK    bool            `json:"ok"`
	Data  json.RawMessage `json:"data"`
	Error *testAPIError   `json:"error"`
}

type testAPIError struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details"`
}

func doRequest(t *testing.T, handler http.Handler, method, path, body string) testEnvelope {
	t.Helper()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	var envelope testEnvelope
	if err := json.Unmarshal(recorder.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("%s %s 响应不是信封 JSON (status=%d): %v\n%s", method, path, recorder.Code, err, recorder.Body.String())
	}
	return envelope
}

// TestModuleHTTPRoutes exercises registration (ServeMux pattern conflicts panic
// at Register time) and the JSON envelope shapes end to end.
func TestModuleHTTPRoutes(t *testing.T) {
	base := t.TempDir()
	cfg := config.NewAgent(base)
	cfg.Agent.DataDir = filepath.Join(base, "data")
	runner := &fakeRunner{}
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

	list := doRequest(t, ctx.Mux, http.MethodGet, "/api/v1/sites", "")
	if !list.OK {
		t.Fatalf("列表失败: %+v", list.Error)
	}
	var listData struct {
		Available bool   `json:"available"`
		Items     []Site `json:"items"`
	}
	if err := json.Unmarshal(list.Data, &listData); err != nil {
		t.Fatal(err)
	}
	if !listData.Available || len(listData.Items) != 0 {
		t.Fatalf("初始列表错误: %+v", listData)
	}

	createBody, err := json.Marshal(map[string]any{
		"name":    "demo",
		"enabled": true,
		"config": map[string]any{
			"domains": []string{"example.com"},
			"handler": map[string]any{"type": "file_server", "root": root},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	created := doRequest(t, ctx.Mux, http.MethodPost, "/api/v1/sites", string(createBody))
	if !created.OK {
		t.Fatalf("创建失败: %+v", created.Error)
	}
	var site Site
	if err := json.Unmarshal(created.Data, &site); err != nil {
		t.Fatal(err)
	}
	if site.ID == "" || site.Revision != 1 || site.Status != StatusDraft {
		t.Fatalf("创建结果错误: %+v", site)
	}

	conflict := doRequest(t, ctx.Mux, http.MethodPost, "/api/v1/sites", string(createBody))
	if conflict.OK || conflict.Error == nil || conflict.Error.Code != "CONFLICT" {
		t.Fatalf("重名应返回 CONFLICT: %+v", conflict)
	}

	got := doRequest(t, ctx.Mux, http.MethodGet, "/api/v1/sites/"+site.ID, "")
	if !got.OK {
		t.Fatalf("详情失败: %+v", got.Error)
	}
	previewBody, err := json.Marshal(map[string]any{"siteId": site.ID})
	if err != nil {
		t.Fatal(err)
	}
	preview := doRequest(t, ctx.Mux, http.MethodPost, "/api/v1/sites/preview", string(previewBody))
	if !preview.OK {
		t.Fatalf("预览失败: %+v", preview.Error)
	}
	var previewData SitePreviewResult
	if err := json.Unmarshal(preview.Data, &previewData); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(previewData.Caddyfile, "example.com") {
		t.Fatalf("预览缺少域名: %s", previewData.Caddyfile)
	}
	if previewData.Warnings == nil {
		t.Fatal("preview warnings 应为数组")
	}

	updateBody := `{"name":"demo2"}`
	updated := doRequest(t, ctx.Mux, http.MethodPatch, "/api/v1/sites/"+site.ID, updateBody)
	if !updated.OK {
		t.Fatalf("PATCH 失败: %+v", updated.Error)
	}
	var updatedSite Site
	if err := json.Unmarshal(updated.Data, &updatedSite); err != nil {
		t.Fatal(err)
	}
	if updatedSite.Revision != 2 || updatedSite.Name != "demo2" {
		t.Fatalf("更新结果错误: %+v", updatedSite)
	}

	deleted := doRequest(t, ctx.Mux, http.MethodDelete, "/api/v1/sites/"+site.ID, "")
	if !deleted.OK {
		t.Fatalf("删除失败: %+v", deleted.Error)
	}
	var deleteData deleteResult
	if err := json.Unmarshal(deleted.Data, &deleteData); err != nil {
		t.Fatal(err)
	}
	if !deleteData.Deleted {
		t.Fatalf("删除结果错误: %+v", deleteData)
	}

	export := doRequest(t, ctx.Mux, http.MethodGet, "/api/v1/sites/export", "")
	if !export.OK {
		t.Fatalf("导出失败: %+v", export.Error)
	}
	var bundle SiteExportBundle
	if err := json.Unmarshal(export.Data, &bundle); err != nil {
		t.Fatal(err)
	}
	if bundle.Version != 1 || bundle.Sites == nil {
		t.Fatalf("导出结果错误: %+v", bundle)
	}

	importBody, err := json.Marshal(map[string]any{
		"bundle": map[string]any{
			"version":    1,
			"exportedAt": nowRFC3339(),
			"sites": []map[string]any{{
				"name":    "imported",
				"enabled": true,
				"config": map[string]any{
					"domains": []string{"imported.example.com"},
					"handler": map[string]any{"type": "redirect", "to": "/"},
				},
			}},
		},
		"mode": "merge",
	})
	if err != nil {
		t.Fatal(err)
	}
	imported := doRequest(t, ctx.Mux, http.MethodPost, "/api/v1/sites/import", string(importBody))
	if !imported.OK {
		t.Fatalf("导入失败: %+v", imported.Error)
	}
	var importData SiteImportResult
	if err := json.Unmarshal(imported.Data, &importData); err != nil {
		t.Fatal(err)
	}
	if importData.Imported != 1 || importData.Errors == nil {
		t.Fatalf("导入结果错误: %+v", importData)
	}

	missing := doRequest(t, ctx.Mux, http.MethodGet, "/api/v1/sites/site_missing", "")
	if missing.OK || missing.Error == nil || missing.Error.Code != "NOT_FOUND" {
		t.Fatalf("缺失站点应返回 NOT_FOUND: %+v", missing)
	}
}

func TestCaddyLogName(t *testing.T) {
	for input, want := range map[string]string{
		"site_abc-123": "site_abc-123",
		"":             "site",
		"../escape":    "site",
		"site/1":       "site",
	} {
		if got := caddyLogName(input); got != want {
			t.Fatalf("caddyLogName(%q) = %q，期望 %q", input, got, want)
		}
	}
}
