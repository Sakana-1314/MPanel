package sites

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/sakana-1314/mpanel/server/agent"
	"github.com/sakana-1314/mpanel/server/core/config"
	"github.com/sakana-1314/mpanel/server/core/protocol"
)

const (
	caddyTimeout    = 60 * time.Second
	defaultCaddyAdm = "127.0.0.1:2019"
	outputTailBytes = 4000
)

type renderedSite struct {
	site    Site
	content string
	hash    string
}

// managedCaddyfile is the root Caddyfile. The global options block keeps the
// file valid even when sites.d has no fragments (Caddy rejects a Caddyfile
// whose entire body is an import that matches nothing).
func managedCaddyfile(admin string) string {
	var b strings.Builder
	b.WriteString("# Managed by MPanel. Do not edit by hand.\n")
	b.WriteString("{\n")
	b.WriteString("\tadmin ")
	b.WriteString(admin)
	b.WriteString("\n}\n\n")
	b.WriteString("import sites.d/*.caddy\n")
	return b.String()
}

func adminAddress(cfg *config.Agent) string {
	addr := strings.TrimSpace(cfg.Agent.CaddyAdmin)
	if addr == "" {
		return defaultCaddyAdm
	}
	if hasUnsafeTokenRune(addr) || strings.ContainsAny(addr, "{}#") || strings.Contains(addr, "://") {
		return defaultCaddyAdm
	}
	return addr
}

func (m *Module) caddyBin() string {
	bin := strings.TrimSpace(m.ctx.Cfg.Agent.CaddyBin)
	if bin == "" {
		return "caddy"
	}
	return bin
}

func (m *Module) caddyAvailable() bool {
	return m.ctx.Caps.Get(false).Caddy.Available
}

func caddyUnavailable() *protocol.PanelError {
	return protocol.Unavailable(
		"Caddy 不可用，无法应用站点配置",
		"安装 Caddy，或在 conf/agent.yaml 将 caddy_bin 指向 caddy 可执行文件后重启 agent。",
	)
}

// runCaddy executes a caddy subcommand with a timeout and argument array.
func (m *Module) runCaddy(ctx context.Context, args ...string) (agent.Result, error) {
	return m.ctx.Runner.RunTimeout(ctx, caddyTimeout, m.caddyBin(), args...)
}

type applyPlan struct {
	siteIDs []string
	partial bool
	force   bool
}

// apply implements contract §6.4.
func (m *Module) apply(rctx context.Context, plan applyPlan) (SiteApplyResult, error) {
	if !m.applyMu.TryLock() {
		return SiteApplyResult{}, &protocol.PanelError{
			Code:    protocol.CodeConflict,
			Message: "已有站点 apply 正在进行",
			Details: map[string]any{"retryAfterMs": 2000},
		}
	}
	defer m.applyMu.Unlock()

	if !m.caddyAvailable() {
		return SiteApplyResult{}, caddyUnavailable()
	}

	all := m.store.List()
	byID := make(map[string]Site, len(all))
	for _, site := range all {
		byID[site.ID] = site
	}

	selected := make([]Site, 0, len(all))
	if !plan.partial {
		for _, site := range all {
			if site.Enabled {
				selected = append(selected, site)
			}
		}
	} else {
		if len(plan.siteIDs) == 0 {
			return SiteApplyResult{}, protocol.BadRequest("siteIds 不能为空；省略 siteIds 表示全量 apply")
		}
		seen := map[string]bool{}
		missing := make([]string, 0)
		for _, id := range plan.siteIDs {
			if seen[id] {
				continue
			}
			seen[id] = true
			site, ok := byID[id]
			if !ok {
				missing = append(missing, id)
				continue
			}
			selected = append(selected, site)
		}
		if len(missing) > 0 {
			return SiteApplyResult{}, &protocol.PanelError{
				Code:    protocol.CodeNotFound,
				Message: "站点不存在",
				Details: map[string]any{"ids": missing},
			}
		}
	}

	at := time.Now().UTC()
	rendered := make([]renderedSite, 0, len(selected))
	renderedByID := make(map[string]string, len(selected))
	warnings := []string{}
	var renderIssues []string
	for _, site := range selected {
		if !site.Enabled {
			warnings = append(warnings, "站点 "+site.Name+" 已禁用，本次不渲染")
			continue
		}
		content, siteWarnings, err := renderSite(site, m.roots())
		if err != nil {
			renderIssues = append(renderIssues, site.Name+": "+err.Error())
			continue
		}
		warnings = append(warnings, siteWarnings...)
		hash := hashCaddyfile(content)
		rendered = append(rendered, renderedSite{site: site, content: content, hash: hash})
		renderedByID[site.ID] = content
	}
	if len(renderIssues) > 0 {
		return SiteApplyResult{}, &protocol.PanelError{
			Code:    protocol.CodeBadRequest,
			Message: "站点渲染失败，未修改线上配置",
			Details: map[string]any{"stage": "render", "issues": renderIssues},
		}
	}

	confDir, _ := m.ctx.Cfg.CaddyDirs()
	liveDir := filepath.Join(confDir, "sites.d")
	rootPath := filepath.Join(confDir, "Caddyfile")
	if err := os.MkdirAll(confDir, 0o755); err != nil {
		return SiteApplyResult{}, internalFailure("无法创建 Caddy 配置目录", err)
	}
	staging, err := os.MkdirTemp(confDir, ".staging-")
	if err != nil {
		return SiteApplyResult{}, internalFailure("无法创建 staging 目录", err)
	}
	defer os.RemoveAll(staging)
	stagingSites := filepath.Join(staging, "sites.d")
	if err := os.MkdirAll(stagingSites, 0o755); err != nil {
		return SiteApplyResult{}, internalFailure("无法创建 staging/sites.d", err)
	}
	if err := copyTree(liveDir, stagingSites); err != nil {
		return SiteApplyResult{}, internalFailure("无法复制现有站点片段", err)
	}

	if plan.partial {
		for _, site := range selected {
			if !site.Enabled {
				_ = os.Remove(filepath.Join(stagingSites, site.ID+".caddy"))
			}
		}
	} else {
		entries, err := os.ReadDir(stagingSites)
		if err != nil {
			return SiteApplyResult{}, internalFailure("无法读取 staging 目录", err)
		}
		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".caddy") {
				continue
			}
			id := strings.TrimSuffix(entry.Name(), ".caddy")
			if _, ok := renderedByID[id]; !ok {
				if err := os.Remove(filepath.Join(stagingSites, entry.Name())); err != nil {
					return SiteApplyResult{}, internalFailure("无法清理过期站点片段", err)
				}
			}
		}
	}

	for _, item := range rendered {
		path := filepath.Join(stagingSites, item.site.ID+".caddy")
		if err := config.WriteFileAtomic(path, []byte(item.content), 0o644); err != nil {
			return SiteApplyResult{}, internalFailure("无法写入 staging 站点片段", err)
		}
	}

	admin := adminAddress(m.ctx.Cfg)
	rootContent := managedCaddyfile(admin)
	stagingRoot := filepath.Join(staging, "Caddyfile")
	if err := config.WriteFileAtomic(stagingRoot, []byte(rootContent), 0o644); err != nil {
		return SiteApplyResult{}, internalFailure("无法写入 staging Caddyfile", err)
	}

	changed := m.applyChanged(plan, stagingSites, liveDir, rootPath, rootContent, rendered)
	if !changed {
		warnings = append(warnings, "没有检测到需要应用的变更；已跳过 apply（force=true 可强制重写）")
		return SiteApplyResult{
			Revision:      m.store.ApplyRevision(),
			AppliedAt:     at.Format(time.RFC3339),
			CaddyfilePath: rootPath,
			BackupPath:    nil,
			Reloaded:      false,
			RolledBack:    false,
			Sites:         m.applyEntries(selected),
			Warnings:      warnings,
			CaddyOutput:   "",
		}, nil
	}

	validateOutput, err := m.validateConfigFile(rctx, stagingRoot)
	if err != nil {
		return SiteApplyResult{}, err
	}

	backupPath, err := m.backupCaddy(liveDir, rootPath, at)
	if err != nil {
		return SiteApplyResult{}, &protocol.PanelError{
			Code:    protocol.CodeUpstreamError,
			Message: "备份现有 Caddy 配置失败，未修改线上配置",
			Details: map[string]any{"stage": "backup", "rolledBack": false, "output": tailOutput(err.Error(), outputTailBytes)},
		}
	}

	revision, err := m.store.NextApplyRevision()
	if err != nil {
		return SiteApplyResult{}, internalFailure("无法分配 apply 序号", err)
	}

	oldDir := filepath.Join(confDir, fmt.Sprintf(".sites.d-old-%d", time.Now().UnixNano()))
	hadLive := pathIsDir(liveDir)
	if hadLive {
		if err := os.Rename(liveDir, oldDir); err != nil {
			return SiteApplyResult{}, m.failApply(revision, at, rendered, "无法移动现有 sites.d: "+err.Error(), "reload", false, "")
		}
		defer os.RemoveAll(oldDir)
	}
	if err := os.Rename(stagingSites, liveDir); err != nil {
		rollbackErr := restoreBackup(backupPath, liveDir, rootPath)
		if rollbackErr != nil {
			return SiteApplyResult{}, m.internalAfterFailure(revision, at, rendered, "替换 sites.d 失败且回滚失败", err, rollbackErr)
		}
		if hadLive {
			_ = os.RemoveAll(oldDir)
		}
		return SiteApplyResult{}, m.failApply(revision, at, rendered, "替换 sites.d 失败: "+err.Error(), "reload", true, "")
	}
	if err := config.WriteFileAtomic(rootPath, []byte(rootContent), 0o644); err != nil {
		rollbackErr := restoreBackup(backupPath, liveDir, rootPath)
		if rollbackErr != nil {
			return SiteApplyResult{}, m.internalAfterFailure(revision, at, rendered, "写入 Caddyfile 失败且回滚失败", err, rollbackErr)
		}
		return SiteApplyResult{}, m.failApply(revision, at, rendered, "写入 Caddyfile 失败: "+err.Error(), "reload", true, "")
	}

	reloadArgs := []string{"reload", "--config", rootPath, "--adapter", "caddyfile"}
	if adminCfg := strings.TrimSpace(m.ctx.Cfg.Agent.CaddyAdmin); adminCfg != "" {
		reloadArgs = append(reloadArgs, "--address", adminCfg)
	}
	reloadResult, reloadErr := m.runCaddy(rctx, reloadArgs...)
	reloadOutput := joinOutput(reloadResult.Stdout, reloadResult.Stderr)
	if reloadErr != nil {
		reloadOutput = joinOutput(reloadOutput, reloadErr.Error())
	}
	if reloadErr != nil || reloadResult.Code != 0 {
		if rollbackErr := restoreBackup(backupPath, liveDir, rootPath); rollbackErr != nil {
			return SiteApplyResult{}, m.internalAfterFailure(revision, at, rendered, "caddy reload 失败且回滚失败", reloadErr, rollbackErr)
		}
		restoreResult, restoreErr := m.runCaddy(rctx, reloadArgs...)
		if restoreErr != nil || restoreResult.Code != 0 {
			restoreOutput := joinOutput(restoreResult.Stdout, restoreResult.Stderr)
			if restoreErr != nil {
				restoreOutput = joinOutput(restoreOutput, restoreErr.Error())
			}
			return SiteApplyResult{}, m.internalAfterFailure(
				revision, at, rendered,
				"caddy reload 失败，回滚后重新加载也失败",
				fmt.Errorf("%v", reloadErr),
				fmt.Errorf("%s", tailOutput(restoreOutput, outputTailBytes)),
			)
		}
		return SiteApplyResult{}, m.failApply(revision, at, rendered, "caddy reload 失败: "+tailOutput(reloadOutput, outputTailBytes), "reload", true, reloadOutput)
	}

	records := make([]ApplyRecord, 0, len(rendered))
	for _, item := range rendered {
		records = append(records, ApplyRecord{
			SiteID:   item.site.ID,
			Revision: item.site.Revision,
			Hash:     item.hash,
			OK:       true,
		})
	}
	if err := m.store.RecordApply(revision, at, records); err != nil {
		return SiteApplyResult{}, internalFailure("配置已生效，但写入站点状态失败", err)
	}

	caddyOutput := tailOutput(joinOutput(validateOutput, reloadOutput), outputTailBytes)
	backup := backupPath
	return SiteApplyResult{
		Revision:      revision,
		AppliedAt:     at.Format(time.RFC3339),
		CaddyfilePath: rootPath,
		BackupPath:    &backup,
		Reloaded:      true,
		RolledBack:    false,
		Sites:         m.applyEntries(selected),
		Warnings:      warnings,
		CaddyOutput:   caddyOutput,
	}, nil
}

// applyChanged decides whether the staged tree differs from the live tree or
// any selected site still has an unapplied revision.
func (m *Module) applyChanged(plan applyPlan, stagingSites, liveDir, rootPath, rootContent string, rendered []renderedSite) bool {
	if plan.force {
		return true
	}
	if !dirsEqual(stagingSites, liveDir) {
		return true
	}
	current, err := os.ReadFile(rootPath)
	if err != nil || string(current) != rootContent {
		return true
	}
	for _, item := range rendered {
		site := item.site
		if site.AppliedRevision == nil || *site.AppliedRevision != site.Revision || site.LastApply == nil || !site.LastApply.OK {
			return true
		}
	}
	return false
}

func (m *Module) validateConfigFile(ctx context.Context, configPath string) (string, error) {
	result, err := m.runCaddy(ctx, "validate", "--config", configPath, "--adapter", "caddyfile")
	output := joinOutput(result.Stdout, result.Stderr)
	if err != nil {
		output = joinOutput(output, err.Error())
	}
	if err != nil || result.Code != 0 {
		return output, &protocol.PanelError{
			Code:    protocol.CodeBadRequest,
			Message: "caddy validate 失败，线上配置未改变",
			Details: map[string]any{"stage": "validate", "output": tailOutput(output, outputTailBytes)},
		}
	}
	return output, nil
}

func (m *Module) backupCaddy(liveDir, rootPath string, at time.Time) (string, error) {
	base := filepath.Join(m.ctx.DataDir(), "backups", "caddy")
	if err := os.MkdirAll(base, 0o755); err != nil {
		return "", err
	}
	dir, err := os.MkdirTemp(base, at.Format("20060102-150405")+"-")
	if err != nil {
		return "", err
	}
	if fileExists(rootPath) {
		if err := copyFile(rootPath, filepath.Join(dir, "Caddyfile")); err != nil {
			return "", err
		}
	}
	if pathIsDir(liveDir) {
		if err := copyTree(liveDir, filepath.Join(dir, "sites.d")); err != nil {
			return "", err
		}
	}
	return dir, nil
}

// restoreBackup puts the backed-up Caddyfile and sites.d back in place.
func restoreBackup(backupPath, liveDir, rootPath string) error {
	if err := os.RemoveAll(liveDir); err != nil {
		return err
	}
	backupSites := filepath.Join(backupPath, "sites.d")
	if pathIsDir(backupSites) {
		if err := copyTree(backupSites, liveDir); err != nil {
			return err
		}
	} else if err := os.MkdirAll(liveDir, 0o755); err != nil {
		return err
	}
	backupRoot := filepath.Join(backupPath, "Caddyfile")
	if fileExists(backupRoot) {
		return copyFile(backupRoot, rootPath)
	}
	if err := os.Remove(rootPath); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// failApply records lastApply.ok=false and returns the upstream error.
func (m *Module) failApply(revision int, at time.Time, rendered []renderedSite, message, stage string, rolledBack bool, output string) error {
	m.recordFailure(revision, at, rendered, message)
	return &protocol.PanelError{
		Code:    protocol.CodeUpstreamError,
		Message: message,
		Details: map[string]any{
			"stage":      stage,
			"rolledBack": rolledBack,
			"output":     tailOutput(output, outputTailBytes),
		},
	}
}

func (m *Module) internalAfterFailure(revision int, at time.Time, rendered []renderedSite, message string, cause, rollback error) error {
	m.recordFailure(revision, at, rendered, message)
	detail := message
	if cause != nil {
		detail += ": " + cause.Error()
	}
	if rollback != nil {
		detail += "; 回滚: " + rollback.Error()
	}
	return internalFailure(message, fmt.Errorf("%s", detail))
}

func (m *Module) recordFailure(revision int, at time.Time, rendered []renderedSite, message string) {
	records := make([]ApplyRecord, 0, len(rendered))
	for _, item := range rendered {
		records = append(records, ApplyRecord{
			SiteID:   item.site.ID,
			Revision: item.site.Revision,
			Hash:     item.hash,
			OK:       false,
			Error:    message,
		})
	}
	if err := m.store.RecordApply(revision, at, records); err != nil && m.ctx.Logger != nil {
		m.ctx.Logger.Error("写入 apply 失败状态失败", "error", err.Error())
	}
}

func (m *Module) applyEntries(selected []Site) []SiteApplyEntry {
	entries := make([]SiteApplyEntry, 0, len(selected))
	for _, site := range selected {
		fresh, ok := m.store.Get(site.ID)
		if !ok {
			continue
		}
		entries = append(entries, SiteApplyEntry{ID: fresh.ID, Name: fresh.Name, Status: fresh.Status})
	}
	return entries
}

func internalFailure(message string, err error) *protocol.PanelError {
	details := map[string]any{}
	if err != nil {
		details["error"] = err.Error()
	}
	return &protocol.PanelError{Code: protocol.CodeInternal, Message: message, Details: details}
}
