package sites

import (
	"fmt"
	"net"
	"strings"
)

// This file implements a deliberately conservative, best-effort Caddyfile
// reader used only by the additive POST /sites/import {caddyfile} path. The
// contract's official import format is a SiteExportBundle; anything this parser
// cannot represent is returned as a warning instead of being guessed.

type caddyToken struct {
	text   string
	line   int
	quoted bool
}

type caddyDirective struct {
	name     string
	args     []string
	block    []caddyDirective
	hasBlock bool
	line     int
}

// parseCaddyfile returns draft sites plus warnings for fields it could not
// recover. No file is written.
func parseCaddyfile(content string) ([]Site, []string) {
	tokens := tokenizeCaddyfile(content)
	lines := groupTokensByLine(tokens)
	var (
		sites    []Site
		warnings []string
	)
	for i := 0; i < len(lines); i++ {
		line := lines[i]
		if len(line) == 0 {
			continue
		}
		first := line[0].text
		switch {
		case first == "{":
			warnings = append(warnings, fmt.Sprintf("第 %d 行：全局 options 块无法映射到站点配置，已跳过", line[0].line))
			i = skipBlockLines(lines, i)
			continue
		case strings.HasPrefix(first, "("):
			warnings = append(warnings, fmt.Sprintf("第 %d 行：snippet %s 无法导入，已跳过", line[0].line, first))
			i = skipBlockLines(lines, i)
			continue
		case first == "import":
			warnings = append(warnings, fmt.Sprintf("第 %d 行：import 指令无法导入，已跳过", line[0].line))
			continue
		}

		header, block, next, ok := readSiteBlock(lines, i)
		if !ok {
			warnings = append(warnings, fmt.Sprintf("第 %d 行：无法识别顶层指令 %s，已跳过", line[0].line, first))
			continue
		}
		i = next
		cfg, siteWarnings := configFromBlock(header, block)
		warnings = append(warnings, siteWarnings...)
		if cfg == nil {
			continue
		}
		now := nowRFC3339()
		sites = append(sites, Site{
			Name:      siteNameFromDomains(cfg.Domains, len(sites)),
			Enabled:   true,
			Config:    *cfg,
			Revision:  1,
			CreatedAt: now,
			UpdatedAt: now,
		})
	}
	return sites, warnings
}

func tokenizeCaddyfile(content string) []caddyToken {
	var tokens []caddyToken
	line := 1
	for i := 0; i < len(content); {
		c := content[i]
		switch {
		case c == '\n':
			line++
			i++
		case c == ' ' || c == '\t' || c == '\r':
			i++
		case c == '#':
			for i < len(content) && content[i] != '\n' {
				i++
			}
		case c == '"':
			i++
			var b strings.Builder
			for i < len(content) {
				ch := content[i]
				if ch == '\\' && i+1 < len(content) {
					next := content[i+1]
					if next == '"' || next == '\\' {
						b.WriteByte(next)
						i += 2
						continue
					}
					b.WriteByte(ch)
					i++
					continue
				}
				if ch == '"' {
					i++
					break
				}
				if ch == '\n' {
					line++
				}
				b.WriteByte(ch)
				i++
			}
			tokens = append(tokens, caddyToken{text: b.String(), line: line, quoted: true})
		default:
			start := i
			for i < len(content) {
				ch := content[i]
				if ch == ' ' || ch == '\t' || ch == '\r' || ch == '\n' || ch == '"' {
					break
				}
				i++
			}
			text := content[start:i]
			if text != "" {
				tokens = append(tokens, caddyToken{text: text, line: line})
			}
		}
	}
	return tokens
}

func groupTokensByLine(tokens []caddyToken) [][]caddyToken {
	var lines [][]caddyToken
	for _, tok := range tokens {
		if len(lines) == 0 || lines[len(lines)-1][0].line != tok.line {
			lines = append(lines, []caddyToken{tok})
			continue
		}
		lines[len(lines)-1] = append(lines[len(lines)-1], tok)
	}
	return lines
}

// skipBlockLines advances past the line containing the opening brace and its
// matching close brace. It returns the index of the last consumed line.
func skipBlockLines(lines [][]caddyToken, index int) int {
	depth := 0
	opened := false
	for i := index; i < len(lines); i++ {
		for _, tok := range lines[i] {
			switch tok.text {
			case "{":
				depth++
				opened = true
			case "}":
				depth--
			}
		}
		if opened && depth <= 0 {
			return i
		}
	}
	return len(lines) - 1
}

// readSiteBlock reads "addresses... {" lines, the block body and returns the
// index of the last consumed line.
func readSiteBlock(lines [][]caddyToken, index int) (header []caddyToken, body []caddyToken, last int, ok bool) {
	braceLine, bracePos := -1, -1
	for pos, tok := range lines[index] {
		switch tok.text {
		case "{":
			braceLine, bracePos = index, pos
		case "}":
			return nil, nil, index, false
		}
		if braceLine >= 0 {
			break
		}
	}
	if braceLine < 0 {
		// Allow the opening brace on the first token of the next line.
		if index+1 < len(lines) && len(lines[index+1]) > 0 && lines[index+1][0].text == "{" {
			braceLine, bracePos = index+1, 0
		} else {
			return nil, nil, index, false
		}
	}
	if braceLine == index {
		header = append(header, lines[index][:bracePos]...)
	} else {
		header = append(header, lines[index]...)
	}

	depth := 0
	started := false
	for i := braceLine; i < len(lines); i++ {
		startPos := 0
		if i == braceLine {
			startPos = bracePos
		}
		for _, tok := range lines[i][startPos:] {
			switch tok.text {
			case "{":
				if started {
					body = append(body, tok)
				}
				depth++
				started = true
			case "}":
				depth--
				if depth == 0 {
					return header, body, i, true
				}
				body = append(body, tok)
			default:
				if started {
					body = append(body, tok)
				}
			}
		}
	}
	return nil, nil, index, false
}

func configFromBlock(header []caddyToken, body []caddyToken) (*SiteConfig, []string) {
	warnings := []string{}
	cfg := &SiteConfig{}
	scheme := ""
	var addresses []string
	for _, tok := range header {
		if tok.text == "{" || tok.text == "}" {
			continue
		}
		for _, addr := range strings.Split(tok.text, ",") {
			addr = strings.TrimSpace(addr)
			if addr != "" {
				addresses = append(addresses, addr)
			}
		}
	}
	for _, addr := range addresses {
		domain, addrScheme, port, warning := parseSiteAddress(addr)
		if warning != "" {
			warnings = append(warnings, warning)
		}
		if addrScheme == "http" {
			scheme = "http"
		}
		if domain != "" {
			cfg.Domains = append(cfg.Domains, domain)
		}
		if port != "" {
			cfg.Listen = append(cfg.Listen, ":"+port)
			warnings = append(warnings, "站点地址中的端口 "+port+" 已转换为 listen :"+port)
		}
	}
	if len(cfg.Domains) == 0 {
		warnings = append(warnings, "站点块没有可导入的域名，已跳过")
		return nil, warnings
	}

	directives := parseDirectives(body)
	var (
		root           string
		fileServer     bool
		spa            bool
		browse         bool
		precompressed  []string
		indexNames     []string
		reverseProxy   *SiteHandler
		redirect       *SiteHandler
		php            *SiteHandler
		basicAuthUsers []BasicAuthUser
	)
	for _, d := range directives {
		switch d.name {
		case "root":
			args := withoutMatcher(d.args)
			if len(args) > 0 {
				root = args[len(args)-1]
			}
		case "file_server":
			fileServer = true
			for _, arg := range d.args {
				if arg == "browse" {
					browse = true
				} else {
					warnings = append(warnings, fmt.Sprintf("第 %d 行：file_server 参数 %s 无法导入，已忽略", d.line, arg))
				}
			}
			for _, sub := range d.block {
				switch sub.name {
				case "browse":
					browse = true
				case "precompressed":
					precompressed = append(precompressed, sub.args...)
				default:
					warnings = append(warnings, fmt.Sprintf("第 %d 行：file_server 子指令 %s 无法导入，已忽略", sub.line, sub.name))
				}
			}
		case "try_files":
			for _, arg := range d.args {
				if arg == "/index.html" {
					spa = true
				}
			}
		case "index":
			indexNames = append(indexNames, d.args...)
		case "reverse_proxy":
			handler := &SiteHandler{Type: HandlerReverseProxy}
			for _, arg := range withoutMatcher(d.args) {
				if strings.HasPrefix(arg, "@") || strings.HasPrefix(arg, "/") {
					continue
				}
				handler.Upstreams = append(handler.Upstreams, caddyUpstreamToAPI(arg))
			}
			for _, sub := range d.block {
				switch sub.name {
				case "lb_policy":
					if len(sub.args) > 0 {
						handler.LoadBalance = sub.args[0]
					}
				case "health_uri":
					if len(sub.args) > 0 {
						handler.HealthURI = sub.args[0]
					}
				case "header_up":
					if len(sub.args) >= 2 {
						if handler.Headers == nil {
							handler.Headers = map[string]string{}
						}
						handler.Headers[sub.args[0]] = strings.Join(sub.args[1:], " ")
					}
				case "transport":
					for _, inner := range sub.block {
						if inner.name == "tls_insecure_skip_verify" {
							v := true
							handler.TLSSkipVerify = &v
						} else {
							warnings = append(warnings, fmt.Sprintf("第 %d 行：transport 子指令 %s 无法导入，已忽略", inner.line, inner.name))
						}
					}
				default:
					warnings = append(warnings, fmt.Sprintf("第 %d 行：reverse_proxy 子指令 %s 无法导入，已忽略", sub.line, sub.name))
				}
			}
			reverseProxy = handler
		case "redir":
			args := withoutMatcher(d.args)
			if len(args) == 0 {
				warnings = append(warnings, fmt.Sprintf("第 %d 行：redir 缺少目标，已忽略", d.line))
				continue
			}
			to := args[0]
			handler := &SiteHandler{Type: HandlerRedirect, To: to}
			if strings.HasSuffix(to, "{uri}") {
				handler.To = strings.TrimSuffix(to, "{uri}")
				v := true
				handler.PreserveQuery = &v
			}
			for _, arg := range args[1:] {
				if arg == "permanent" || arg == "301" || arg == "308" {
					v := true
					handler.Permanent = &v
				} else {
					warnings = append(warnings, fmt.Sprintf("第 %d 行：redir 状态码 %s 无法导入，已忽略", d.line, arg))
				}
			}
			redirect = handler
		case "tls":
			cfg.TLS = &SiteTLS{Mode: TLSModeAuto}
			for _, arg := range d.args {
				switch arg {
				case "internal":
					cfg.TLS.Mode = TLSModeInternal
				default:
					if strings.Contains(arg, "@") {
						cfg.TLS.Email = arg
					} else {
						warnings = append(warnings, fmt.Sprintf("第 %d 行：tls 参数 %s 无法导入，已忽略", d.line, arg))
					}
				}
			}
			for _, sub := range d.block {
				if sub.name == "dns" && len(sub.args) > 0 {
					cfg.TLS.Mode = TLSModeDNS
					cfg.TLS.DNSProvider = sub.args[0]
					continue
				}
				warnings = append(warnings, fmt.Sprintf("第 %d 行：tls 子指令 %s 无法导入，已忽略", sub.line, sub.name))
			}
		case "header":
			args := withoutMatcher(d.args)
			if len(args) == 0 {
				continue
			}
			name := args[0]
			if strings.HasPrefix(name, "-") || strings.HasPrefix(name, "+") {
				warnings = append(warnings, fmt.Sprintf("第 %d 行：header 操作 %s 无法导入，已忽略", d.line, name))
				continue
			}
			if len(args) < 2 {
				warnings = append(warnings, fmt.Sprintf("第 %d 行：header %s 缺少值，已忽略", d.line, name))
				continue
			}
			if cfg.Headers == nil {
				cfg.Headers = map[string]string{}
			}
			cfg.Headers[name] = strings.Join(args[1:], " ")
		case "encode":
			for _, arg := range d.args {
				if arg == "gzip" || arg == "zstd" {
					cfg.Encode = append(cfg.Encode, arg)
					continue
				}
				warnings = append(warnings, fmt.Sprintf("第 %d 行：encode %s 无法导入，已忽略", d.line, arg))
			}
		case "bind":
			cfg.Listen = append(cfg.Listen, d.args...)
		case "log":
			cfg.Log = true
			if d.hasBlock {
				warnings = append(warnings, fmt.Sprintf("第 %d 行：log 块配置无法导入，已退化为 log 开关", d.line))
			}
		case "basic_auth":
			for _, sub := range d.block {
				if len(sub.args) < 2 {
					warnings = append(warnings, fmt.Sprintf("第 %d 行：basic_auth 条目缺少哈希，已忽略", sub.line))
					continue
				}
				hash := sub.args[1]
				if !validBcryptHash(hash) {
					warnings = append(warnings, fmt.Sprintf("第 %d 行：basic_auth 用户 %s 的哈希不是 bcrypt，已忽略（不会存明文）", sub.line, sub.args[0]))
					continue
				}
				basicAuthUsers = append(basicAuthUsers, BasicAuthUser{Username: sub.args[0], PasswordHash: hash})
			}
		case "php_fastcgi":
			args := withoutMatcher(d.args)
			handler := &SiteHandler{Type: HandlerPHPFastCGI}
			if len(args) > 0 {
				handler.Address = caddyUpstreamToAPI(args[len(args)-1])
			}
			php = handler
		case "handle", "handle_path", "route", "respond", "rewrite", "uri", "abort", "error", "import", "php", "fastcgi", "method":
			warnings = append(warnings, fmt.Sprintf("第 %d 行：指令 %s 无法导入，已忽略", d.line, d.name))
		default:
			if strings.HasPrefix(d.name, "@") {
				warnings = append(warnings, fmt.Sprintf("第 %d 行：命名匹配器 %s 无法导入，已忽略", d.line, d.name))
				continue
			}
			warnings = append(warnings, fmt.Sprintf("第 %d 行：未知指令 %s 无法导入，已忽略", d.line, d.name))
		}
	}

	if scheme == "http" {
		if cfg.TLS == nil {
			cfg.TLS = &SiteTLS{Mode: TLSModeOff}
		} else {
			cfg.TLS.Mode = TLSModeOff
		}
	}

	switch {
	case reverseProxy != nil:
		if fileServer && root != "" {
			warnings = append(warnings, "站点同时包含 reverse_proxy 与 file_server，已按 reverse_proxy 导入")
		}
		cfg.Handler = *reverseProxy
	case php != nil:
		php.Root = root
		php.IndexNames = indexNames
		cfg.Handler = *php
	case redirect != nil:
		cfg.Handler = *redirect
	case fileServer || root != "":
		handler := SiteHandler{Type: HandlerFileServer, Root: root, IndexNames: indexNames}
		if spa {
			v := true
			handler.SPA = &v
		}
		if browse {
			v := true
			handler.Browse = &v
		}
		handler.Precompressed = precompressed
		cfg.Handler = handler
	case len(basicAuthUsers) > 0:
		warnings = append(warnings, "站点没有 handler，已跳过")
		return nil, warnings
	default:
		warnings = append(warnings, "站点没有可导入的 handler，已跳过")
		return nil, warnings
	}
	if len(basicAuthUsers) > 0 {
		cfg.BasicAuth = &BasicAuth{Users: basicAuthUsers}
	}
	return cfg, warnings
}

// parseDirectives groups tokens into line-based directives and recurses into
// nested blocks.
func parseDirectives(tokens []caddyToken) []caddyDirective {
	var out []caddyDirective
	for i := 0; i < len(tokens); {
		if tokens[i].text == "}" {
			i++
			continue
		}
		d := caddyDirective{name: tokens[i].text, line: tokens[i].line}
		i++
		for i < len(tokens) && tokens[i].line == d.line && tokens[i].text != "{" && tokens[i].text != "}" {
			d.args = append(d.args, tokens[i].text)
			i++
		}
		if i < len(tokens) && tokens[i].line == d.line && tokens[i].text == "{" {
			d.hasBlock = true
			i++
			depth := 1
			start := i
			for i < len(tokens) && depth > 0 {
				switch tokens[i].text {
				case "{":
					depth++
				case "}":
					depth--
				}
				if depth == 0 {
					break
				}
				i++
			}
			d.block = parseDirectives(tokens[start:i])
			if i < len(tokens) {
				i++ // consume closing brace
			}
		}
		out = append(out, d)
	}
	return out
}

func withoutMatcher(args []string) []string {
	out := make([]string, 0, len(args))
	for _, arg := range args {
		if arg == "*" {
			continue
		}
		out = append(out, arg)
	}
	return out
}

// caddyUpstreamToAPI maps Caddy's unix//path form back to unix:/path.
func caddyUpstreamToAPI(upstream string) string {
	if strings.HasPrefix(upstream, "unix//") {
		return "unix:" + strings.TrimPrefix(upstream, "unix/")
	}
	return upstream
}

func parseSiteAddress(addr string) (domain, scheme, port, warning string) {
	if strings.HasPrefix(addr, "http://") {
		scheme = "http"
		addr = strings.TrimPrefix(addr, "http://")
	} else if strings.HasPrefix(addr, "https://") {
		scheme = "https"
		addr = strings.TrimPrefix(addr, "https://")
	}
	addr = strings.TrimSuffix(addr, "/")
	if host, p, err := net.SplitHostPort(addr); err == nil {
		domain, port = host, p
	} else if strings.HasPrefix(addr, ":") {
		port = strings.TrimPrefix(addr, ":")
	} else {
		domain = addr
	}
	if domain != "" && !validDomain(domain) {
		warning = "站点地址 " + safeForMessage(domain) + " 不是合法域名，已忽略"
		domain = ""
	}
	return domain, scheme, port, warning
}

func siteNameFromDomains(domains []string, index int) string {
	if len(domains) > 0 {
		base := strings.TrimPrefix(domains[0], "*.")
		var b strings.Builder
		for _, r := range base {
			if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '.' {
				b.WriteRune(r)
			} else {
				b.WriteByte('-')
			}
		}
		if b.Len() > 0 {
			return b.String()
		}
	}
	return fmt.Sprintf("imported-%d", index+1)
}
