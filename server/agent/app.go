package agent

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	"github.com/sakana-1314/mpanel/server/core/config"
	"github.com/sakana-1314/mpanel/server/core/httpapi"
	"github.com/sakana-1314/mpanel/server/core/protocol"
	"github.com/sakana-1314/mpanel/server/core/tunnel"
)

// App is the running agent: modules, auth, transports.
type App struct {
	cfg     *config.Agent
	log     *slog.Logger
	mux     *http.ServeMux
	ws      *WSRegistry
	runner  Runner
	caps    *Prober
	started time.Time
	tickets *ticketStore
	token   string
	host    string
}

// New builds the agent and registers modules.
func New(cfg *config.Agent, logger *slog.Logger, modules ...Module) (*App, error) {
	if cfg == nil {
		return nil, errors.New("agent 配置不能为空")
	}
	if logger == nil {
		logger = slog.Default()
	}
	if err := cfg.EnsureDirs(); err != nil {
		return nil, err
	}
	host, _ := os.Hostname()
	app := &App{
		cfg:     cfg,
		log:     logger,
		mux:     http.NewServeMux(),
		ws:      NewWSRegistry(),
		runner:  NewRunner(),
		caps:    NewProber(cfg, NewRunner()),
		started: time.Now(),
		tickets: newTicketStore(),
		token:   cfg.Agent.Token,
		host:    host,
	}
	if app.token == "" {
		app.token = protocol.RandomID(32)
		cfg.Agent.Token = app.token
		if err := config.SaveAgent(cfg); err != nil {
			return nil, err
		}
		app.log.Info("已生成 agent token 并写入 conf/agent.yaml")
	}
	app.mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		httpapi.OK(w, map[string]any{"ok": true, "role": "worker", "version": cfg.Agent.Version})
	})
	app.mux.HandleFunc("POST /api/v1/auth/ws-ticket", app.handleWSTicket)
	app.mux.HandleFunc("GET /api/v1/auth/me", func(w http.ResponseWriter, r *http.Request) {
		// Direct agent connections authenticate with a bearer token; the panel
		// only needs to know the connection is valid and what role it has.
		httpapi.OK(w, map[string]any{"authenticated": true, "role": "worker", "authType": "token"})
	})
	app.mux.HandleFunc("/ws/", app.handleWS)

	ctx := &Context{
		Mux:     app.mux,
		WS:      app.ws,
		Cfg:     cfg,
		Runner:  app.runner,
		Caps:    app.caps,
		Logger:  logger,
		Started: app.started,
		Version: cfg.Agent.Version,
	}
	for _, module := range modules {
		if err := module.Register(ctx); err != nil {
			return nil, errors.New("注册模块 " + module.Name() + " 失败: " + err.Error())
		}
		logger.Info("已注册模块", "module", module.Name())
	}
	return app, nil
}

// Token returns the local API token.
func (a *App) Token() string { return a.token }

// Prober exposes capability probing (used by the system module).
func (a *App) Prober() *Prober { return a.caps }

// Handler returns the HTTP handler with auth, CORS and recovery.
func (a *App) Handler() http.Handler {
	var handler http.Handler = a.mux
	handler = a.authMiddleware(handler)
	handler = httpapi.RequestID(handler)
	handler = httpapi.Recover(handler)
	return handler
}

// internalHandler serves tunneled requests. The tunnel is authenticated once by
// the core (machine secret), so individual requests must not be re-challenged
// for the local agent token; that token only guards direct HTTP access.
func (a *App) internalHandler() http.Handler {
	var handler http.Handler = a.mux
	handler = httpapi.RequestID(handler)
	handler = httpapi.Recover(handler)
	return handler
}

func (a *App) authMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		setCORS(w, r)
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		path := r.URL.Path
		if path == "/healthz" {
			next.ServeHTTP(w, r)
			return
		}
		// The handoff ticket in the body is the credential (contract §8.4);
		// requiring the agent token here would defeat the dbx iframe flow.
		if r.Method == http.MethodPost && path == "/api/v1/databases/handoff/redeem" {
			next.ServeHTTP(w, r)
			return
		}
		if strings.HasPrefix(path, "/ws/") {
			if !a.wsAuthorized(r) {
				httpapi.Fail(w, &protocol.PanelError{Code: protocol.CodeUnauthorized, Message: "WebSocket 需要 ticket 或 token"})
				return
			}
			next.ServeHTTP(w, r)
			return
		}
		if !a.tokenAuthorized(r) {
			httpapi.Fail(w, &protocol.PanelError{Code: protocol.CodeUnauthorized, Message: "缺少或无效的 agent token"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *App) tokenAuthorized(r *http.Request) bool {
	if raw := bearerToken(r); raw != "" && constantTimeEqual(raw, a.token) {
		return true
	}
	if raw := strings.TrimSpace(r.Header.Get("X-MPanel-Token")); raw != "" && constantTimeEqual(raw, a.token) {
		return true
	}
	return false
}

func (a *App) wsAuthorized(r *http.Request) bool {
	query := r.URL.Query()
	if ticket := query.Get("ticket"); ticket != "" {
		return a.tickets.redeem(ticket)
	}
	if token := query.Get("token"); token != "" && constantTimeEqual(token, a.token) {
		return true
	}
	return a.tokenAuthorized(r)
}

func (a *App) handleWSTicket(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	ticket, expiresAt := a.tickets.issue(path)
	httpapi.OK(w, map[string]any{"ticket": ticket, "expiresAt": expiresAt})
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  32 * 1024,
	WriteBufferSize: 32 * 1024,
	CheckOrigin:     func(*http.Request) bool { return true },
}

func (a *App) handleWS(w http.ResponseWriter, r *http.Request) {
	handler, ok := a.ws.MatchWS(r.URL.Path)
	if !ok {
		http.NotFound(w, r)
		return
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	handler(conn, r)
}

// WorkerDescriptor returns the hello descriptor for the tunnel.
func (a *App) WorkerDescriptor() protocol.WorkerDescriptor {
	caps := a.caps.Get(false)
	return protocol.WorkerDescriptor{
		Name:            a.host,
		Version:         a.cfg.Agent.Version,
		APIVersion:      protocol.APIVersion,
		ProtocolVersion: protocol.ProtocolVersion,
		NodeVersion:     runtime.Version(),
		Platform:        runtime.GOOS,
		Arch:            runtime.GOARCH,
		Capabilities: map[string]any{
			"caddy":    caps.Caddy.Available,
			"docker":   caps.Docker.Available,
			"postgres": caps.Postgres.Available,
			"redis":    caps.Redis.Available,
			"pty":      caps.PTY.Available,
		},
	}
}

// Run starts the configured transport and blocks until ctx is canceled.
func (a *App) Run(ctx context.Context) error {
	ctx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()

	transport := a.cfg.Agent.Transport
	switch transport {
	case "", "http":
		return a.runHTTP(ctx)
	case "stdio":
		client := tunnel.Client{
			Worker:    a.WorkerDescriptor(),
			Handler:   a.internalHandler(),
			WS:        a.ws,
			Logger:    a.log,
			MachineID: a.cfg.Agent.MachineID,
		}
		return client.ServeStdio(ctx, os.Stdin, os.Stdout)
	case "reverse-ws":
		identity, err := ResolveIdentity(ctx, a.cfg, a.log)
		if err != nil {
			return err
		}
		a.cfg.Agent.MachineID = identity.MachineID
		a.cfg.Agent.MachineSecret = identity.Secret
		a.log.Info("边缘/反向连接就绪", "machineId", identity.MachineID)
		client := tunnel.Client{
			MachineID: identity.MachineID,
			Secret:    identity.Secret,
			CoreURL:   a.cfg.Agent.CoreURL,
			Worker:    a.WorkerDescriptor(),
			Handler:   a.internalHandler(),
			WS:        a.ws,
			Logger:    a.log,
			OnConnect: func() { _ = config.SaveAgent(a.cfg) },
		}
		return client.Run(ctx)
	default:
		return errors.New("未知的传输模式: " + transport)
	}
}

func (a *App) runHTTP(ctx context.Context) error {
	listen := a.cfg.Agent.Listen
	server := &http.Server{
		Addr:              listen,
		Handler:           a.Handler(),
		ReadHeaderTimeout: 15 * time.Second,
	}
	errCh := make(chan error, 1)
	go func() {
		a.log.Info("agent 已启动", "listen", listen, "baseDir", a.cfg.Agent.BaseDir, "data", a.cfg.Agent.DataDir)
		errCh <- server.ListenAndServe()
	}()
	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return server.Shutdown(shutdownCtx)
	case err := <-errCh:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

// DataPath joins the agent data dir.
func (a *App) DataPath(parts ...string) string {
	all := append([]string{a.cfg.Agent.DataDir}, parts...)
	return filepath.Join(all...)
}

func setCORS(w http.ResponseWriter, r *http.Request) {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return
	}
	// The agent authenticates with a bearer token, not cookies, so reflecting
	// the origin does not grant anything without the token. Reflecting (rather
	// than "*") is required because the panel sends credentials: include.
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Access-Control-Allow-Credentials", "true")
	w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Authorization,Content-Type,X-MPanel-Token,X-Requested-With")
	w.Header().Set("Access-Control-Max-Age", "600")
	w.Header().Add("Vary", "Origin")
}

func bearerToken(r *http.Request) string {
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
