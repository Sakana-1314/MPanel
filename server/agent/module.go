// Package agent implements the feature agent: it registers modules on a
// standard ServeMux, serves them over HTTP, stdio or a reverse websocket, and
// provides the shared context modules use (command runner, capabilities,
// websocket registry, paths).
package agent

import (
	"context"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/sakana-1314/mpanel/server/core/config"
	"github.com/sakana-1314/mpanel/server/core/tunnel"
)

// Module is one feature area (sites, databases, containers, files, terminal,
// tasks, system). Register appends routes to the context's mux.
type Module interface {
	Name() string
	Register(ctx *Context) error
}

// WSHandler serves one upgraded WebSocket connection. It is the same type the
// tunnel uses, so one registry serves direct and tunneled upgrades.
type WSHandler = tunnel.WSHandler

// Context is what a module receives on registration.
type Context struct {
	Mux     *http.ServeMux
	WS      *WSRegistry
	Cfg     *config.Agent
	Runner  Runner
	Caps    *Prober
	Logger  *slog.Logger
	Started time.Time
	Version string
}

// DataDir returns the agent data root.
func (c *Context) DataDir() string { return c.Cfg.Agent.DataDir }

// WSRegistry maps path prefixes to WebSocket handlers. The same registry is
// used by direct HTTP upgrades and tunneled ws-open frames.
type WSRegistry struct {
	mu     sync.RWMutex
	routes []wsRoute
}

type wsRoute struct {
	prefix  string
	handler WSHandler
}

// NewWSRegistry creates an empty registry.
func NewWSRegistry() *WSRegistry { return &WSRegistry{} }

// Handle registers a handler for a path prefix (e.g. "/ws/terminal/").
func (r *WSRegistry) Handle(prefix string, handler WSHandler) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.routes = append(r.routes, wsRoute{prefix: prefix, handler: handler})
}

// MatchWS resolves the longest matching prefix.
func (r *WSRegistry) MatchWS(path string) (WSHandler, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var (
		best    WSHandler
		bestLen = -1
	)
	for _, route := range r.routes {
		if len(path) >= len(route.prefix) && path[:len(route.prefix)] == route.prefix && len(route.prefix) > bestLen {
			best = route.handler
			bestLen = len(route.prefix)
		}
	}
	return best, best != nil
}

// Runner executes external commands with argument arrays (never a shell).
type Runner interface {
	Run(ctx context.Context, name string, args ...string) (Result, error)
	RunTimeout(ctx context.Context, timeout time.Duration, name string, args ...string) (Result, error)
	Stream(ctx context.Context, name string, args []string, onLine func(string)) (Result, error)
}

// Result is one command outcome.
type Result struct {
	Stdout string
	Stderr string
	Code   int
}
