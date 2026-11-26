// Package certs implements the read-only certificate inventory (contract §7).
// It parses X.509 certificates under the Caddy data directory; private keys are
// never read or returned.
package certs

import (
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/sakana-1314/mpanel/server/agent"
	"github.com/sakana-1314/mpanel/server/core/httpapi"
	"github.com/sakana-1314/mpanel/server/core/protocol"
)

// CertificateStatus is the expiry classification (contract §7).
type CertificateStatus string

// Certificate statuses.
const (
	StatusValid    CertificateStatus = "valid"
	StatusExpiring CertificateStatus = "expiring"
	StatusExpired  CertificateStatus = "expired"
	StatusUnknown  CertificateStatus = "unknown"
)

// ExpiringDays is the threshold the contract defines for "expiring" (<= 14
// days remaining). The task brief mentioned 30; the frozen contract wins.
const ExpiringDays = 14

// CertificateInfo is one parsed certificate (contract §7).
type CertificateInfo struct {
	ID                string            `json:"id"`
	Domains           []string          `json:"domains"`
	CommonName        *string           `json:"commonName"`
	Issuer            string            `json:"issuer"`
	Subject           string            `json:"subject"`
	NotBefore         string            `json:"notBefore"`
	NotAfter          string            `json:"notAfter"`
	DaysRemaining     int               `json:"daysRemaining"`
	SerialNumber      string            `json:"serialNumber"`
	FingerprintSHA256 string            `json:"fingerprintSha256"`
	KeyType           *string           `json:"keyType"`
	Source            string            `json:"source"`
	Path              string            `json:"path"`
	Status            CertificateStatus `json:"status"`
}

// Module implements /certs (contract §7).
type Module struct {
	ctx *agent.Context
}

// New returns the certs module.
func New() *Module { return &Module{} }

// Name implements agent.Module.
func (m *Module) Name() string { return "certs" }

// Register implements agent.Module.
func (m *Module) Register(ctx *agent.Context) error {
	m.ctx = ctx
	ctx.Mux.HandleFunc("GET /api/v1/certs", m.handleList)
	ctx.Mux.HandleFunc("GET /api/v1/certs/{id}", m.handleGet)
	return nil
}

func (m *Module) handleList(w http.ResponseWriter, r *http.Request) {
	query := r.URL.Query()
	statusFilter := strings.TrimSpace(query.Get("status"))
	switch CertificateStatus(statusFilter) {
	case "", StatusValid, StatusExpiring, StatusExpired, StatusUnknown:
	default:
		httpapi.Fail(w, protocol.BadRequest("status 必须是 valid、expiring、expired 或 unknown"))
		return
	}
	includeExpired := true
	if raw := query.Get("includeExpired"); raw != "" {
		value, err := strconv.ParseBool(raw)
		if err != nil {
			httpapi.Fail(w, protocol.BadRequest("includeExpired 必须是布尔值"))
			return
		}
		includeExpired = value
	}
	domain := strings.TrimSpace(query.Get("domain"))

	items, available, reason := m.scan(time.Now().UTC())
	if !available {
		httpapi.OK(w, protocol.UnavailableList[CertificateInfo](reason))
		return
	}
	filtered := make([]CertificateInfo, 0, len(items))
	for _, item := range items {
		if statusFilter != "" && string(item.Status) != statusFilter {
			continue
		}
		if !includeExpired && item.Status == StatusExpired {
			continue
		}
		if domain != "" && !matchesDomain(item, domain) {
			continue
		}
		filtered = append(filtered, item)
	}
	sort.SliceStable(filtered, func(i, j int) bool {
		if filtered[i].NotAfter != filtered[j].NotAfter {
			return filtered[i].NotAfter < filtered[j].NotAfter
		}
		return filtered[i].ID < filtered[j].ID
	})
	limit := 0
	if raw := query.Get("limit"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil {
			limit = parsed
		}
	}
	page, next, total := protocol.Page(filtered, limit, query.Get("cursor"))
	if page == nil {
		page = []CertificateInfo{}
	}
	httpapi.OK(w, protocol.ListResult[CertificateInfo]{
		Available:  true,
		Items:      page,
		NextCursor: next,
		Total:      &total,
	})
}

func (m *Module) handleGet(w http.ResponseWriter, r *http.Request) {
	id := strings.ToLower(strings.TrimSpace(r.PathValue("id")))
	items, available, reason := m.scan(time.Now().UTC())
	if !available {
		httpapi.Fail(w, protocol.Unavailable(reason, "在 conf/agent.yaml 配置可读的 caddy_data 目录后重试。"))
		return
	}
	for _, item := range items {
		if strings.EqualFold(item.ID, id) || strings.EqualFold(item.FingerprintSHA256, id) {
			httpapi.OK(w, item)
			return
		}
	}
	httpapi.Fail(w, protocol.NotFound("证书", id))
}

// scan resolves the Caddy data directory, parses certificates and logs parse
// warnings. Availability only depends on the data directory being readable.
func (m *Module) scan(now time.Time) ([]CertificateInfo, bool, string) {
	dir, ok := resolveDataDir(m.dataDirs())
	if !ok {
		return []CertificateInfo{}, false, "未找到可读的 Caddy 数据目录（caddy_data）；证书列表不可用"
	}
	items, warnings := scanCertificates(dir, now)
	for _, warning := range warnings {
		if m.ctx.Logger != nil {
			m.ctx.Logger.Warn("证书扫描警告", "warning", warning)
		}
	}
	if items == nil {
		items = []CertificateInfo{}
	}
	return items, true, ""
}

// dataDirs is the primary Caddy data directory plus common fallbacks.
func (m *Module) dataDirs() []string {
	confDir, dataDir := m.ctx.Cfg.CaddyDirs()
	candidates := []string{dataDir, filepath.Join(confDir, "data")}
	if value := strings.TrimSpace(m.ctx.Cfg.Agent.CaddyData); value != "" {
		candidates = append(candidates, value)
	}
	candidates = append(candidates,
		"/var/lib/caddy/.local/share/caddy",
		"/data/caddy",
		"/etc/caddy",
	)
	if home, err := os.UserHomeDir(); err == nil {
		candidates = append(candidates, filepath.Join(home, ".local", "share", "caddy"))
	}
	if xdg := strings.TrimSpace(os.Getenv("XDG_DATA_HOME")); xdg != "" {
		candidates = append(candidates, filepath.Join(xdg, "caddy"))
	}
	if appData := strings.TrimSpace(os.Getenv("APPDATA")); appData != "" {
		candidates = append(candidates, filepath.Join(appData, "Caddy"))
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		if candidate == "" {
			continue
		}
		cleaned := filepath.Clean(candidate)
		if seen[cleaned] {
			continue
		}
		seen[cleaned] = true
		out = append(out, cleaned)
	}
	return out
}

// resolveDataDir returns the first existing, readable data directory. A
// candidate that actually contains certificates/ wins over an empty readable
// directory, so a bare caddy_config/data created by the agent cannot mask the
// real Caddy data directory.
func resolveDataDir(candidates []string) (string, bool) {
	fallback := ""
	for _, dir := range candidates {
		info, err := os.Stat(dir)
		if err != nil || !info.IsDir() {
			continue
		}
		if _, err := os.ReadDir(dir); err != nil {
			continue
		}
		if certificateDirReadable(filepath.Join(dir, "certificates")) {
			return dir, true
		}
		if fallback == "" {
			fallback = dir
		}
	}
	if fallback != "" {
		return fallback, true
	}
	return "", false
}

func certificateDirReadable(dir string) bool {
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		return false
	}
	_, err = os.ReadDir(dir)
	return err == nil
}

func matchesDomain(item CertificateInfo, query string) bool {
	query = strings.ToLower(strings.TrimSuffix(strings.TrimSpace(query), "."))
	if query == "" {
		return true
	}
	for _, domain := range item.Domains {
		domain = strings.ToLower(strings.TrimSuffix(domain, "."))
		if domain == query {
			return true
		}
		if strings.HasPrefix(domain, "*.") {
			suffix := domain[1:]
			if len(query) > len(suffix) && strings.HasSuffix(query, suffix) {
				return true
			}
		}
	}
	return false
}
