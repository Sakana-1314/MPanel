package sites

import (
	"os"
	"sort"
	"strings"
	"unicode"

	"github.com/sakana-1314/mpanel/server/core/config"
	"github.com/sakana-1314/mpanel/server/core/protocol"
)

// RenderSite renders one site into a Caddyfile fragment. It is a pure function
// of the site value, except that when MPANEL_SITES_ROOTS is set it is also
// enforced as the root whitelist. Prefer RenderSiteWithRoots in the agent.
func RenderSite(site Site) (string, error) {
	out, _, err := renderSite(site, envRoots())
	return out, err
}

// RenderSiteWithRoots renders one site and enforces the given root whitelist.
func RenderSiteWithRoots(site Site, roots []string) (string, error) {
	out, _, err := renderSite(site, roots)
	return out, err
}

// RenderSiteWithWarnings is RenderSite plus the warnings produced while
// normalising the config (currently bcrypt hashing notices).
func RenderSiteWithWarnings(site Site) (string, []string, error) {
	return renderSite(site, envRoots())
}

func renderSite(site Site, roots []string) (string, []string, error) {
	cfg := cloneConfig(site.Config)
	if issues := validateConfig(cfg, roots); len(issues) > 0 {
		return "", nil, configError(issues)
	}
	normalized, warnings, err := hashConfigPasswords(cfg)
	if err != nil {
		return "", warnings, err
	}
	out, err := renderConfig(normalized, site.ID)
	if err != nil {
		return "", warnings, err
	}
	return out, warnings, nil
}

func envRoots() []string {
	value := strings.TrimSpace(os.Getenv("MPANEL_SITES_ROOTS"))
	if value == "" {
		return nil
	}
	var roots []string
	for _, root := range config.ParseRoots(value) {
		if strings.TrimSpace(root.Path) != "" {
			roots = append(roots, root.Path)
		}
	}
	return roots
}

// caddyLogName keeps log file names inside /var/log/caddy even if a legacy
// site ID contains path separators or other unsafe characters.
func caddyLogName(siteID string) string {
	if siteID == "" {
		return "site"
	}
	for _, r := range siteID {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= 'A' && r <= 'Z':
		case r >= '0' && r <= '9':
		case r == '_' || r == '-':
		default:
			return "site"
		}
	}
	return siteID
}

// renderConfig assumes the config already passed validateConfig.
func renderConfig(cfg SiteConfig, siteID string) (string, error) {
	var b strings.Builder
	b.WriteString("# Managed by MPanel from structured site config; do not edit.\n")

	tlsMode := TLSModeAuto
	if cfg.TLS != nil && cfg.TLS.Mode != "" {
		tlsMode = cfg.TLS.Mode
	}
	addresses := make([]string, 0, len(cfg.Domains))
	for _, domain := range cfg.Domains {
		domain = strings.TrimSpace(domain)
		if tlsMode == TLSModeOff {
			addresses = append(addresses, "http://"+domain)
		} else {
			addresses = append(addresses, domain)
		}
	}
	b.WriteString(strings.Join(addresses, ", "))
	b.WriteString(" {\n")

	for _, listen := range cfg.Listen {
		b.WriteString("\tbind ")
		b.WriteString(strings.TrimSpace(listen))
		b.WriteByte('\n')
	}

	switch tlsMode {
	case TLSModeInternal:
		b.WriteString("\ttls internal\n")
	case TLSModeOff:
		// http:// addresses already disable automatic TLS.
	case TLSModeDNS:
		email := ""
		provider := ""
		if cfg.TLS != nil {
			email = cfg.TLS.Email
			provider = cfg.TLS.DNSProvider
		}
		b.WriteString("\ttls")
		if email != "" {
			b.WriteByte(' ')
			b.WriteString(email)
		}
		b.WriteString(" {\n\t\tdns ")
		b.WriteString(provider)
		b.WriteString("\n\t}\n")
	default:
		if cfg.TLS != nil && cfg.TLS.Email != "" {
			b.WriteString("\ttls ")
			b.WriteString(cfg.TLS.Email)
			b.WriteByte('\n')
		}
	}

	if len(cfg.Encode) > 0 {
		b.WriteString("\tencode ")
		b.WriteString(strings.Join(dedupe(cfg.Encode), " "))
		b.WriteByte('\n')
	}

	writeHeaders(&b, cfg.Headers)

	if cfg.Log {
		// One file per site keeps concurrent writers from contending on the
		// same rolled log and makes the owner obvious on disk.
		b.WriteString("\tlog {\n")
		b.WriteString("\t\toutput file " + caddyContainerLogRoot + "/" + caddyLogName(siteID) + ".log {\n")
		b.WriteString("\t\t\troll_size 20MiB\n")
		b.WriteString("\t\t\troll_keep 5\n")
		b.WriteString("\t\t}\n")
		b.WriteString("\t\tformat json\n")
		b.WriteString("\t}\n")
	}

	if err := renderHandler(&b, cfg.Handler); err != nil {
		return "", err
	}

	if cfg.BasicAuth != nil && len(cfg.BasicAuth.Users) > 0 {
		b.WriteString("\tbasic_auth {\n")
		for _, user := range cfg.BasicAuth.Users {
			b.WriteString("\t\t")
			b.WriteString(user.Username)
			b.WriteByte(' ')
			b.WriteString(user.PasswordHash)
			b.WriteByte('\n')
		}
		b.WriteString("\t}\n")
	}

	b.WriteString("}\n")
	return b.String(), nil
}

func renderHandler(b *strings.Builder, handler SiteHandler) error {
	switch handler.Type {
	case HandlerReverseProxy:
		return renderReverseProxy(b, handler)
	case HandlerFileServer:
		return renderFileServer(b, handler)
	case HandlerRedirect:
		return renderRedirect(b, handler)
	case HandlerPHPFastCGI:
		return renderPHPFastCGI(b, handler)
	default:
		return protocol.BadRequest("不支持的 handler.type")
	}
}

func renderReverseProxy(b *strings.Builder, handler SiteHandler) error {
	upstreams := make([]string, 0, len(handler.Upstreams))
	for _, upstream := range handler.Upstreams {
		upstreams = append(upstreams, renderUpstream(strings.TrimSpace(upstream)))
	}
	b.WriteString("\treverse_proxy ")
	b.WriteString(strings.Join(upstreams, " "))

	hasBlock := handler.LoadBalance != "" || len(handler.Headers) > 0 || handler.HealthURI != "" ||
		(handler.TLSSkipVerify != nil && *handler.TLSSkipVerify)
	if !hasBlock {
		b.WriteByte('\n')
		return nil
	}
	b.WriteString(" {\n")
	if handler.LoadBalance != "" {
		b.WriteString("\t\tlb_policy ")
		b.WriteString(handler.LoadBalance)
		b.WriteByte('\n')
	}
	if handler.HealthURI != "" {
		b.WriteString("\t\thealth_uri ")
		b.WriteString(handler.HealthURI)
		b.WriteByte('\n')
	}
	if len(handler.Headers) > 0 {
		names := make([]string, 0, len(handler.Headers))
		for name := range handler.Headers {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			value, err := quoteCaddyToken(handler.Headers[name])
			if err != nil {
				return err
			}
			b.WriteString("\t\theader_up ")
			b.WriteString(name)
			b.WriteByte(' ')
			b.WriteString(value)
			b.WriteByte('\n')
		}
	}
	if handler.TLSSkipVerify != nil && *handler.TLSSkipVerify {
		b.WriteString("\t\ttransport http {\n\t\t\ttls_insecure_skip_verify\n\t\t}\n")
	}
	b.WriteString("\t}\n")
	return nil
}

func renderFileServer(b *strings.Builder, handler SiteHandler) error {
	root, err := quoteCaddyToken(handler.Root)
	if err != nil {
		return err
	}
	b.WriteString("\troot * ")
	b.WriteString(root)
	b.WriteByte('\n')

	if len(handler.IndexNames) > 0 {
		b.WriteString("\tindex ")
		b.WriteString(strings.Join(handler.IndexNames, " "))
		b.WriteByte('\n')
	}
	if handler.SPA != nil && *handler.SPA {
		b.WriteString("\ttry_files {path} /index.html\n")
	}

	browse := handler.Browse != nil && *handler.Browse
	precompressed := dedupe(handler.Precompressed)
	switch {
	case browse && len(precompressed) > 0:
		b.WriteString("\tfile_server {\n\t\tbrowse\n\t\tprecompressed ")
		b.WriteString(strings.Join(precompressed, " "))
		b.WriteString("\n\t}\n")
	case browse:
		b.WriteString("\tfile_server browse\n")
	case len(precompressed) > 0:
		b.WriteString("\tfile_server {\n\t\tprecompressed ")
		b.WriteString(strings.Join(precompressed, " "))
		b.WriteString("\n\t}\n")
	default:
		b.WriteString("\tfile_server\n")
	}
	return nil
}

func renderRedirect(b *strings.Builder, handler SiteHandler) error {
	target := strings.TrimSpace(handler.To)
	if handler.PreserveQuery != nil && *handler.PreserveQuery {
		target += "{uri}"
	}
	quoted, err := quoteCaddyToken(target)
	if err != nil {
		return err
	}
	b.WriteString("\tredir ")
	b.WriteString(quoted)
	if handler.Permanent != nil && *handler.Permanent {
		b.WriteString(" permanent")
	}
	b.WriteByte('\n')
	return nil
}

func renderPHPFastCGI(b *strings.Builder, handler SiteHandler) error {
	root, err := quoteCaddyToken(handler.Root)
	if err != nil {
		return err
	}
	b.WriteString("\troot * ")
	b.WriteString(root)
	b.WriteByte('\n')
	if len(handler.IndexNames) > 0 {
		b.WriteString("\tindex ")
		b.WriteString(strings.Join(handler.IndexNames, " "))
		b.WriteByte('\n')
	}
	b.WriteString("\tphp_fastcgi ")
	b.WriteString(renderUpstream(strings.TrimSpace(handler.Address)))
	b.WriteByte('\n')
	return nil
}

func writeHeaders(b *strings.Builder, headers map[string]string) {
	if len(headers) == 0 {
		return
	}
	names := make([]string, 0, len(headers))
	for name := range headers {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		value, err := quoteCaddyToken(headers[name])
		if err != nil {
			continue
		}
		b.WriteString("\theader ")
		b.WriteString(name)
		b.WriteByte(' ')
		b.WriteString(value)
		b.WriteByte('\n')
	}
}

// renderUpstream maps the API form unix:/path to Caddy's unix//path.
func renderUpstream(upstream string) string {
	if strings.HasPrefix(upstream, "unix:") {
		path := strings.TrimPrefix(upstream, "unix:")
		if strings.HasPrefix(path, "//") {
			path = path[2:]
		}
		return "unix/" + path
	}
	return upstream
}

// quoteCaddyToken rejects control characters. Tokens that are not safe bare
// words are double-quoted with backslashes and quotes escaped.
func quoteCaddyToken(value string) (string, error) {
	for _, r := range value {
		if unicode.IsControl(r) {
			return "", protocol.BadRequest("Caddyfile 值包含控制字符")
		}
	}
	if value == "" {
		return `""`, nil
	}
	if bareToken(value) {
		return value, nil
	}
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range value {
		if r == '"' || r == '\\' {
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	b.WriteByte('"')
	return b.String(), nil
}

func bareToken(value string) bool {
	for _, r := range value {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			continue
		}
		if strings.ContainsRune("._-/:@*+%~$,=", r) {
			continue
		}
		return false
	}
	return true
}

func dedupe(values []string) []string {
	seen := make(map[string]bool, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		if seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}
