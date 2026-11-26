// Package jobs exposes the agent's background job list, detail and cancel
// endpoints. Long-running modules submit work through ctx.Jobs and return 202.
package jobs

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/sakana-1314/mpanel/server/agent"
	"github.com/sakana-1314/mpanel/server/core/httpapi"
	"github.com/sakana-1314/mpanel/server/core/protocol"
)

// Module implements /jobs.
type Module struct{}

// New returns the jobs module.
func New() *Module { return &Module{} }

// Name implements agent.Module.
func (m *Module) Name() string { return "jobs" }

// Register implements agent.Module.
func (m *Module) Register(ctx *agent.Context) error {
	ctx.Mux.HandleFunc("GET /api/v1/jobs", m.handleList(ctx))
	ctx.Mux.HandleFunc("GET /api/v1/jobs/{id}", m.handleGet(ctx))
	ctx.Mux.HandleFunc("POST /api/v1/jobs/{id}/cancel", m.handleCancel(ctx))
	return nil
}

func (m *Module) handleList(ctx *agent.Context) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		status := strings.TrimSpace(query.Get("status"))
		switch protocol.JobStatus(status) {
		case "", protocol.JobStatusQueued, protocol.JobStatusRunning,
			protocol.JobStatusSucceeded, protocol.JobStatusFailed, protocol.JobStatusCancelled:
		default:
			httpapi.Fail(w, protocol.BadRequest("status 必须是 queued、running、succeeded、failed 或 cancelled"))
			return
		}
		kind := strings.TrimSpace(query.Get("kind"))
		all := ctx.Jobs.List(status, kind)
		limit := 0
		if raw := strings.TrimSpace(query.Get("limit")); raw != "" {
			if parsed, err := strconv.Atoi(raw); err == nil {
				limit = parsed
			}
		}
		items, next, total := protocol.Page(all, limit, query.Get("cursor"))
		if items == nil {
			items = []protocol.Job{}
		}
		httpapi.OK(w, protocol.ListResult[protocol.Job]{
			Available:  true,
			Items:      items,
			NextCursor: next,
			Total:      &total,
		})
	}
}

func (m *Module) handleGet(ctx *agent.Context) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		job, ok := ctx.Jobs.Get(r.PathValue("id"))
		if !ok {
			httpapi.Fail(w, protocol.NotFound("任务", r.PathValue("id")))
			return
		}
		httpapi.OK(w, job)
	}
}

func (m *Module) handleCancel(ctx *agent.Context) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		job, ok := ctx.Jobs.Cancel(id)
		if !ok {
			httpapi.Fail(w, protocol.NotFound("任务", id))
			return
		}
		httpapi.OK(w, map[string]any{"cancelled": true, "job": job})
	}
}
