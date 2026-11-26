package sites

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/sakana-1314/mpanel/server/core/config"
	"github.com/sakana-1314/mpanel/server/core/protocol"
)

var errInvalidAddress = errors.New("invalid address")

func isWindows() bool { return runtime.GOOS == "windows" }

func isIP(host string) bool { return net.ParseIP(host) != nil }

func netSplitHostPort(addr string) (string, string, error) { return net.SplitHostPort(addr) }

func netJoinHostPort(host, port string) string { return net.JoinHostPort(host, port) }

// SiteStatus is the worker-computed state of a site draft.
type SiteStatus string

// Site statuses (contract §6.1).
const (
	StatusDraft    SiteStatus = "draft"
	StatusPending  SiteStatus = "pending"
	StatusApplied  SiteStatus = "applied"
	StatusError    SiteStatus = "error"
	StatusDisabled SiteStatus = "disabled"
)

// Handler types. reverse_proxy, file_server and redirect are the contract
// union; php_fastcgi is an additive extension for PHP sites.
const (
	HandlerReverseProxy = "reverse_proxy"
	HandlerFileServer   = "file_server"
	HandlerRedirect     = "redirect"
	HandlerPHPFastCGI   = "php_fastcgi"
)

// TLS modes. dns is an additive extension of the contract's auto/internal/off.
const (
	TLSModeAuto     = "auto"
	TLSModeInternal = "internal"
	TLSModeOff      = "off"
	TLSModeDNS      = "dns"
)

// Site is the persisted draft plus worker-computed status (contract §6.1).
type Site struct {
	ID              string         `json:"id"`
	Name            string         `json:"name"`
	Enabled         bool           `json:"enabled"`
	Config          SiteConfig     `json:"config"`
	Revision        int            `json:"revision"`
	AppliedRevision *int           `json:"appliedRevision"`
	Status          SiteStatus     `json:"status"`
	LastApply       *SiteLastApply `json:"lastApply"`
	CreatedAt       string         `json:"createdAt"`
	UpdatedAt       string         `json:"updatedAt"`
}

// SiteLastApply records one apply attempt for a site.
type SiteLastApply struct {
	At            string `json:"at"`
	OK            bool   `json:"ok"`
	Revision      int    `json:"revision"`
	Error         string `json:"error,omitempty"`
	CaddyfileHash string `json:"caddyfileHash,omitempty"`
}

// SiteConfig is the structured site configuration.
type SiteConfig struct {
	Domains []string          `json:"domains"`
	Listen  []string          `json:"listen,omitempty"`
	Handler SiteHandler       `json:"handler"`
	TLS     *SiteTLS          `json:"tls,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
	Encode  []string          `json:"encode,omitempty"`
	Log     bool              `json:"log,omitempty"`
	// BasicAuth is an additive extension (contract §6 does not model auth).
	// Plaintext passwords are hashed with bcrypt before persistence; they are
	// never written to sites.json.
	BasicAuth *BasicAuth `json:"basicAuth,omitempty"`
}

// SiteHandler carries the union of all handler fields. Type selects how the
// block is rendered; unused fields stay empty thanks to omitempty.
type SiteHandler struct {
	Type string `json:"type"`

	// reverse_proxy
	Upstreams     []string          `json:"upstreams,omitempty"`
	LoadBalance   string            `json:"loadBalance,omitempty"`
	Headers       map[string]string `json:"headers,omitempty"`
	WebSocket     *bool             `json:"websocket,omitempty"`
	TLSSkipVerify *bool             `json:"tlsSkipVerify,omitempty"`
	HealthURI     string            `json:"healthUri,omitempty"`

	// file_server
	Root          string   `json:"root,omitempty"`
	IndexNames    []string `json:"indexNames,omitempty"`
	Browse        *bool    `json:"browse,omitempty"`
	SPA           *bool    `json:"spa,omitempty"`
	Precompressed []string `json:"precompressed,omitempty"`

	// redirect
	To            string `json:"to,omitempty"`
	Permanent     *bool  `json:"permanent,omitempty"`
	PreserveQuery *bool  `json:"preserveQuery,omitempty"`

	// php_fastcgi extension
	Address string `json:"address,omitempty"`
}

// SiteTLS is the TLS block. DNSProvider is an extension used by mode "dns".
type SiteTLS struct {
	Mode        string `json:"mode"`
	Email       string `json:"email,omitempty"`
	DNSProvider string `json:"dnsProvider,omitempty"`
}

// BasicAuth is an additive extension: a list of basic-auth users.
type BasicAuth struct {
	Users []BasicAuthUser `json:"users"`
}

// BasicAuthUser holds either a plaintext password (write-only, hashed before
// persistence) or an existing bcrypt hash.
type BasicAuthUser struct {
	Username     string `json:"username"`
	Password     string `json:"password,omitempty"`
	PasswordHash string `json:"passwordHash,omitempty"`
}

// SitePreviewResult is the POST /sites/preview response (contract §6.3).
type SitePreviewResult struct {
	Caddyfile                   string           `json:"caddyfile"`
	Warnings                    []string         `json:"warnings"`
	Validation                  *PreviewValidate `json:"validation"`
	ValidationUnavailableReason string           `json:"validationUnavailableReason,omitempty"`
}

// PreviewValidate is the caddy validate outcome.
type PreviewValidate struct {
	OK     bool   `json:"ok"`
	Output string `json:"output"`
}

// SiteApplyResult is the POST /sites/apply response (contract §6.4).
type SiteApplyResult struct {
	Revision      int              `json:"revision"`
	AppliedAt     string           `json:"appliedAt"`
	CaddyfilePath string           `json:"caddyfilePath"`
	BackupPath    *string          `json:"backupPath"`
	Reloaded      bool             `json:"reloaded"`
	RolledBack    bool             `json:"rolledBack"`
	Sites         []SiteApplyEntry `json:"sites"`
	Warnings      []string         `json:"warnings"`
	CaddyOutput   string           `json:"caddyOutput"`
}

// SiteApplyEntry is one site in SiteApplyResult.sites.
type SiteApplyEntry struct {
	ID     string     `json:"id"`
	Name   string     `json:"name"`
	Status SiteStatus `json:"status"`
}

// SiteExportBundle is GET /sites/export (contract §6.5).
type SiteExportBundle struct {
	Version    int              `json:"version"`
	ExportedAt string           `json:"exportedAt"`
	Sites      []SiteExportItem `json:"sites"`
}

// SiteExportItem is one exported site (no id/revision/runtime state).
type SiteExportItem struct {
	Name    string     `json:"name"`
	Enabled bool       `json:"enabled"`
	Config  SiteConfig `json:"config"`
}

// SiteImportResult is POST /sites/import. Warnings is an additive field used
// by the best-effort Caddyfile importer.
type SiteImportResult struct {
	Imported int           `json:"imported"`
	Skipped  int           `json:"skipped"`
	Errors   []ImportIssue `json:"errors"`
	Warnings []string      `json:"warnings,omitempty"`
}

// SiteBootstrapResult is POST /sites/bootstrap. It prepares the host
// directories and root Caddyfile the managed container mounts, and returns the
// mounts the store compose template must reproduce.
type SiteBootstrapResult struct {
	ConfigDir     string           `json:"configDir"`
	DataDir       string           `json:"dataDir"`
	CaddyfilePath string           `json:"caddyfilePath"`
	SitesRoot     string           `json:"sitesRoot"`
	Mounts        []BootstrapMount `json:"mounts"`
	Ready         bool             `json:"ready"`
}

// BootstrapMount is one host bind mount required by the Caddy container.
type BootstrapMount struct {
	Source   string `json:"source"`
	Target   string `json:"target"`
	ReadOnly bool   `json:"readOnly,omitempty"`
}

// ImportIssue describes one skipped/invalid imported site.
type ImportIssue struct {
	Index   int    `json:"index"`
	Name    string `json:"name,omitempty"`
	Message string `json:"message"`
}

// computeStatus applies the contract §6.1 status table.
func computeStatus(site Site) SiteStatus {
	if !site.Enabled {
		return StatusDisabled
	}
	if site.LastApply != nil && !site.LastApply.OK {
		return StatusError
	}
	if site.AppliedRevision == nil {
		if site.LastApply == nil {
			return StatusDraft
		}
		return StatusPending
	}
	if *site.AppliedRevision != site.Revision {
		return StatusPending
	}
	return StatusApplied
}

// decorate returns a copy with the worker-computed status filled in.
func decorate(site Site) Site {
	site.Status = computeStatus(site)
	return site
}

// cloneSite deep-copies a site so handlers never alias the store's memory.
func cloneSite(site Site) Site {
	site.Config = cloneConfig(site.Config)
	if site.AppliedRevision != nil {
		v := *site.AppliedRevision
		site.AppliedRevision = &v
	}
	if site.LastApply != nil {
		v := *site.LastApply
		site.LastApply = &v
	}
	return site
}

func cloneConfig(cfg SiteConfig) SiteConfig {
	cfg.Domains = append([]string(nil), cfg.Domains...)
	cfg.Listen = append([]string(nil), cfg.Listen...)
	cfg.Encode = append([]string(nil), cfg.Encode...)
	cfg.Headers = cloneStringMap(cfg.Headers)
	if cfg.TLS != nil {
		v := *cfg.TLS
		cfg.TLS = &v
	}
	if cfg.BasicAuth != nil {
		users := make([]BasicAuthUser, len(cfg.BasicAuth.Users))
		copy(users, cfg.BasicAuth.Users)
		cfg.BasicAuth = &BasicAuth{Users: users}
	}
	h := cfg.Handler
	h.Upstreams = append([]string(nil), h.Upstreams...)
	h.IndexNames = append([]string(nil), h.IndexNames...)
	h.Precompressed = append([]string(nil), h.Precompressed...)
	h.Headers = cloneStringMap(h.Headers)
	cfg.Handler = h
	return cfg
}

func cloneStringMap(in map[string]string) map[string]string {
	if in == nil {
		return nil
	}
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

// configError turns validation issues into a BAD_REQUEST PanelError.
func configError(issues []string) *protocol.PanelError {
	return &protocol.PanelError{
		Code:    protocol.CodeBadRequest,
		Message: "站点配置不合法",
		Details: map[string]any{"issues": issues},
	}
}

// validateConfig checks every user-controlled string that can reach a
// Caddyfile. roots is the site-root whitelist; empty means "absolute path
// only" (used by the pure renderer when no whitelist is configured).
func validateConfig(cfg SiteConfig, roots []string) []string {
	var issues []string
	add := func(format string) { issues = append(issues, format) }

	if len(cfg.Domains) == 0 {
		add("domains 不能为空")
	}
	if len(cfg.Domains) > 50 {
		add("domains 最多 50 个")
	}
	seen := map[string]bool{}
	for _, domain := range cfg.Domains {
		domain = strings.TrimSpace(domain)
		if domain == "" {
			add("域名不能为空")
			continue
		}
		if !validDomain(domain) {
			add("非法域名: " + safeForMessage(domain))
			continue
		}
		key := strings.ToLower(domain)
		if seen[key] {
			add("域名重复: " + safeForMessage(domain))
		}
		seen[key] = true
	}

	for _, addr := range cfg.Listen {
		if !validListenAddress(strings.TrimSpace(addr)) {
			add("非法 listen 地址: " + safeForMessage(addr))
		}
	}

	switch cfg.Handler.Type {
	case HandlerReverseProxy:
		if len(cfg.Handler.Upstreams) == 0 {
			add("reverse_proxy.upstreams 不能为空")
		}
		if len(cfg.Handler.Upstreams) > 50 {
			add("reverse_proxy.upstreams 最多 50 个")
		}
		for _, upstream := range cfg.Handler.Upstreams {
			if !validUpstream(strings.TrimSpace(upstream)) {
				add("非法上游地址: " + safeForMessage(upstream))
			}
		}
		if cfg.Handler.LoadBalance != "" && !validLoadBalance(cfg.Handler.LoadBalance) {
			add("非法负载均衡策略: " + safeForMessage(cfg.Handler.LoadBalance))
		}
		issues = append(issues, validateHeaderMap("reverse_proxy.headers", cfg.Handler.Headers)...)
		if cfg.Handler.HealthURI != "" && !validHealthURI(cfg.Handler.HealthURI) {
			add("非法 healthUri: " + safeForMessage(cfg.Handler.HealthURI))
		}
	case HandlerFileServer:
		issues = append(issues, validateRoot(cfg.Handler.Root, roots)...)
		for _, name := range cfg.Handler.IndexNames {
			if !validIndexName(name) {
				add("非法 indexNames 项: " + safeForMessage(name))
			}
		}
		issues = append(issues, validateEnumList("precompressed", cfg.Handler.Precompressed, "gzip", "zstd")...)
	case HandlerRedirect:
		if !validRedirectTarget(cfg.Handler.To) {
			add("非法 redirect.to: " + safeForMessage(cfg.Handler.To))
		}
	case HandlerPHPFastCGI:
		issues = append(issues, validateRoot(cfg.Handler.Root, roots)...)
		if !validUpstream(strings.TrimSpace(cfg.Handler.Address)) {
			add("非法 php_fastcgi.address: " + safeForMessage(cfg.Handler.Address))
		}
		for _, name := range cfg.Handler.IndexNames {
			if !validIndexName(name) {
				add("非法 indexNames 项: " + safeForMessage(name))
			}
		}
	case "":
		add("handler.type 不能为空")
	default:
		add("不支持的 handler.type: " + safeForMessage(cfg.Handler.Type))
	}

	if cfg.TLS != nil {
		switch cfg.TLS.Mode {
		case "", TLSModeAuto, TLSModeInternal, TLSModeOff:
		case TLSModeDNS:
			if cfg.TLS.DNSProvider == "" {
				add("tls.mode=dns 时 dnsProvider 不能为空")
			} else if !validDNSProvider(cfg.TLS.DNSProvider) {
				add("非法 dnsProvider: " + safeForMessage(cfg.TLS.DNSProvider))
			}
		default:
			add("不支持的 tls.mode: " + safeForMessage(cfg.TLS.Mode))
		}
		if cfg.TLS.Email != "" && !validEmail(cfg.TLS.Email) {
			add("非法 tls.email: " + safeForMessage(cfg.TLS.Email))
		}
	}

	issues = append(issues, validateHeaderMap("headers", cfg.Headers)...)
	issues = append(issues, validateEnumList("encode", cfg.Encode, "gzip", "zstd")...)

	if cfg.BasicAuth != nil {
		if len(cfg.BasicAuth.Users) == 0 {
			add("basicAuth.users 不能为空")
		}
		seenUsers := map[string]bool{}
		for _, user := range cfg.BasicAuth.Users {
			if !validAuthUsername(user.Username) {
				add("非法 basicAuth 用户名: " + safeForMessage(user.Username))
				continue
			}
			if seenUsers[user.Username] {
				add("basicAuth 用户名重复: " + safeForMessage(user.Username))
			}
			seenUsers[user.Username] = true
			if user.PasswordHash == "" && user.Password == "" {
				add("basicAuth 用户缺少 password 或 passwordHash: " + safeForMessage(user.Username))
			}
			if user.Password == "" && user.PasswordHash != "" && !validBcryptHash(user.PasswordHash) {
				add("basicAuth 用户的 passwordHash 不是合法 bcrypt 哈希: " + safeForMessage(user.Username))
			}
			if user.Password != "" && len(user.Password) > 72 {
				add("basicAuth 明文密码超过 72 字节: " + safeForMessage(user.Username))
			}
		}
	}
	return issues
}

// validateRoot enforces an absolute path, no unsafe characters, and membership
// in the optional root whitelist.
func validateRoot(root string, roots []string) []string {
	var issues []string
	root = strings.TrimSpace(root)
	if root == "" {
		return []string{"file_server.root 不能为空"}
	}
	for _, r := range root {
		if r == '\x00' || r == '\n' || r == '\r' || unicode.IsControl(r) {
			return []string{"root 含控制字符"}
		}
		if r == '{' || r == '}' || r == '"' {
			return []string{"root 含非法字符 {} 或 \""}
		}
	}
	if !filepath.IsAbs(root) {
		issues = append(issues, "root 必须是绝对路径: "+safeForMessage(root))
		return issues
	}
	if len(roots) == 0 {
		return issues
	}
	if !rootAllowed(root, roots) {
		issues = append(issues, "root 不在允许的站点根白名单内: "+safeForMessage(root))
	}
	return issues
}

// rootAllowed reports whether path is inside one of roots. Symlinks are
// resolved when possible so a link cannot escape the whitelist.
func rootAllowed(path string, roots []string) bool {
	target := canonicalPath(path)
	for _, root := range roots {
		candidate := canonicalPath(root)
		candidate = strings.TrimRight(candidate, string(filepath.Separator))
		if samePath(target, candidate) {
			return true
		}
		prefix := candidate + string(filepath.Separator)
		if len(target) > len(prefix) && samePath(target[:len(prefix)], prefix) {
			return true
		}
	}
	return false
}

func canonicalPath(path string) string {
	cleaned := filepath.Clean(path)
	if resolved, err := filepath.EvalSymlinks(cleaned); err == nil {
		cleaned = resolved
	}
	if abs, err := filepath.Abs(cleaned); err == nil {
		cleaned = abs
	}
	return filepath.Clean(cleaned)
}

func samePath(a, b string) bool {
	if isWindows() {
		return strings.EqualFold(a, b)
	}
	return a == b
}

func validDomain(domain string) bool {
	if len(domain) > 253 {
		return false
	}
	host := domain
	if strings.HasPrefix(host, "*.") {
		host = host[2:]
	}
	if host == "" {
		return false
	}
	if strings.Contains(host, "*") || isIP(host) {
		return false
	}
	labels := strings.Split(host, ".")
	for _, label := range labels {
		if len(label) == 0 || len(label) > 63 {
			return false
		}
		if label[0] == '-' || label[len(label)-1] == '-' {
			return false
		}
		for i := 0; i < len(label); i++ {
			c := label[i]
			if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' {
				continue
			}
			return false
		}
	}
	return true
}

func validListenAddress(addr string) bool {
	if addr == "" || hasUnsafeTokenRune(addr) || strings.ContainsAny(addr, "{}*") {
		return false
	}
	host, port, err := splitHostPort(addr)
	if err != nil {
		return false
	}
	if !validPort(port) {
		return false
	}
	if host == "" {
		return true
	}
	return validHost(host)
}

func validUpstream(upstream string) bool {
	if upstream == "" {
		return false
	}
	if strings.HasPrefix(upstream, "unix:") {
		path := strings.TrimPrefix(upstream, "unix:")
		if strings.HasPrefix(path, "//") {
			path = path[2:]
		}
		if !strings.HasPrefix(path, "/") || len(path) < 2 {
			return false
		}
		return !hasUnsafeTokenRune(path) && !strings.ContainsAny(path, "{}")
	}
	if hasUnsafeTokenRune(upstream) || strings.ContainsAny(upstream, "{}") {
		return false
	}
	host, port, err := splitHostPort(upstream)
	if err != nil {
		return false
	}
	if host == "" || !validPort(port) {
		return false
	}
	return validHost(host)
}

// splitHostPort wraps net.SplitHostPort with a friendlier error contract.
func splitHostPort(addr string) (string, string, error) {
	if strings.Count(addr, ":") < 1 {
		return "", "", errInvalidAddress
	}
	host, port, err := netSplitHostPort(addr)
	if err != nil {
		return "", "", err
	}
	return host, port, nil
}

func validHost(host string) bool {
	if host == "" {
		return false
	}
	if strings.ContainsAny(host, "*{} /\"'`\\") {
		return false
	}
	if isIP(host) {
		return true
	}
	return validDomain(host)
}

func validPort(port string) bool {
	if port == "" || len(port) > 5 {
		return false
	}
	n := 0
	for i := 0; i < len(port); i++ {
		c := port[i]
		if c < '0' || c > '9' {
			return false
		}
		n = n*10 + int(c-'0')
	}
	return n >= 1 && n <= 65535
}

func validLoadBalance(value string) bool {
	switch value {
	case "round_robin", "random", "least_conn", "uri_hash":
		return true
	}
	return false
}

func validHealthURI(uri string) bool {
	if uri == "" || len(uri) > 2048 {
		return false
	}
	if !strings.HasPrefix(uri, "/") {
		return false
	}
	return !hasUnsafeTokenRune(uri) && !strings.ContainsAny(uri, "{}")
}

func validRedirectTarget(target string) bool {
	target = strings.TrimSpace(target)
	if target == "" || len(target) > 2048 {
		return false
	}
	if hasUnsafeTokenRune(target) || strings.ContainsAny(target, `{}"'\`) {
		return false
	}
	if strings.HasPrefix(target, "/") {
		return true
	}
	lower := strings.ToLower(target)
	return strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://")
}

func validEmail(email string) bool {
	if email == "" || len(email) > 254 || hasUnsafeTokenRune(email) || strings.ContainsAny(email, `{}"'\`) {
		return false
	}
	if strings.Count(email, "@") != 1 {
		return false
	}
	local, domain, _ := strings.Cut(email, "@")
	if local == "" || domain == "" {
		return false
	}
	return validDomain(domain) && !strings.Contains(local, "..")
}

func validDNSProvider(provider string) bool {
	if provider == "" || len(provider) > 64 {
		return false
	}
	for _, r := range provider {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' || r == '_' {
			continue
		}
		return false
	}
	return true
}

func validIndexName(name string) bool {
	if name == "" || len(name) > 255 || name == "." || name == ".." {
		return false
	}
	if strings.ContainsAny(name, `/\{}"'`) {
		return false
	}
	for _, r := range name {
		if unicode.IsControl(r) || unicode.IsSpace(r) {
			return false
		}
	}
	return true
}

func validAuthUsername(name string) bool {
	if name == "" || len(name) > 64 {
		return false
	}
	for _, r := range name {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			continue
		}
		if strings.ContainsRune("._@+-", r) {
			continue
		}
		return false
	}
	return true
}

func validateEnumList(field string, values []string, allowed ...string) []string {
	var issues []string
	valid := map[string]bool{}
	for _, a := range allowed {
		valid[a] = true
	}
	seen := map[string]bool{}
	for _, value := range values {
		if !valid[value] {
			issues = append(issues, "非法的 "+field+" 取值: "+safeForMessage(value))
			continue
		}
		if seen[value] {
			issues = append(issues, field+" 取值重复: "+value)
		}
		seen[value] = true
	}
	return issues
}

func validateHeaderMap(field string, headers map[string]string) []string {
	var issues []string
	names := make([]string, 0, len(headers))
	for name := range headers {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if !validHeaderName(name) {
			issues = append(issues, field+" 中的 header 名非法: "+safeForMessage(name))
			continue
		}
		if !validHeaderValue(headers[name]) {
			issues = append(issues, field+" 中的 header 值非法: "+safeForMessage(name))
		}
	}
	return issues
}

func validHeaderName(name string) bool {
	if name == "" || len(name) > 256 {
		return false
	}
	for i := 0; i < len(name); i++ {
		c := name[i]
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' {
			continue
		}
		if strings.ContainsRune("!#$%&'*+-.^_`|~", rune(c)) {
			continue
		}
		return false
	}
	return true
}

func validHeaderValue(value string) bool {
	if len(value) > 8192 {
		return false
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return false
		}
		if r == '{' || r == '}' || r == '"' || r == '\\' {
			return false
		}
	}
	return true
}

func hasUnsafeTokenRune(value string) bool {
	for _, r := range value {
		if unicode.IsControl(r) || unicode.IsSpace(r) {
			return true
		}
		switch r {
		case '"', '\'', '`', '\\':
			return true
		}
	}
	return false
}

// safeForMessage prevents user input from forging newlines in error text.
func safeForMessage(value string) string {
	value = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, value)
	if !utf8.ValidString(value) {
		value = strings.ToValidUTF8(value, "?")
	}
	if len(value) > 200 {
		value = value[:200]
	}
	return value
}

// hashConfigPasswords replaces plaintext passwords with bcrypt hashes. The
// clear-text password is never persisted. A hashing failure is reported as
// UNAVAILABLE (employ the caller's hint).
func hashConfigPasswords(cfg SiteConfig) (SiteConfig, []string, error) {
	cfg = cloneConfig(cfg)
	if cfg.BasicAuth == nil {
		return cfg, nil, nil
	}
	var warnings []string
	for i := range cfg.BasicAuth.Users {
		user := &cfg.BasicAuth.Users[i]
		if user.Password == "" {
			continue
		}
		dst, err := bcryptGenerate([]byte(user.Password))
		if err != nil {
			return cfg, warnings, &protocol.PanelError{
				Code:    protocol.CodeUnavailable,
				Message: "无法生成 bcrypt 哈希，基础认证未保存",
				Hint:    "当前构建缺少可用的 bcrypt 实现；请先移除 basicAuth 或使用预生成的 passwordHash。",
				Details: map[string]any{"user": user.Username},
			}
		}
		user.PasswordHash = dst
		user.Password = ""
		warnings = append(warnings, "basicAuth 用户 "+user.Username+" 的明文密码已用 bcrypt 哈希")
	}
	return cfg, warnings, nil
}

// hashCaddyfile returns the fragment hash recorded in lastApply.
func hashCaddyfile(content string) string {
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:])
}

// siteRoots returns the configured site-root whitelist. MPANEL_SITES_ROOTS
// wins when set; otherwise file-manager roots plus <data>/sites are allowed.
func siteRoots(cfg *config.Agent) []string {
	if value := strings.TrimSpace(os.Getenv("MPANEL_SITES_ROOTS")); value != "" {
		var roots []string
		for _, root := range config.ParseRoots(value) {
			roots = append(roots, root.Path)
		}
		if len(roots) > 0 {
			return roots
		}
	}
	var roots []string
	for _, root := range cfg.Agent.FilesRoots {
		if strings.TrimSpace(root.Path) != "" {
			roots = append(roots, root.Path)
		}
	}
	roots = append(roots, filepath.Join(cfg.Agent.DataDir, "sites"))
	return roots
}

func nowRFC3339() string { return time.Now().UTC().Format(time.RFC3339) }
