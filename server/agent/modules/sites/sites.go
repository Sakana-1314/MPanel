// Package sites implements the Caddy-backed sites module: structured site
// drafts persisted in sites.json, Caddyfile fragment rendering, preview,
// validate/backup/reload/rollback apply, and export/import (contract §6).
package sites

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"github.com/sakana-1314/mpanel/server/agent"
	"github.com/sakana-1314/mpanel/server/core/config"
	"github.com/sakana-1314/mpanel/server/core/httpapi"
	"github.com/sakana-1314/mpanel/server/core/protocol"
)

// Module implements /sites (contract §6).
type Module struct {
	ctx     *agent.Context
	store   *Store
	applyMu sync.Mutex
}

// New returns the sites module.
func New() *Module { return &Module{} }

// Name implements agent.Module.
func (m *Module) Name() string { return "sites" }

// Register implements agent.Module.
func (m *Module) Register(ctx *agent.Context) error {
	store, err := OpenStore(filepath.Join(ctx.DataDir(), "sites.json"))
	if err != nil {
		return err
	}
	m.ctx = ctx
	m.store = store

	ctx.Mux.HandleFunc("GET /api/v1/sites", m.handleList)
	ctx.Mux.HandleFunc("POST /api/v1/sites", m.handleCreate)
	ctx.Mux.HandleFunc("POST /api/v1/sites/bootstrap", m.handleBootstrap)
	ctx.Mux.HandleFunc("POST /api/v1/sites/preview", m.handlePreview)
	ctx.Mux.HandleFunc("POST /api/v1/sites/apply", m.handleApply)
	ctx.Mux.HandleFunc("GET /api/v1/sites/export", m.handleExport)
	ctx.Mux.HandleFunc("POST /api/v1/sites/import", m.handleImport)
	ctx.Mux.HandleFunc("GET /api/v1/sites/{id}", m.handleGet)
	ctx.Mux.HandleFunc("PUT /api/v1/sites/{id}", m.handleUpdate)
	// PATCH is accepted as an alias for PUT (the frontend uses PUT).
	ctx.Mux.HandleFunc("PATCH /api/v1/sites/{id}", m.handleUpdate)
	ctx.Mux.HandleFunc("DELETE /api/v1/sites/{id}", m.handleDelete)
	// Additive id-scoped aliases for convenience; the contract's canonical
	// endpoints above remain the single source of truth.
	ctx.Mux.HandleFunc("POST /api/v1/sites/{id}/preview", m.handlePreviewByID)
	ctx.Mux.HandleFunc("POST /api/v1/sites/{id}/apply", m.handleApplyByID)
	ctx.Mux.HandleFunc("GET /api/v1/sites/{id}/export", m.handleExportByID)
	return nil
}

type createInput struct {
	Name    string     `json:"name"`
	Enabled *bool      `json:"enabled,omitempty"`
	Config  SiteConfig `json:"config"`
}

type updateInput struct {
	Name    *string     `json:"name,omitempty"`
	Enabled *bool       `json:"enabled,omitempty"`
	Config  *SiteConfig `json:"config,omitempty"`
}

type previewInput struct {
	Site     *SiteConfig `json:"site,omitempty"`
	SiteID   string      `json:"siteId,omitempty"`
	Validate bool        `json:"validate,omitempty"`
}

type applyInput struct {
	SiteIDs []string `json:"siteIds,omitempty"`
	Force   bool     `json:"force,omitempty"`
}

type importInput struct {
	Bundle    *SiteExportBundle `json:"bundle,omitempty"`
	Mode      string            `json:"mode,omitempty"`
	Caddyfile string            `json:"caddyfile,omitempty"`
	Content   string            `json:"content,omitempty"`
}

type deleteResult struct {
	Deleted      bool `json:"deleted"`
	PendingApply bool `json:"pendingApply"`
}

type applyAliasInput struct {
	Force bool `json:"force,omitempty"`
}

func (m *Module) roots() []string { return siteRoots(m.ctx.Cfg) }

func (m *Module) handleList(w http.ResponseWriter, r *http.Request) {
	if !m.ctx.Caps.Get(false).Caddy.Available {
		httpapi.OK(w, protocol.UnavailableList[Site](m.caddyReason()))
		return
	}
	query := r.URL.Query()
	var enabledFilter *bool
	if raw := query.Get("enabled"); raw != "" {
		value, err := strconv.ParseBool(raw)
		if err != nil {
			httpapi.Fail(w, protocol.BadRequest("enabled 必须是布尔值"))
			return
		}
		enabledFilter = &value
	}
	q := strings.ToLower(strings.TrimSpace(query.Get("q")))
	all := m.store.List()
	filtered := make([]Site, 0, len(all))
	for _, site := range all {
		if enabledFilter != nil && site.Enabled != *enabledFilter {
			continue
		}
		if q != "" && !siteMatches(site, q) {
			continue
		}
		filtered = append(filtered, site)
	}
	limit := 0
	if raw := query.Get("limit"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil {
			limit = parsed
		}
	}
	items, next, total := protocol.Page(filtered, limit, query.Get("cursor"))
	if items == nil {
		items = []Site{}
	}
	httpapi.OK(w, protocol.ListResult[Site]{
		Available:  true,
		Items:      items,
		NextCursor: next,
		Total:      &total,
	})
}

func siteMatches(site Site, q string) bool {
	if strings.Contains(strings.ToLower(site.Name), q) {
		return true
	}
	for _, domain := range site.Config.Domains {
		if strings.Contains(strings.ToLower(domain), q) {
			return true
		}
	}
	return false
}

// handleBootstrap prepares the managed Caddy directory layout before the
// store compose stack is created. It is the one site endpoint that works
// while Caddy is still undeployed.
func (m *Module) handleBootstrap(w http.ResponseWriter, r *http.Request) {
	confDir, dataDir := m.ctx.Cfg.CaddyDirs()
	sitesDir := m.ctx.Cfg.SitesDir()
	for _, dir := range []string{confDir, filepath.Join(confDir, "sites.d"), dataDir, sitesDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			httpapi.Fail(w, internalFailure("无法创建 Caddy 目录", err))
			return
		}
	}
	rootPath := filepath.Join(confDir, "Caddyfile")
	if err := config.WriteFileAtomic(rootPath, []byte(managedCaddyfile(adminAddress(m.ctx.Cfg))), 0o644); err != nil {
		httpapi.Fail(w, internalFailure("无法写入 Caddyfile", err))
		return
	}
	if err := ensureCaddyPlaceholder(filepath.Join(confDir, "sites.d")); err != nil {
		httpapi.Fail(w, internalFailure("无法写入站点占位片段", err))
		return
	}
	httpapi.OK(w, SiteBootstrapResult{
		ConfigDir:     canonicalPath(confDir),
		DataDir:       canonicalPath(dataDir),
		CaddyfilePath: canonicalPath(rootPath),
		SitesRoot:     canonicalPath(sitesDir),
		Mounts:        bootstrapMounts(confDir, dataDir, m.roots()),
		Ready:         m.caddyAvailable(),
	})
}

// bootstrapMounts lists the host paths the Caddy container must see. Caddy
// config/data get fixed container paths; every readable site root is mounted
// at the same absolute path so Caddyfile roots stay valid inside the
// container.
func bootstrapMounts(confDir, dataDir string, roots []string) []BootstrapMount {
	mounts := []BootstrapMount{
		{Source: canonicalPath(confDir), Target: caddyContainerConfigRoot},
		{Source: canonicalPath(dataDir), Target: caddyContainerDataRoot},
	}
	seenTarget := map[string]bool{
		caddyContainerConfigRoot: true,
		caddyContainerDataRoot:   true,
	}
	seenSource := map[string]bool{
		canonicalPath(confDir): true,
		canonicalPath(dataDir): true,
	}
	for _, root := range roots {
		target, err := filepath.Abs(root)
		if err != nil {
			continue
		}
		target = filepath.Clean(target)
		source := canonicalPath(target)
		if source == "" || seenSource[source] || !pathIsDir(source) {
			continue
		}
		// Mount at the path written in the Caddyfile (not the symlink target),
		// so file_server roots stay valid inside the container.
		if seenTarget[target] {
			continue
		}
		seenSource[source] = true
		seenTarget[target] = true
		mounts = append(mounts, BootstrapMount{Source: source, Target: filepath.ToSlash(target), ReadOnly: true})
	}
	return mounts
}

func (m *Module) handleCreate(w http.ResponseWriter, r *http.Request) {
	if !m.requireCaddy(w) {
		return
	}

	var input createInput
	if !httpapi.DecodeJSON(w, r, &input) {
		return
	}
	name, message := ValidSiteName(input.Name)
	if message != "" {
		httpapi.Fail(w, protocol.BadRequest(message))
		return
	}
	enabled := true
	if input.Enabled != nil {
		enabled = *input.Enabled
	}
	if issues := validateConfig(input.Config, m.roots()); len(issues) > 0 {
		httpapi.Fail(w, configError(issues))
		return
	}
	normalized, _, err := hashConfigPasswords(input.Config)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	site, perr := m.store.Create(name, enabled, normalized)
	if perr != nil {
		httpapi.Fail(w, perr)
		return
	}
	httpapi.Created(w, site)
}

func (m *Module) handleGet(w http.ResponseWriter, r *http.Request) {
	if !m.requireCaddy(w) {
		return
	}

	site, ok := m.store.Get(r.PathValue("id"))
	if !ok {
		httpapi.Fail(w, protocol.NotFound("站点", r.PathValue("id")))
		return
	}
	httpapi.OK(w, site)
}

func (m *Module) handleUpdate(w http.ResponseWriter, r *http.Request) {
	if !m.requireCaddy(w) {
		return
	}

	var input updateInput
	if !httpapi.DecodeJSON(w, r, &input) {
		return
	}
	if input.Name == nil && input.Enabled == nil && input.Config == nil {
		httpapi.Fail(w, protocol.BadRequest("至少提供 name、enabled、config 之一"))
		return
	}
	update := UpdateInput{Enabled: input.Enabled}
	if input.Name != nil {
		name, message := ValidSiteName(*input.Name)
		if message != "" {
			httpapi.Fail(w, protocol.BadRequest(message))
			return
		}
		update.Name = &name
	}
	if input.Config != nil {
		if issues := validateConfig(*input.Config, m.roots()); len(issues) > 0 {
			httpapi.Fail(w, configError(issues))
			return
		}
		normalized, _, err := hashConfigPasswords(*input.Config)
		if err != nil {
			httpapi.Fail(w, err)
			return
		}
		update.Config = &normalized
	}
	site, perr := m.store.Update(r.PathValue("id"), update)
	if perr != nil {
		httpapi.Fail(w, perr)
		return
	}
	httpapi.OK(w, site)
}

func (m *Module) handleDelete(w http.ResponseWriter, r *http.Request) {
	if !m.requireCaddy(w) {
		return
	}

	id := r.PathValue("id")
	site, perr := m.store.Delete(id)
	if perr != nil {
		httpapi.Fail(w, perr)
		return
	}
	pending := site.AppliedRevision != nil
	if confDir, _ := m.ctx.Cfg.CaddyDirs(); fileExists(filepath.Join(confDir, "sites.d", id+".caddy")) {
		pending = true
	}
	httpapi.OK(w, deleteResult{Deleted: true, PendingApply: pending})
}

func (m *Module) handlePreview(w http.ResponseWriter, r *http.Request) {
	if !m.requireCaddy(w) {
		return
	}

	var input previewInput
	if !httpapi.DecodeJSON(w, r, &input) {
		return
	}
	hasSite := input.Site != nil
	hasID := input.SiteID != ""
	if hasSite == hasID {
		httpapi.Fail(w, protocol.BadRequest("site 与 siteId 必须恰好提供一个"))
		return
	}
	if hasSite {
		m.previewConfig(w, r, *input.Site, input.Validate)
		return
	}
	site, ok := m.store.Get(input.SiteID)
	if !ok {
		httpapi.Fail(w, protocol.NotFound("站点", input.SiteID))
		return
	}
	m.previewConfig(w, r, site.Config, input.Validate)
}

// handlePreviewByID is the additive POST /sites/{id}/preview alias.
func (m *Module) handlePreviewByID(w http.ResponseWriter, r *http.Request) {
	if !m.requireCaddy(w) {
		return
	}

	id := r.PathValue("id")
	var input previewInput
	if !httpapi.DecodeJSON(w, r, &input) {
		return
	}
	site, ok := m.store.Get(id)
	if !ok {
		httpapi.Fail(w, protocol.NotFound("站点", id))
		return
	}
	m.previewConfig(w, r, site.Config, input.Validate)
}

func (m *Module) previewConfig(w http.ResponseWriter, r *http.Request, cfg SiteConfig, validate bool) {
	content, warnings, err := renderSite(Site{Config: cfg}, m.roots())
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	if warnings == nil {
		warnings = []string{}
	}
	result := SitePreviewResult{Caddyfile: content, Warnings: warnings}
	if validate {
		container, perr := m.caddyContainer(r.Context())
		if perr != nil {
			result.ValidationUnavailableReason = panelErrorMessage(perr)
		} else {
			ok, output, err := m.previewValidate(r, container.ID, content)
			if err != nil {
				result.ValidationUnavailableReason = err.Error()
			} else {
				result.Validation = &PreviewValidate{OK: ok, Output: output}
			}
		}
	}
	httpapi.OK(w, result)
}

func panelErrorMessage(err *protocol.PanelError) string {
	if err == nil {
		return ""
	}
	if reason, ok := err.Details["reason"].(string); ok && strings.TrimSpace(reason) != "" {
		return reason
	}
	return err.Message
}

// previewValidate runs caddy validate against a throwaway staging directory
// inside the mounted config dir. It never touches the live sites.d or
// Caddyfile.
func (m *Module) previewValidate(r *http.Request, containerID, fragment string) (bool, string, error) {
	confDir, _ := m.ctx.Cfg.CaddyDirs()
	if err := os.MkdirAll(confDir, 0o755); err != nil {
		return false, "", err
	}
	dir, err := os.MkdirTemp(confDir, ".preview-*")
	if err != nil {
		return false, "", err
	}
	defer os.RemoveAll(dir)
	sitesDir := filepath.Join(dir, "sites.d")
	if err := os.MkdirAll(sitesDir, 0o755); err != nil {
		return false, "", err
	}
	if err := os.WriteFile(filepath.Join(sitesDir, "preview.caddy"), []byte(fragment), 0o644); err != nil {
		return false, "", err
	}
	root := filepath.Join(dir, "Caddyfile")
	if err := os.WriteFile(root, []byte(managedCaddyfile(adminAddress(m.ctx.Cfg))), 0o644); err != nil {
		return false, "", err
	}
	containerRoot, perr := m.containerPath(root)
	if perr != nil {
		return false, "", errors.New(panelErrorMessage(perr))
	}
	result, err := m.runCaddy(r.Context(), containerID, "validate", "--config", containerRoot, "--adapter", "caddyfile")
	output := joinOutput(result.Stdout, result.Stderr)
	if err != nil {
		output = joinOutput(output, err.Error())
	}
	return err == nil && result.Code == 0, tailOutput(output, outputTailBytes), nil
}

func (m *Module) handleApply(w http.ResponseWriter, r *http.Request) {
	if !m.requireCaddy(w) {
		return
	}

	var input applyInput
	if !httpapi.DecodeJSON(w, r, &input) {
		return
	}
	plan := applyPlan{
		siteIDs: input.SiteIDs,
		partial: input.SiteIDs != nil,
		force:   input.Force,
	}
	if httpapi.WantsAsync(r) {
		m.submitApplyJob(w, plan, "应用站点配置")
		return
	}
	result, err := m.apply(r.Context(), plan)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	httpapi.OK(w, result)
}

// submitApplyJob starts site apply in the background and returns 202 + job.
func (m *Module) submitApplyJob(w http.ResponseWriter, plan applyPlan, title string) {
	job, err := m.ctx.Jobs.Submit(agent.JobSpec{
		Kind:  "sites.apply",
		Title: title,
		Run: func(ctx context.Context, reporter agent.JobReporter) (any, error) {
			return m.applyWithProgress(ctx, plan, reporter.SetProgress)
		},
	})
	if err != nil {
		httpapi.Fail(w, internalFailure("无法创建应用任务", err))
		return
	}
	httpapi.Accepted(w, protocol.JobStarted{Job: job})
}

// handleApplyByID is the additive POST /sites/{id}/apply alias.
func (m *Module) handleApplyByID(w http.ResponseWriter, r *http.Request) {
	if !m.requireCaddy(w) {
		return
	}

	var input applyAliasInput
	if !httpapi.DecodeJSON(w, r, &input) {
		return
	}
	id := r.PathValue("id")
	plan := applyPlan{siteIDs: []string{id}, partial: true, force: input.Force}
	if httpapi.WantsAsync(r) {
		title := "应用站点配置"
		if site, ok := m.store.Get(id); ok {
			title = "应用站点 " + site.Name
		}
		m.submitApplyJob(w, plan, title)
		return
	}
	result, err := m.apply(r.Context(), plan)
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	httpapi.OK(w, result)
}

func (m *Module) handleExport(w http.ResponseWriter, r *http.Request) {
	if !m.requireCaddy(w) {
		return
	}

	all := m.store.List()
	bundle := SiteExportBundle{
		Version:    1,
		ExportedAt: nowRFC3339(),
		Sites:      make([]SiteExportItem, 0, len(all)),
	}
	for _, site := range all {
		bundle.Sites = append(bundle.Sites, SiteExportItem{
			Name:    site.Name,
			Enabled: site.Enabled,
			Config:  site.Config,
		})
	}
	httpapi.OK(w, bundle)
}

// handleExportByID is the additive GET /sites/{id}/export alias.
func (m *Module) handleExportByID(w http.ResponseWriter, r *http.Request) {
	if !m.requireCaddy(w) {
		return
	}

	site, ok := m.store.Get(r.PathValue("id"))
	if !ok {
		httpapi.Fail(w, protocol.NotFound("站点", r.PathValue("id")))
		return
	}
	httpapi.OK(w, SiteExportBundle{
		Version:    1,
		ExportedAt: nowRFC3339(),
		Sites:      []SiteExportItem{{Name: site.Name, Enabled: site.Enabled, Config: site.Config}},
	})
}

func (m *Module) handleImport(w http.ResponseWriter, r *http.Request) {
	if !m.requireCaddy(w) {
		return
	}

	var input importInput
	if !httpapi.DecodeJSON(w, r, &input) {
		return
	}
	mode := input.Mode
	if mode == "" {
		mode = "merge"
	}
	if mode != "merge" && mode != "replace" {
		httpapi.Fail(w, protocol.BadRequest("mode 必须是 merge 或 replace"))
		return
	}
	rawCaddyfile := strings.TrimSpace(input.Caddyfile)
	if rawCaddyfile == "" {
		rawCaddyfile = strings.TrimSpace(input.Content)
	}
	if input.Bundle != nil && rawCaddyfile != "" {
		httpapi.Fail(w, protocol.BadRequest("bundle 与 caddyfile 只能提供一个"))
		return
	}
	var (
		result SiteImportResult
		err    error
	)
	switch {
	case input.Bundle != nil:
		result, err = m.importBundle(*input.Bundle, mode)
	case rawCaddyfile != "":
		result, err = m.importCaddyfile(rawCaddyfile, mode)
	default:
		httpapi.Fail(w, protocol.BadRequest("请求体需要 bundle 或 caddyfile"))
		return
	}
	if err != nil {
		httpapi.Fail(w, err)
		return
	}
	httpapi.OK(w, result)
}

type preparedSite struct {
	name    string
	enabled bool
	cfg     SiteConfig
}

// importBundle validates the whole bundle before any write (atomic import).
func (m *Module) importBundle(bundle SiteExportBundle, mode string) (SiteImportResult, error) {
	result := SiteImportResult{Errors: []ImportIssue{}}
	if bundle.Version != 1 {
		return result, protocol.BadRequest("不支持的导出包版本")
	}
	items := make([]preparedSite, 0, len(bundle.Sites))
	issues := make([]ImportIssue, 0)
	seen := map[string]bool{}
	for index, item := range bundle.Sites {
		name, message := ValidSiteName(item.Name)
		if message == "" && seen[name] {
			message = "同一导出包内名称重复"
		}
		var configIssues []string
		if message == "" {
			configIssues = validateConfig(item.Config, m.roots())
		}
		if message != "" || len(configIssues) > 0 {
			if message == "" {
				message = strings.Join(configIssues, "; ")
			}
			issues = append(issues, ImportIssue{Index: index, Name: item.Name, Message: message})
			continue
		}
		seen[name] = true
		items = append(items, preparedSite{name: name, enabled: item.Enabled, cfg: item.Config})
	}
	if len(issues) > 0 {
		return result, &protocol.PanelError{
			Code:    protocol.CodeBadRequest,
			Message: "导出包校验失败，未写入任何站点",
			Details: map[string]any{"errors": issues},
		}
	}

	normalized := make([]preparedSite, 0, len(items))
	for _, item := range items {
		cfg, _, err := hashConfigPasswords(item.cfg)
		if err != nil {
			return result, err
		}
		normalized = append(normalized, preparedSite{name: item.name, enabled: item.enabled, cfg: cfg})
	}

	now := nowRFC3339()
	if mode == "replace" {
		sites := make([]Site, 0, len(normalized))
		existing := make([]Site, 0, len(normalized))
		for _, item := range normalized {
			site := Site{
				ID:        newSiteID(existing),
				Name:      item.name,
				Enabled:   item.enabled,
				Config:    item.cfg,
				Revision:  1,
				CreatedAt: now,
				UpdatedAt: now,
			}
			existing = append(existing, site)
			sites = append(sites, site)
		}
		if err := m.store.ReplaceAll(sites); err != nil {
			return result, internalFailure("写入导入站点失败", err)
		}
		result.Imported = len(sites)
		return result, nil
	}

	existingSites := m.store.List()
	existingNames := make(map[string]bool, len(existingSites))
	existingIDs := make([]Site, 0, len(existingSites))
	for _, site := range existingSites {
		existingNames[site.Name] = true
		existingIDs = append(existingIDs, site)
	}
	added := make([]Site, 0, len(normalized))
	for _, item := range normalized {
		if existingNames[item.name] {
			result.Skipped++
			continue
		}
		site := Site{
			ID:        newSiteID(append(existingIDs, added...)),
			Name:      item.name,
			Enabled:   item.enabled,
			Config:    item.cfg,
			Revision:  1,
			CreatedAt: now,
			UpdatedAt: now,
		}
		added = append(added, site)
	}
	if len(added) > 0 {
		if err := m.store.AppendMany(added); err != nil {
			return result, internalFailure("写入导入站点失败", err)
		}
	}
	result.Imported = len(added)
	return result, nil
}

// importCaddyfile is the additive best-effort path: parse what the structured
// model can represent and report the rest as warnings.
func (m *Module) importCaddyfile(content, mode string) (SiteImportResult, error) {
	parsed, warnings := parseCaddyfile(content)
	result := SiteImportResult{Errors: []ImportIssue{}, Warnings: warnings}
	if len(parsed) == 0 {
		return result, &protocol.PanelError{
			Code:    protocol.CodeBadRequest,
			Message: "无法从 Caddyfile 解析出任何站点",
			Details: map[string]any{"warnings": warnings},
		}
	}
	existingSites := m.store.List()
	existingNames := make(map[string]bool, len(existingSites))
	existingIDs := make([]Site, 0, len(existingSites))
	for _, site := range existingSites {
		existingNames[site.Name] = true
		existingIDs = append(existingIDs, site)
	}
	now := nowRFC3339()
	usedNames := map[string]bool{}
	prepared := make([]Site, 0, len(parsed))
	for index, site := range parsed {
		cfg := site.Config
		if issues := validateConfig(cfg, m.roots()); len(issues) > 0 {
			result.Errors = append(result.Errors, ImportIssue{Index: index, Name: site.Name, Message: strings.Join(issues, "; ")})
			continue
		}
		normalized, _, err := hashConfigPasswords(cfg)
		if err != nil {
			return result, err
		}
		base := site.Name
		if mode == "merge" && existingNames[base] {
			result.Skipped++
			continue
		}
		name := base
		for suffix := 2; usedNames[name]; suffix++ {
			name = base + "-" + strconv.Itoa(suffix)
		}
		if name != base {
			result.Warnings = append(result.Warnings, "站点名 "+base+" 重复，导入为 "+name)
		}
		usedNames[name] = true
		site.ID = newSiteID(append(existingIDs, prepared...))
		site.Name = name
		site.Config = normalized
		site.Revision = 1
		site.CreatedAt = now
		site.UpdatedAt = now
		prepared = append(prepared, site)
	}
	if len(prepared) == 0 {
		return result, &protocol.PanelError{
			Code:    protocol.CodeBadRequest,
			Message: "Caddyfile 中没有可导入的站点",
			Details: map[string]any{"errors": result.Errors, "warnings": result.Warnings},
		}
	}
	if mode == "replace" {
		if err := m.store.ReplaceAll(prepared); err != nil {
			return result, internalFailure("写入导入站点失败", err)
		}
		// Existing sites dropped by replace count as imported replacements.
		result.Imported = len(prepared)
		return result, nil
	}
	if err := m.store.AppendMany(prepared); err != nil {
		return result, internalFailure("写入导入站点失败", err)
	}
	result.Imported = len(prepared)
	return result, nil
}
