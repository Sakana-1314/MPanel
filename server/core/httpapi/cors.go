package httpapi

import (
	"net"
	"net/http"
	"net/url"
	"strings"
)

// CORSConfig decides which browser origins may call the panel with credentials.
//
// The panel is usually served by core itself, so browser requests are same-origin
// and carry no Origin header at all. A cross-origin request only appears when the
// UI is opened from somewhere else: a dev server on another port, a reverse proxy,
// or a static mirror. Three rules are applied in order:
//
//  1. explicit allowlist entries (MPANEL_CORS_ORIGINS) always win;
//  2. the origin must match the request's own scheme://host — resolved through
//     X-Forwarded-* only when the direct peer is a trusted proxy;
//  3. loopback and private-network origins are accepted when AllowLocal is on,
//     which covers `vite dev` on 127.0.0.1:5173 talking to a panel on 10086.
//
// Arbitrary public origins are never reflected. These responses carry cookies, so
// reflecting any Origin would let any website read the panel with the visitor's
// session.
type CORSConfig struct {
	// Allowed lists explicit origins (scheme://host[:port]).
	Allowed []string
	// AllowLocal accepts loopback/private origins and the request's own host.
	AllowLocal bool
	// TrustForwarded allows X-Forwarded-Proto/Host to decide the request origin.
	// It must only be enabled when a reverse proxy in front of core rewrites them.
	TrustForwarded bool
}

// ParseCORSOrigins splits a comma separated origin list, dropping empties.
func ParseCORSOrigins(value string) []string {
	out := make([]string, 0, 4)
	for _, part := range strings.Split(value, ",") {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

// Middleware applies the decision described on CORSConfig.
func (c CORSConfig) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := requestOrigin(r); origin != "" && c.Allows(origin, r) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization,Content-Type,X-MPanel-Token,X-Requested-With")
			w.Header().Set("Access-Control-Max-Age", "600")
			w.Header().Add("Vary", "Origin")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// OriginAllowed reports whether the caller may read responses. WebSocket upgrades
// do not pass through CORS headers, so handlers that check Origin use this instead.
func (c CORSConfig) OriginAllowed(r *http.Request) bool {
	origin := requestOrigin(r)
	return origin == "" || c.Allows(origin, r)
}

// Allows reports whether a concrete origin is permitted for this request.
func (c CORSConfig) Allows(origin string, r *http.Request) bool {
	for _, item := range c.Allowed {
		if item == "*" || strings.EqualFold(item, origin) {
			return true
		}
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return false
	}
	if sameOrigin(parsed, c.requestOrigin(r)) {
		return true
	}
	if !c.AllowLocal {
		return false
	}
	if host := parsed.Hostname(); host != "" {
		if ip := net.ParseIP(host); ip != nil {
			return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast()
		}
		return host == "localhost" ||
			strings.HasSuffix(host, ".localhost") ||
			host == "host.docker.internal"
	}
	return false
}

// requestOrigin is the origin of the request itself: scheme://host[:port].
func (c CORSConfig) requestOrigin(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	host := r.Host
	if c.TrustForwarded {
		if forwarded := firstHeaderValue(r.Header.Get("X-Forwarded-Proto")); forwarded != "" {
			scheme = forwarded
		}
		if forwarded := firstHeaderValue(r.Header.Get("X-Forwarded-Host")); forwarded != "" {
			host = forwarded
		}
	}
	if host == "" {
		return ""
	}
	return scheme + "://" + host
}

// requestOrigin prefers the Origin header and falls back to Referer, so plain
// navigations (which omit Origin) are still attributable.
func requestOrigin(r *http.Request) string {
	if origin := strings.TrimSpace(r.Header.Get("Origin")); origin != "" {
		return origin
	}
	return originOfReferer(r.Header.Get("Referer"))
}

func originOfReferer(referer string) string {
	parsed, err := url.Parse(strings.TrimSpace(referer))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return ""
	}
	return parsed.Scheme + "://" + parsed.Host
}

func sameOrigin(a *url.URL, allowed string) bool {
	if allowed == "" {
		return false
	}
	b, err := url.Parse(allowed)
	if err != nil {
		return false
	}
	return strings.EqualFold(a.Scheme, b.Scheme) && strings.EqualFold(a.Host, b.Host)
}

func firstHeaderValue(value string) string {
	if value == "" {
		return ""
	}
	return strings.TrimSpace(strings.Split(value, ",")[0])
}
