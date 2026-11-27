package sites

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/sakana-1314/mpanel/server/agent"
	"github.com/sakana-1314/mpanel/server/core/config"
	"github.com/sakana-1314/mpanel/server/core/httpapi"
	"github.com/sakana-1314/mpanel/server/core/protocol"
)

const (
	// Caddy runs as a container from the managed mpanel-caddy compose stack;
	// these are the in-container mount points the agent writes through.
	caddyContainerConfigRoot = "/etc/caddy"
	caddyContainerDataRoot   = "/data"
	caddyContainerLogRoot    = "/var/log/caddy"
	// caddyPlaceholder keeps `import sites.d/*.caddy` matching at least one
	// file even when no site is enabled. Caddy treats an empty glob as an
	// error, which would make the container fail to start or reload.
	caddyPlaceholder = "00-placeholder.caddy"
)

const caddyPlaceholderContent = "# Managed by MPanel: keeps import sites.d/*.caddy valid when no site is configured.\n"

// ensureCaddyPlaceholder writes an empty fragment when dir has no *.caddy
// files. Callers must have created dir.
func ensureCaddyPlaceholder(dir string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".caddy") {
			return nil
		}
	}
	return os.WriteFile(filepath.Join(dir, caddyPlaceholder), []byte(caddyPlaceholderContent), 0o644)
}

const caddyInstallHint = "在「站点」页一键安装 Caddy 容器编排（需要 Docker 与 Docker Compose v2）；安装完成后刷新页面重试。"

func (m *Module) dockerBin() string {
	if m.ctx != nil && m.ctx.Cfg != nil {
		if bin := strings.TrimSpace(m.ctx.Cfg.Agent.DockerBin); bin != "" {
			return bin
		}
	}
	return "docker"
}

// caddyContainer locates the running managed Caddy container. The capability
// probe already gates requests, but the container can stop between the probe
// (30s cache) and the command, so every write resolves it again.
func (m *Module) caddyContainer(ctx context.Context) (agent.DockerContainer, *protocol.PanelError) {
	container, err := agent.FindRunningContainer(ctx, m.ctx.Runner, m.dockerBin(),
		config.CaddyStackName, config.CaddyServiceName)
	if err != nil {
		if errors.Is(err, agent.ErrContainerNotFound) {
			return agent.DockerContainer{}, caddyUnavailable("Caddy 容器未部署")
		}
		return agent.DockerContainer{}, &protocol.PanelError{
			Code:    protocol.CodeUnavailable,
			Message: "Caddy 容器不可用",
			Details: map[string]any{"reason": err.Error()},
			Hint:    caddyInstallHint,
		}
	}
	return container, nil
}

// runCaddy executes a caddy subcommand inside the managed container.
func (m *Module) runCaddy(ctx context.Context, containerID string, args ...string) (agent.Result, error) {
	full := append([]string{"exec", containerID, "caddy"}, args...)
	return m.ctx.Runner.RunTimeout(ctx, caddyTimeout, m.dockerBin(), full...)
}

// containerPath maps a host path under the managed config directory to the
// corresponding path inside the Caddy container.
func (m *Module) containerPath(hostPath string) (string, *protocol.PanelError) {
	confDir, _ := m.ctx.Cfg.CaddyDirs()
	return containerPathUnder(confDir, caddyContainerConfigRoot, hostPath)
}

func containerPathUnder(hostRoot, containerRoot, hostPath string) (string, *protocol.PanelError) {
	hostAbs, err := filepath.Abs(hostPath)
	if err != nil {
		return "", internalFailure("无法解析 Caddy 配置路径", err)
	}
	rootAbs, err := filepath.Abs(hostRoot)
	if err != nil {
		return "", internalFailure("无法解析 Caddy 配置目录", err)
	}
	rel, err := filepath.Rel(rootAbs, hostAbs)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", &protocol.PanelError{
			Code:    protocol.CodeInternal,
			Message: "Caddy 配置路径不在受管目录内",
			Details: map[string]any{"path": hostPath, "root": hostRoot},
		}
	}
	if rel == "." {
		return containerRoot, nil
	}
	return path.Join(containerRoot, filepath.ToSlash(rel)), nil
}

func caddyUnavailable(reason string) *protocol.PanelError {
	if strings.TrimSpace(reason) == "" {
		reason = "Caddy 容器未运行"
	}
	return &protocol.PanelError{
		Code:    protocol.CodeUnavailable,
		Message: "Caddy 容器未就绪，站点功能不可用",
		Details: map[string]any{"reason": reason},
		Hint:    caddyInstallHint,
	}
}

func (m *Module) caddyUnavailable() *protocol.PanelError {
	reason := ""
	if m.ctx != nil && m.ctx.Caps != nil {
		capability := m.ctx.Caps.Get(false).Caddy
		reason = capability.Reason
	}
	return caddyUnavailable(reason)
}

func (m *Module) caddyReason() string {
	if m.ctx != nil && m.ctx.Caps != nil {
		if reason := strings.TrimSpace(m.ctx.Caps.Get(false).Caddy.Reason); reason != "" {
			return reason
		}
	}
	return "Caddy 容器未运行"
}

// requireCaddy gates an endpoint: every /sites operation is unavailable until
// the managed Caddy container is deployed.
func (m *Module) requireCaddy(w http.ResponseWriter) bool {
	if m.ctx.Caps.Get(false).Caddy.Available {
		return true
	}
	httpapi.Fail(w, m.caddyUnavailable())
	return false
}
