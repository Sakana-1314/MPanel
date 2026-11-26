package agent

import (
	"context"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/sakana-1314/mpanel/server/core/config"
	"github.com/sakana-1314/mpanel/server/core/protocol"
)

// Prober detects optional host tooling with a short TTL cache.
type Prober struct {
	mu      sync.Mutex
	cfg     *config.Agent
	runner  Runner
	cached  protocol.Capabilities
	checked time.Time
	ttl     time.Duration
}

// NewProber creates a capability prober.
func NewProber(cfg *config.Agent, runner Runner) *Prober {
	return &Prober{cfg: cfg, runner: runner, ttl: 30 * time.Second}
}

// Get returns the capability set, refreshing when refresh is true or the cache
// is older than the TTL. Probing never returns an error.
func (p *Prober) Get(refresh bool) protocol.Capabilities {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !refresh && !p.checked.IsZero() && time.Since(p.checked) < p.ttl {
		return p.cached
	}
	p.cached = p.probe()
	p.checked = time.Now()
	return p.cached
}

func (p *Prober) probe() protocol.Capabilities {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	caps := protocol.Capabilities{
		Caddy:    p.probeTool(ctx, p.cfg.Agent.CaddyBin, "caddy", []string{"version"}),
		Docker:   p.probeTool(ctx, p.cfg.Agent.DockerBin, "docker", []string{"version", "--format", "{{.Server.Version}}"}),
		Postgres: p.probePostgres(ctx),
		Redis:    p.probeTool(ctx, p.cfg.Agent.RedisCLIBin, "redis-cli", []string{"--version"}),
		PTY:      platformPTY(),
	}
	return caps
}

func (p *Prober) probeTool(ctx context.Context, bin, label string, args []string) protocol.CapabilityStatus {
	if strings.TrimSpace(bin) == "" {
		bin = label
	}
	res, err := p.runner.RunTimeout(ctx, 8*time.Second, bin, args...)
	if err != nil {
		return protocol.CapabilityStatus{Available: false, Reason: "未找到 " + label + "：" + err.Error()}
	}
	if res.Code != 0 {
		msg := strings.TrimSpace(res.Stderr)
		if msg == "" {
			msg = strings.TrimSpace(res.Stdout)
		}
		return protocol.CapabilityStatus{Available: false, Reason: label + " 不可用：" + firstLine(msg)}
	}
	out := strings.TrimSpace(res.Stdout)
	if out == "" {
		out = strings.TrimSpace(res.Stderr)
	}
	return protocol.CapabilityStatus{Available: true, Version: firstLine(out)}
}

func (p *Prober) probePostgres(ctx context.Context) protocol.CapabilityStatus {
	dump, err := p.runner.RunTimeout(ctx, 8*time.Second, p.cfg.Agent.PGDumpBin, "--version")
	if err != nil || dump.Code != 0 {
		return protocol.CapabilityStatus{Available: false, Reason: "未找到 pg_dump"}
	}
	psql, err := p.runner.RunTimeout(ctx, 8*time.Second, p.cfg.Agent.PSQLBin, "--version")
	if err != nil || psql.Code != 0 {
		return protocol.CapabilityStatus{Available: false, Reason: "未找到 psql"}
	}
	return protocol.CapabilityStatus{Available: true, Version: firstLine(dump.Stdout)}
}

func platformPTY() protocol.CapabilityStatus {
	if runtime.GOOS == "windows" {
		return protocol.CapabilityStatus{Available: false, Reason: "Windows 上无 PTY，终端降级为管道模式"}
	}
	return protocol.CapabilityStatus{Available: true}
}

func firstLine(s string) string {
	line := strings.TrimSpace(s)
	if idx := strings.IndexByte(line, '\n'); idx >= 0 {
		line = line[:idx]
	}
	if len(line) > 160 {
		line = line[:160]
	}
	return line
}
