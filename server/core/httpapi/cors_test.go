package httpapi

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func newRequest(t *testing.T, method, target, origin, host string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(method, target, nil)
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	if host != "" {
		req.Host = host
	}
	return req
}

func TestCORSMiddlewareAllowsExplicitOrigin(t *testing.T) {
	policy := CORSConfig{Allowed: []string{"https://ui.example.com"}}
	handler := policy.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, newRequest(t, http.MethodGet, "http://panel.example.com/api/v1/machines", "https://ui.example.com", "panel.example.com"))

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://ui.example.com" {
		t.Fatalf("Allow-Origin = %q, want explicit origin", got)
	}
	if got := rec.Header().Get("Access-Control-Allow-Credentials"); got != "true" {
		t.Fatalf("Allow-Credentials = %q, want true", got)
	}
}

func TestCORSMiddlewareRejectsUnknownPublicOrigin(t *testing.T) {
	policy := CORSConfig{Allowed: []string{"https://ui.example.com"}, AllowLocal: true}
	handler := policy.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, newRequest(t, http.MethodGet, "http://panel.example.com/api/v1/machines", "https://evil.example.net", "panel.example.com"))

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("Allow-Origin = %q, want empty for unknown public origin", got)
	}
}

func TestCORSMiddlewareAllowsSameOrigin(t *testing.T) {
	policy := CORSConfig{AllowLocal: true}
	handler := policy.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, newRequest(t, http.MethodPost, "http://panel.example.com/api/v1/auth/login", "http://panel.example.com", "panel.example.com"))

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "http://panel.example.com" {
		t.Fatalf("Allow-Origin = %q, want same origin", got)
	}
}

func TestCORSMiddlewareAllowsLocalDevServer(t *testing.T) {
	policy := CORSConfig{AllowLocal: true}
	handler := policy.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))

	for _, origin := range []string{"http://127.0.0.1:5173", "http://localhost:5173", "http://192.168.1.20:5288"} {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, newRequest(t, http.MethodGet, "http://127.0.0.1:10086/api/v1/machines", origin, "127.0.0.1:10086"))
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != origin {
			t.Fatalf("Allow-Origin = %q, want %q for local dev", got, origin)
		}
	}
}

func TestCORSMiddlewareRejectsLocalWhenDisabled(t *testing.T) {
	policy := CORSConfig{AllowLocal: false}
	handler := policy.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, newRequest(t, http.MethodGet, "http://127.0.0.1:10086/api/v1/machines", "http://127.0.0.1:5173", "127.0.0.1:10086"))

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("Allow-Origin = %q, want empty when AllowLocal is off", got)
	}
}

func TestCORSMiddlewareIgnoresSpoofedForwardedHost(t *testing.T) {
	policy := CORSConfig{AllowLocal: false, TrustForwarded: false}
	handler := policy.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))

	req := newRequest(t, http.MethodGet, "http://127.0.0.1:10086/api/v1/machines", "https://evil.example.net", "127.0.0.1:10086")
	req.Header.Set("X-Forwarded-Host", "evil.example.net")
	req.Header.Set("X-Forwarded-Proto", "https")

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("Allow-Origin = %q, want empty: forwarded headers must not grant access", got)
	}
}

func TestCORSMiddlewareHonoursForwardedHostWhenTrusted(t *testing.T) {
	policy := CORSConfig{AllowLocal: false, TrustForwarded: true}
	handler := policy.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))

	req := newRequest(t, http.MethodGet, "http://127.0.0.1:10086/api/v1/machines", "https://panel.example.com", "127.0.0.1:10086")
	req.Header.Set("X-Forwarded-Host", "panel.example.com")
	req.Header.Set("X-Forwarded-Proto", "https")

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://panel.example.com" {
		t.Fatalf("Allow-Origin = %q, want proxied origin", got)
	}
}

func TestCORSMiddlewarePreflightReturns204(t *testing.T) {
	policy := CORSConfig{AllowLocal: true}
	called := false
	handler := policy.Middleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))

	req := newRequest(t, http.MethodOptions, "http://127.0.0.1:10086/api/v1/auth/login", "http://127.0.0.1:5173", "127.0.0.1:10086")
	req.Header.Set("Access-Control-Request-Method", "POST")

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
	}
	if called {
		t.Fatal("preflight must not reach the wrapped handler")
	}
	if got := rec.Header().Get("Access-Control-Allow-Methods"); got == "" {
		t.Fatal("preflight response is missing Allow-Methods")
	}
}

func TestCORSAllowsRefererFallback(t *testing.T) {
	policy := CORSConfig{Allowed: []string{"https://ui.example.com"}}
	req := httptest.NewRequest(http.MethodGet, "http://panel.example.com/api/v1/machines", nil)
	req.Host = "panel.example.com"
	req.Header.Set("Referer", "https://ui.example.com/settings?tab=about")

	if !policy.OriginAllowed(req) {
		t.Fatal("Referer origin should be accepted")
	}
}

func TestCORSAllowsRequestsWithoutOrigin(t *testing.T) {
	policy := CORSConfig{AllowLocal: false}
	req := httptest.NewRequest(http.MethodGet, "http://panel.example.com/api/v1/machines", nil)

	if !policy.OriginAllowed(req) {
		t.Fatal("requests without Origin (agents, scripts) must pass")
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
