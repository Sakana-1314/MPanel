package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func serveCORS(policy CORSConfig, origin, host string) *httptest.ResponseRecorder {
	handler := policy.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest(http.MethodGet, "http://panel.example.com/api/v1/machines", nil)
	req.Host = host
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

// 默认策略允许任意来源：面板只用 Authorization 头，不带 Cookie。
func TestCORSAllowsAnyOriginByDefault(t *testing.T) {
	policy := CORSConfig{}
	for _, origin := range []string{
		"https://any.example.com",
		"https://evil.example.net",
		"http://127.0.0.1:5173",
	} {
		rec := serveCORS(policy, origin, "panel.example.com")
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
			t.Fatalf("origin %q: Allow-Origin = %q, want *", origin, got)
		}
	}
}

// 不使用 Cookie 就必须不声明 Allow-Credentials，否则浏览器会拒绝跨源响应。
func TestCORSDoesNotAllowCredentials(t *testing.T) {
	rec := serveCORS(CORSConfig{}, "https://any.example.com", "panel.example.com")
	if got := rec.Header().Get("Access-Control-Allow-Credentials"); got != "" {
		t.Fatalf("Allow-Credentials = %q, want empty (no cookie auth)", got)
	}
}

func TestCORSAllowsAuthorizationHeader(t *testing.T) {
	rec := serveCORS(CORSConfig{}, "https://any.example.com", "panel.example.com")
	if got := rec.Header().Get("Access-Control-Allow-Headers"); !containsFold(got, "authorization") {
		t.Fatalf("Allow-Headers = %q, want it to include Authorization", got)
	}
}

// 配置了白名单就退回精确匹配，用于部署方主动收紧的场景。
func TestCORSWhitelistRestrictsOrigins(t *testing.T) {
	policy := CORSConfig{Allowed: []string{"https://ui.example.com"}}

	rec := serveCORS(policy, "https://ui.example.com", "panel.example.com")
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://ui.example.com" {
		t.Fatalf("Allow-Origin = %q, want whitelisted origin echoed", got)
	}

	rec = serveCORS(policy, "https://evil.example.net", "panel.example.com")
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("Allow-Origin = %q, want empty for non-whitelisted origin", got)
	}
}

func TestCORSWhitelistAcceptsWildcard(t *testing.T) {
	policy := CORSConfig{Allowed: []string{"*"}}
	rec := serveCORS(policy, "https://anything.example", "panel.example.com")
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Fatalf("Allow-Origin = %q, want *", got)
	}
}

func TestCORSPreflightReturns204(t *testing.T) {
	called := false
	handler := CORSConfig{}.Middleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))

	req := httptest.NewRequest(http.MethodOptions, "http://panel.example.com/api/v1/auth/login", nil)
	req.Header.Set("Origin", "https://any.example.com")
	req.Header.Set("Access-Control-Request-Method", "POST")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
	}
	if called {
		t.Fatal("preflight must not reach the wrapped handler")
	}
	if rec.Header().Get("Access-Control-Allow-Methods") == "" {
		t.Fatal("preflight response is missing Allow-Methods")
	}
}

// WebSocket 不走 CORS 头，但同样要按策略判断来源。
func TestOriginAllowed(t *testing.T) {
	if !(CORSConfig{}).OriginAllowed(httptest.NewRequest(http.MethodGet, "/ws/terminal/x", nil)) {
		t.Fatal("default policy must allow any origin")
	}

	restricted := CORSConfig{Allowed: []string{"https://ui.example.com"}}
	req := httptest.NewRequest(http.MethodGet, "/ws/terminal/x", nil)
	req.Header.Set("Origin", "https://ui.example.com")
	if !restricted.OriginAllowed(req) {
		t.Fatal("whitelisted origin must be allowed")
	}
	req.Header.Set("Origin", "https://evil.example.net")
	if restricted.OriginAllowed(req) {
		t.Fatal("non-whitelisted origin must be rejected")
	}
	// 没有 Origin 的客户端（agent、脚本）不受影响。
	noOrigin := httptest.NewRequest(http.MethodGet, "/ws/terminal/x", nil)
	if !restricted.OriginAllowed(noOrigin) {
		t.Fatal("requests without Origin must pass")
	}
}

func TestParseCORSOrigins(t *testing.T) {
	got := ParseCORSOrigins(" https://a.example.com , ,https://b.example.com ")
	if len(got) != 2 || got[0] != "https://a.example.com" || got[1] != "https://b.example.com" {
		t.Fatalf("ParseCORSOrigins = %#v", got)
	}
	if len(ParseCORSOrigins("")) != 0 {
		t.Fatal("empty config must yield no origins")
	}
}

func containsFold(haystack, needle string) bool {
	lower := make([]rune, 0, len(haystack))
	for _, r := range haystack {
		if r >= 'A' && r <= 'Z' {
			r += 'a' - 'A'
		}
		lower = append(lower, r)
	}
	target := make([]rune, 0, len(needle))
	for _, r := range needle {
		if r >= 'A' && r <= 'Z' {
			r += 'a' - 'A'
		}
		target = append(target, r)
	}
	return containsRunes(lower, target)
}

func containsRunes(haystack, needle []rune) bool {
	if len(needle) == 0 {
		return true
	}
	for i := 0; i+len(needle) <= len(haystack); i++ {
		match := true
		for j := range needle {
			if haystack[i+j] != needle[j] {
				match = false
				break
			}
		}
		if match {
			return true
		}
	}
	return false
}
