package agent

import (
	"context"
	"errors"
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
	docker := p.probeTool(ctx, p.cfg.Agent.DockerBin, "docker", []string{"version", "--format", "{{.Server.Version}}"})
	caps := protocol.Capabilities{
		Caddy:    p.probeCaddy(ctx, docker),
		Docker:   docker,
		Postgres: p.probePostgres(ctx),
		Redis:    p.probeTool(ctx, p.cfg.Agent.RedisCLIBin, "redis-cli", []string{"--version"}),
		PTY:      platformPTY(),
	}
	return caps
}

// probeCaddy reports whether the managed Caddy container is running. Caddy is
// deployed as a Docker Compose stack (web/store), never as a host binary, so
// the capability mirrors container health instead of a PATH lookup.
func (p *Prober) probeCaddy(ctx context.Context, docker protocol.CapabilityStatus) protocol.CapabilityStatus {
	if !docker.Available {
		reason := "Caddy 以 Docker 容器运行，需要先启用 Docker"
		if strings.TrimSpace(docker.Reason) != "" {
			reason += "：" + docker.Reason
		}
		return protocol.CapabilityStatus{Available: false, Reason: reason}
	}
	container, err := FindRunningContainer(ctx, p.runner, p.cfg.Agent.DockerBin,
		config.CaddyStackName, config.CaddyServiceName)
	if err != nil {
		if errors.Is(err, ErrContainerNotFound) {
			return protocol.CapabilityStatus{
				Available: false,
				Reason:    "Caddy 容器未部署；在面板「站点」页一键安装 Docker 编排。",
			}
		}
		return protocol.CapabilityStatus{
			Available: false,
			Reason:    "无法查询 Caddy 容器：" + firstLine(err.Error()),
		}
	}
	bin := strings.TrimSpace(p.cfg.Agent.DockerBin)
	if bin == "" {
		bin = "docker"
	}
	res, err := p.runner.RunTimeout(ctx, 8*time.Second, bin, "exec", container.ID, "caddy", "version")
	if err != nil {
		return protocol.CapabilityStatus{
			Available: false,
			Reason:    "Caddy 容器运行中，但 caddy 命令不可用：" + firstLine(err.Error()),
		}
	}
	if res.Code != 0 {
		message := firstLine(res.Stderr)
		if message == "" {
			message = firstLine(res.Stdout)
		}
		if message == "" {
			message = "caddy version 退出码非 0"
		}
		return protocol.CapabilityStatus{
			Available: false,
			Reason:    "Caddy 容器运行中，但 caddy 命令不可用：" + message,
		}
	}
	version := firstLine(res.Stdout)
	if version == "" {
		version = firstLine(res.Stderr)
	}
	return protocol.CapabilityStatus{Available: true, Version: version}
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
