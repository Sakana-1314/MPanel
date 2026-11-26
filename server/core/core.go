// Package core implements the control plane: authentication, machine registry,
// the three transports, the HTTP/WS proxy, edge enrollment/jobs, audit, and
// static hosting of the panel.
package core

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/sakana-1314/mpanel/server/core/auth"
	"github.com/sakana-1314/mpanel/server/core/config"
	"github.com/sakana-1314/mpanel/server/core/httpapi"
	"github.com/sakana-1314/mpanel/server/core/protocol"
	"github.com/sakana-1314/mpanel/server/core/tunnel"
)

// Core is the running control plane.
type Core struct {
	cfg       *config.App
	log       *slog.Logger
	auth      *auth.Service
	machines  *MachineManager
	edge      *EdgeService
	audit     *AuditLog
	tunnels   *tunnel.Server
	started   time.Time
	mux       *http.ServeMux
	upgrader  websocket.Upgrader
	static    *staticHandler
	cancel    context.CancelFunc
	closeOnce sync.Once
}

// New builds the control plane and starts background loops.
func New(cfg *config.App, logger *slog.Logger) (*Core, error) {
	if cfg == nil {
		return nil, errors.New("core 配置不能为空")
	}
	if logger == nil {
		logger = slog.Default()
	}
	if err := cfg.EnsureDirs(); err != nil {
		return nil, err
	}
	authSvc, err := auth.New(cfg, logger)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	c := &Core{
		cfg:      cfg,
		log:      logger,
		auth:     authSvc,
		tunnels:  tunnel.NewServer(logger),
		started:  time.Now(),
		mux:      http.NewServeMux(),
		cancel:   cancel,
		upgrader: websocket.Upgrader{ReadBufferSize: 32 * 1024, WriteBufferSize: 32 * 1024},
	}
	// WS 不走 CORS 中间件，因此单独用同一套来源策略校验 Origin。
	// agent 与脚本客户端不带 Origin，会被放行；浏览器跨站页面则被拒绝。
	c.upgrader.CheckOrigin = func(r *http.Request) bool {
		return c.corsConfig().OriginAllowed(r)
	}
	audit, err := NewAuditLog(filepath.Join(cfg.System.DBPath, "audit.jsonl"))
	if err != nil {
		cancel()
		return nil, err
	}
	c.audit = audit
	c.machines = NewMachineManager(cfg, logger, c.tunnels, c.audit)
	c.edge = NewEdgeService(cfg, logger, c.machines, c.audit)
	c.static = newStaticHandler(cfg, logger)
	c.registerRoutes()
	c.machines.Start(ctx)
	c.edge.Start(ctx)
	return c, nil
}

// Handler returns the full HTTP handler.
func (c *Core) Handler() http.Handler {
	var handler http.Handler = c.mux
	handler = c.authMiddleware(handler)
	handler = c.securityHeaders(handler)
	handler = c.corsMiddleware(handler)
	handler = httpapi.RequestID(handler)
	handler = httpapi.Recover(handler)
	return handler
}

// Close stops background loops and child processes.
func (c *Core) Close() {
	c.closeOnce.Do(func() {
		c.cancel()
		c.machines.Close()
		c.edge.Stop()
		_ = c.audit.Close()
	})
}

// Auth exposes the credential service (used by mpanelctl reset-password).
func (c *Core) Auth() *auth.Service { return c.auth }

func (c *Core) registerRoutes() {
	c.mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		httpapi.OK(w, map[string]any{"ok": true, "role": "core", "version": c.cfg.System.Version})
	})

	// Auth.
	c.mux.HandleFunc("POST /api/v1/auth/setup", c.handleSetup)
	c.mux.HandleFunc("POST /api/v1/auth/login", c.handleLogin)
	c.mux.HandleFunc("POST /api/v1/auth/logout", c.handleLogout)
	c.mux.HandleFunc("GET /api/v1/auth/me", c.handleMe)
	c.mux.HandleFunc("POST /api/v1/auth/password", c.handleChangePassword)
	c.mux.HandleFunc("GET /api/v1/auth/tokens", c.handleListTokens)
	c.mux.HandleFunc("POST /api/v1/auth/tokens", c.handleCreateToken)
	c.mux.HandleFunc("DELETE /api/v1/auth/tokens/{id}", c.handleRevokeToken)
	c.mux.HandleFunc("POST /api/v1/auth/ws-ticket", c.handleWSTicket)

	// System.
	c.mux.HandleFunc("GET /api/v1/system/info", c.handleSystemInfo)
	c.mux.HandleFunc("GET /api/v1/system/overview", c.handleOverview)
	c.mux.HandleFunc("GET /api/v1/system/audit", c.handleAudit)

	// Machines.
	c.mux.HandleFunc("GET /api/v1/machines", c.machines.handleList)
	c.mux.HandleFunc("POST /api/v1/machines", c.machines.handleCreate)
	c.mux.HandleFunc("GET /api/v1/machines/{id}", c.machines.handleGet)
	c.mux.HandleFunc("PATCH /api/v1/machines/{id}", c.machines.handleUpdate)
	c.mux.HandleFunc("DELETE /api/v1/machines/{id}", c.machines.handleDelete)
	c.mux.HandleFunc("POST /api/v1/machines/{id}/connect", c.machines.handleConnect)
	c.mux.HandleFunc("POST /api/v1/machines/{id}/disconnect", c.machines.handleDisconnect)
	c.mux.HandleFunc("POST /api/v1/machines/{id}/test", c.machines.handleTest)
	c.mux.HandleFunc("GET /api/v1/machines/{id}/health", c.machines.handleHealth)
	c.mux.HandleFunc("POST /api/v1/machines/{id}/secret/rotate", c.machines.handleRotate)

	// Proxy (WS subtree first, then the HTTP subtree).
	c.mux.HandleFunc("/api/v1/machines/{id}/proxy/ws/", c.handleProxyWS)
	c.mux.HandleFunc("/api/v1/machines/{id}/proxy/", c.handleProxyHTTP)

	// Edge.
	c.mux.HandleFunc("POST /api/v1/edge/enroll", c.edge.handleEnroll)
	c.mux.HandleFunc("GET /api/v1/edge/keys", c.edge.handleListKeys)
	c.mux.HandleFunc("POST /api/v1/edge/keys", c.edge.handleCreateKey)
	c.mux.HandleFunc("DELETE /api/v1/edge/keys/{id}", c.edge.handleRevokeKey)
	c.mux.HandleFunc("GET /api/v1/edge/jobs", c.edge.handleListJobs)
	c.mux.HandleFunc("POST /api/v1/edge/jobs", c.edge.handleCreateJob)
	c.mux.HandleFunc("GET /api/v1/edge/jobs/{id}", c.edge.handleGetJob)
	c.mux.HandleFunc("DELETE /api/v1/edge/jobs/{id}", c.edge.handleDeleteJob)

	// Machine reverse-ws registration.
	c.mux.HandleFunc("/ws/worker", c.handleWorkerWS)

	// Panel assets (SPA fallback), registered last via a catch-all.
	c.mux.Handle("/", c.static)
}

/* ------------------------------ middleware ------------------------------- */

type principalKey struct{}

func principalFrom(r *http.Request) (auth.Principal, bool) {
	value := r.Context().Value(principalKey{})
	p, ok := value.(auth.Principal)
	return p, ok
}

func (c *Core) authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		// Only the API and the agent registration socket need credentials; the
		// panel itself is a public static SPA (it authenticates with its own
		// login form and cookie).
		if !strings.HasPrefix(path, "/api/") && path != "/ws/worker" {
			next.ServeHTTP(w, r)
			return
		}
		if isPublicPath(path) || isProxyWSPath(path) || r.Method == http.MethodOptions {
			next.ServeHTTP(w, r)
			return
		}
		principal, err := c.authenticate(r)
		if err != nil {
			httpapi.Fail(w, err)
			return
		}
		if principal.AuthType == "token" && principal.Scope == "read" && httpapi.IsWriteMethod(r.Method) {
			httpapi.Fail(w, &protocol.PanelError{Code: protocol.CodeForbidden, Message: "该 token 只有只读权限"})
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), principalKey{}, principal)))
	})
}

func isPublicPath(path string) bool {
	switch path {
	case "/healthz", "/ws/worker", "/api/v1/auth/setup", "/api/v1/auth/login", "/api/v1/edge/enroll":
		return true
	}
	return false
}

// isProxyWSPath lets browser WebSocket upgrades reach handleProxyWS without an
// Authorization header. Browsers cannot set headers on WebSocket, so the route
// authenticates with the one-shot ticket (or a bearer query token) itself.
func isProxyWSPath(path string) bool {
	return strings.HasPrefix(path, "/api/v1/machines/") && strings.Contains(path, "/proxy/ws/")
}

// authenticate 按顺序尝试：静态 core token → 面板 API token → 会话 JWT。
// Bearer 是唯一凭据来源，服务端不再读取 Cookie。
func (c *Core) authenticate(r *http.Request) (auth.Principal, error) {
	token := bearer(r)
	if token == "" {
		return auth.Principal{}, &protocol.PanelError{Code: protocol.CodeUnauthorized, Message: "缺少 Authorization 凭据"}
	}
	if configured := os.Getenv("MPANEL_CORE_TOKEN"); configured != "" && constantTimeEqual(token, configured) {
		return auth.Principal{User: c.auth.User(), AuthType: "token", Scope: "write", Static: true}, nil
	}
	if principal, ok := c.auth.AuthenticateToken(token); ok {
		return principal, nil
	}
	claims, err := c.auth.VerifyJWT(token)
	if err != nil {
		return auth.Principal{}, err
	}
	// JWT 只证明签发过；会话仍需存在且未过期，这样修改密码/登出能立即失效。
	session, ok := c.auth.Session(claims.SessionID)
	if !ok {
		return auth.Principal{}, &protocol.PanelError{Code: protocol.CodeUnauthorized, Message: "会话已失效，请重新登录"}
	}
	return auth.Principal{
		User: auth.User{
			ID:          claims.UserID,
			Username:    session.Username,
			DisplayName: nil,
			Role:        session.Role,
		},
		AuthType:  "session",
		Scope:     "write",
		SessionID: session.ID,
	}, nil
}

// corsMiddleware 默认允许任意来源：面板只用 Authorization 头鉴权，浏览器
// 不会自动带凭据，因此放开跨源不会泄露数据。配置了 cors_origins 时改为白名单。
func (c *Core) corsMiddleware(next http.Handler) http.Handler {
	return c.corsConfig().Middleware(next)
}

// corsConfig 是 REST 与 WS 共用的来源策略。
func (c *Core) corsConfig() httpapi.CORSConfig {
	return httpapi.CORSConfig{
		Allowed:    httpapi.ParseCORSOrigins(c.cfg.System.CorsOrigins),
		VaryOrigin: c.cfg.System.CorsTrustForwarded,
	}
}

func (c *Core) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		w.Header().Set("X-Frame-Options", "SAMEORIGIN")
		next.ServeHTTP(w, r)
	})
}

/* -------------------------------- system --------------------------------- */

func (c *Core) handleSystemInfo(w http.ResponseWriter, r *http.Request) {
	httpapi.OK(w, c.systemInfo())
}

func (c *Core) systemInfo() protocol.SystemInfo {
	host, _ := os.Hostname()
	unavailable := func(reason string) protocol.CapabilityStatus {
		return protocol.CapabilityStatus{Available: false, Reason: reason}
	}
	return protocol.SystemInfo{
		Role:            "core",
		Name:            host,
		Version:         c.cfg.System.Version,
		APIVersion:      protocol.APIVersion,
		ProtocolVersion: protocol.ProtocolVersion,
		NodeVersion:     runtime.Version(),
		Platform:        runtime.GOOS,
		Arch:            runtime.GOARCH,
		Hostname:        host,
		StartedAt:       c.started.UTC().Format(time.RFC3339),
		UptimeSec:       int64(time.Since(c.started).Seconds()),
		Capabilities: protocol.Capabilities{
			Caddy:    unavailable("core 不直接管理 Caddy，请连接 agent"),
			Docker:   unavailable("core 不直接管理容器，请连接 agent"),
			Postgres: unavailable("core 不直接管理数据库，请连接 agent"),
			Redis:    unavailable("core 不直接管理数据库，请连接 agent"),
			PTY:      unavailable("core 不提供终端，请连接 agent"),
		},
		Features: protocol.SystemFeatures{DBXHandoff: true, WebSocket: true, PTY: false},
		Paths: &protocol.SystemPaths{
			Home:    c.cfg.System.BaseDir,
			Backups: c.cfg.System.BackupDir,
		},
	}
}

func (c *Core) handleOverview(w http.ResponseWriter, r *http.Request) {
	machines, err := c.machines.List()
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	counts := protocol.MachineCounts{Total: len(machines)}
	for _, machine := range machines {
		switch machine.Status {
		case protocol.StatusOnline:
			counts.Online++
		case protocol.StatusOffline:
			counts.Offline++
		case protocol.StatusStarting:
			counts.Starting++
		case protocol.StatusDegraded:
			counts.Degraded++
		case protocol.StatusError:
			counts.Error++
		}
	}
	httpapi.OK(w, protocol.SystemOverview{
		Core:        c.systemInfo(),
		Machines:    counts,
		Workers:     machines,
		GeneratedAt: time.Now().UTC().Format(time.RFC3339),
	})
}

func (c *Core) handleAudit(w http.ResponseWriter, r *http.Request) {
	items, err := c.audit.Query(r.URL.Query().Get("limit"), r.URL.Query().Get("cursor"))
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	httpapi.OK(w, items)
}

/* ----------------------------- reverse ws -------------------------------- */

func (c *Core) handleWorkerWS(w http.ResponseWriter, r *http.Request) {
	machine, err := c.machines.AuthenticateReverseWs(r)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	conn, err := c.upgrader.Upgrade(w, r, nil)
	if err != nil {
		c.log.Warn("worker ws upgrade 失败", "machineId", machine.ID, "error", err.Error())
		return
	}
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	_, data, err := conn.ReadMessage()
	if err != nil {
		c.log.Warn("worker ws 读取 hello 失败", "machineId", machine.ID, "error", err.Error())
		_ = conn.Close()
		return
	}
	frame, err := protocol.DecodeFrame(data)
	if err != nil || frame.Kind != protocol.FrameHello || frame.Role != "worker" {
		c.log.Warn("worker ws hello 无效", "machineId", machine.ID, "err", fmt.Sprint(err), "kind", frame.Kind, "role", frame.Role)
		_ = conn.Close()
		return
	}
	_ = conn.SetReadDeadline(time.Time{})
	// The tunnel outlives this HTTP handler: never use r.Context() here or the
	// session is closed the moment the upgrade handler returns.
	session, err := c.tunnels.ServeWebSocket(context.Background(), machine.ID, "reverse-ws", conn)
	if err != nil {
		_ = conn.Close()
		return
	}
	descriptor := frame.Worker
	c.log.Debug("worker ws 已注册", "machineId", machine.ID, "hasDescriptor", descriptor != nil)
	c.machines.MarkOnline(machine.ID, descriptor)
	c.audit.Write("machine.online", machine.ID, "ok", map[string]any{"transport": "reverse-ws"})
	go func() {
		<-session.Closed()
		c.machines.MarkOffline(machine.ID, "reverse-ws 连接已断开")
	}()
}

/* -------------------------------- helpers -------------------------------- */

func bearer(r *http.Request) string {
	value := r.Header.Get("Authorization")
	if len(value) > 7 && strings.EqualFold(value[:7], "Bearer ") {
		return strings.TrimSpace(value[7:])
	}
	return ""
}

func constantTimeEqual(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	var diff byte
	for i := 0; i < len(a); i++ {
		diff |= a[i] ^ b[i]
	}
	return diff == 0
}

func (c *Core) clientIP(r *http.Request) string { return httpapi.ClientIP(r) }
