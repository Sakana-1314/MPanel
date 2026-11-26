package httpapi

import (
	"net/http"
	"strings"
)

// CORSConfig 控制浏览器跨源访问面板。
//
// 面板只用 Authorization: Bearer 鉴权，不使用 Cookie，因此浏览器不会自动
// 携带凭据。无差别允许任意来源是安全的：第三方页面即使能发起请求，没有
// token 也只会拿到 401，无法以访问者身份读取数据。这也意味着任何前端
// （静态站、桌面壳、第三方集成）都能直接调用接口。
//
// 响应里不设置 Access-Control-Allow-Credentials —— 携带凭据的跨源请求会被
// 浏览器拒绝，正好与「不要 Cookie」保持一致。
type CORSConfig struct {
	// Allowed 为空表示允许任意来源（默认）。显式列出时只允许这些来源。
	Allowed []string
	// VaryOrigin 为真时按来源回显并加 Vary: Origin，便于中间缓存正确分片。
	VaryOrigin bool
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

// Middleware applies CORS headers. Preflights are answered without reaching
// the wrapped handler.
func (c CORSConfig) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c.writeHeaders(w, r)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (c CORSConfig) writeHeaders(w http.ResponseWriter, r *http.Request) {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	allowOrigin := "*"
	if len(c.Allowed) > 0 {
		allowed := false
		for _, item := range c.Allowed {
			if item == "*" {
				// 显式 * 与默认策略等价，直接回 *。
				w.Header().Set("Access-Control-Allow-Origin", "*")
				w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
				w.Header().Set("Access-Control-Allow-Headers", "Authorization,Content-Type,X-MPanel-Token,X-Requested-With,X-Request-Id")
				w.Header().Set("Access-Control-Max-Age", "600")
				w.Header().Add("Vary", "Origin")
				return
			}
			if strings.EqualFold(item, origin) {
				allowed = true
				break
			}
		}
		if !allowed {
			return
		}
		// 白名单模式按来源回显，兼容需要精确匹配的中间件。
		if origin != "" {
			allowOrigin = origin
		}
	} else if c.VaryOrigin && origin != "" {
		allowOrigin = origin
	}
	w.Header().Set("Access-Control-Allow-Origin", allowOrigin)
	w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Authorization,Content-Type,X-MPanel-Token,X-Requested-With,X-Request-Id")
	w.Header().Set("Access-Control-Max-Age", "600")
	w.Header().Add("Vary", "Origin")
}

// OriginAllowed 供 WebSocket 升级使用：WS 不经过 CORS 头，但同样要判断来源。
// 默认放行；显式白名单时按名单校验。带 ticket/token 才可能建成连接。
func (c CORSConfig) OriginAllowed(r *http.Request) bool {
	if len(c.Allowed) == 0 {
		return true
	}
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return true
	}
	for _, item := range c.Allowed {
		if item == "*" || strings.EqualFold(item, origin) {
			return true
		}
	}
	return false
}
