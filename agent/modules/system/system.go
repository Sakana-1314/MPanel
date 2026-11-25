// Package system exposes host identity, snapshots and live metrics.
package system

import (
	"net/http"
	"os"
	"runtime"
	"time"

	"github.com/sakana-1314/mpanel/agent"
	"github.com/sakana-1314/mpanel/core/httpapi"
	"github.com/sakana-1314/mpanel/core/protocol"
)

// Module implements /system/info, /system/snapshot and /system/metrics.
type Module struct{}

// New returns the system module.
func New() *Module { return &Module{} }

// Name implements agent.Module.
func (m *Module) Name() string { return "system" }

// Register implements agent.Module.
func (m *Module) Register(ctx *agent.Context) error {
	ctx.Mux.HandleFunc("GET /api/v1/system/info", func(w http.ResponseWriter, r *http.Request) {
		refresh := r.URL.Query().Get("refresh") == "1"
		httpapi.OK(w, buildInfo(ctx, refresh))
	})
	ctx.Mux.HandleFunc("GET /api/v1/system/snapshot", func(w http.ResponseWriter, r *http.Request) {
		httpapi.OK(w, buildSnapshot(ctx))
	})
	ctx.Mux.HandleFunc("GET /api/v1/system/metrics", func(w http.ResponseWriter, r *http.Request) {
		httpapi.OK(w, buildMetrics(ctx))
	})
	return nil
}

func buildInfo(ctx *agent.Context, refresh bool) protocol.SystemInfo {
	hostname, _ := os.Hostname()
	caps := ctx.Caps.Get(refresh)
	desc := protocol.WorkerDescriptor{
		Name:            hostname,
		Version:         ctx.Version,
		APIVersion:      protocol.APIVersion,
		ProtocolVersion: protocol.ProtocolVersion,
		NodeVersion:     runtime.Version(),
		Platform:        runtime.GOOS,
		Arch:            runtime.GOARCH,
		Capabilities: map[string]any{
			"caddy": caps.Caddy.Available, "docker": caps.Docker.Available,
			"postgres": caps.Postgres.Available, "redis": caps.Redis.Available, "pty": caps.PTY.Available,
		},
	}
	caddyConf, caddyData := ctx.Cfg.CaddyDirs()
	roots := make([]string, 0, len(ctx.Cfg.Agent.FilesRoots))
	for _, root := range ctx.Cfg.Agent.FilesRoots {
		roots = append(roots, root.Path)
	}
	return protocol.SystemInfo{
		Role:            "worker",
		Name:            hostname,
		Version:         ctx.Version,
		APIVersion:      protocol.APIVersion,
		ProtocolVersion: protocol.ProtocolVersion,
		NodeVersion:     runtime.Version(),
		Platform:        runtime.GOOS,
		Arch:            runtime.GOARCH,
		Hostname:        hostname,
		StartedAt:       ctx.Started.UTC().Format(time.RFC3339),
		UptimeSec:       int64(time.Since(ctx.Started).Seconds()),
		Capabilities:    caps,
		Worker:          &desc,
		Features: protocol.SystemFeatures{
			DBXHandoff: true,
			WebSocket:  true,
			PTY:        caps.PTY.Available,
		},
		Paths: &protocol.SystemPaths{
			Home:        ctx.Cfg.Agent.BaseDir,
			CaddyConfig: caddyConf,
			CaddyData:   caddyData,
			FilesRoots:  roots,
			Backups:     ctx.Cfg.Agent.DataDir + "/backups",
			Stacks:      ctx.Cfg.Agent.DataDir + "/stacks",
		},
	}
}

func buildSnapshot(ctx *agent.Context) protocol.SystemSnapshot {
	hostname, _ := os.Hostname()
	caps := ctx.Caps.Get(false)
	memTotal, memFree := hostMemory()
	diskTotal, diskFree := diskUsage(ctx.Cfg.Agent.DataDir)
	return protocol.SystemSnapshot{
		CollectedAt:    time.Now().UTC().Format(time.RFC3339),
		Hostname:       hostname,
		Platform:       runtime.GOOS,
		Arch:           runtime.GOARCH,
		Release:        hostRelease(),
		NodeVersion:    runtime.Version(),
		WorkerVersion:  ctx.Version,
		UptimeSec:      hostUptime(),
		CPUCount:       runtime.NumCPU(),
		Loadavg:        hostLoad(),
		MemTotalBytes:  memTotal,
		MemFreeBytes:   memFree,
		DiskTotalBytes: diskTotal,
		DiskFreeBytes:  diskFree,
		IPs:            hostIPs(),
		Transport:      ctx.Cfg.Agent.Transport,
		PTY:            caps.PTY.Available,
	}
}

func buildMetrics(ctx *agent.Context) protocol.SystemMetrics {
	memTotal, memFree := hostMemory()
	diskTotal, diskFree := diskUsage(ctx.Cfg.Agent.DataDir)
	return protocol.SystemMetrics{
		CollectedAt:    time.Now().UTC().Format(time.RFC3339),
		CPUPercent:     cpuPercent(),
		CPUCount:       runtime.NumCPU(),
		Loadavg:        hostLoad(),
		MemTotalBytes:  memTotal,
		MemFreeBytes:   memFree,
		DiskTotalBytes: diskTotal,
		DiskFreeBytes:  diskFree,
		UptimeSec:      hostUptime(),
	}
}
