/**
 * 结构化站点配置 → Caddyfile 的纯函数生成器与校验器。
 *
 * 安全边界（architecture §6.5）：
 * - 所有进入 Caddyfile 的用户字符串都先经本文件的白名单校验，再经
 *   quoteCaddyToken() 转义；指令名与结构由代码固定，绝不拼接用户输入。
 * - 域名、listen 地址、upstream、header 名/值、root 路径、redirect 目标
 *   全部拒绝控制字符与结构字符。
 * - 本文件不访问文件系统、不执行命令，preview 与 apply 共用同一条生成路径。
 */
import { PanelError, SITE_DOMAIN_PATTERN, siteConfigSchema } from '@mpanel/shared';
import type { Site, SiteConfig, SitePreviewResult } from '@mpanel/shared';

const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;
const BARE_TOKEN_FORBIDDEN = /[\s\u0000-\u001f\u007f"'{}]/;

/** 与 shared siteListenSchema 保持一致（shared 未单独导出该正则）。 */
const LISTEN_PATTERN = /^(?::\d{1,5}|(?:\[[0-9a-fA-F:]+\]|[0-9.]+):\d{1,5})$/;
/** RFC 7230 token。 */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const LOAD_BALANCE_POLICIES = new Set(['round_robin', 'random', 'least_conn', 'uri_hash']);
const ABSOLUTE_PATH_PATTERN = /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/;

/* ------------------------------------------------------------------ */
/* 校验器（导出，供单测与路由边界复用）                                 */
/* ------------------------------------------------------------------ */

export function validateSiteDomain(value: string): string {
  if (value.length === 0 || value.length > 253 || !SITE_DOMAIN_PATTERN.test(value)) {
    throw new PanelError('BAD_REQUEST', '域名格式不合法', { field: 'domains', value });
  }
  return value;
}

/** upstream 只能是 host:port、[ipv6]:port 或 unix/<socket 路径>。 */
export function validateCaddyUpstream(value: string): string {
  if (value.length === 0 || value.length > 2048 || BARE_TOKEN_FORBIDDEN.test(value)) {
    throw new PanelError('BAD_REQUEST', 'upstream 包含非法字符', { field: 'upstreams' });
  }
  if (value.startsWith('unix/')) {
    const socketPath = value.slice('unix/'.length);
    if (socketPath.length === 0 || !socketPath.startsWith('/')) {
      throw new PanelError('BAD_REQUEST', 'unix socket 路径必须是绝对路径（unix//path/to.sock）', {
        field: 'upstreams',
      });
    }
    if (socketPath.split('/').some((segment) => segment === '..')) {
      throw new PanelError('BAD_REQUEST', 'unix socket 路径不允许包含 ..', { field: 'upstreams' });
    }
    return value;
  }
  if (value.includes('://') || value.includes('@')) {
    throw new PanelError('BAD_REQUEST', 'upstream 必须是 host:port 或 unix socket', {
      field: 'upstreams',
    });
  }
  const match = /^(?:\[([0-9a-fA-F:.]+)\]|([A-Za-z0-9._-]+)):(\d{1,5})$/.exec(value);
  if (!match) {
    throw new PanelError('BAD_REQUEST', 'upstream 必须是 host:port 或 unix socket', {
      field: 'upstreams',
    });
  }
  const host = match[1] ?? match[2] ?? '';
  const port = Number(match[3]);
  if (host.length === 0 || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new PanelError('BAD_REQUEST', 'upstream 端口不合法', { field: 'upstreams' });
  }
  return value;
}

export function validateListenAddress(value: string): string {
  if (!LISTEN_PATTERN.test(value)) {
    throw new PanelError('BAD_REQUEST', 'bind 地址格式不合法', { field: 'listen', value });
  }
  const portToken = value.slice(value.lastIndexOf(':') + 1);
  if (/^\d+$/.test(portToken)) {
    const port = Number(portToken);
    if (port < 1 || port > 65535) {
      throw new PanelError('BAD_REQUEST', 'bind 端口超出范围', { field: 'listen', value });
    }
  }
  return value;
}

/** file_server.root 必须是绝对宿主路径，且不允许 .. 段。 */
export function validateSiteRoot(value: string): string {
  if (
    value.length === 0 ||
    value.length > 4096 ||
    CONTROL_CHAR_PATTERN.test(value) ||
    !ABSOLUTE_PATH_PATTERN.test(value)
  ) {
    throw new PanelError('BAD_REQUEST', '站点根目录必须是绝对路径', { field: 'root' });
  }
  if (value.split(/[\\/]/).some((segment) => segment === '..')) {
    throw new PanelError('BAD_REQUEST', '站点根目录不允许包含 ..', { field: 'root' });
  }
  return value;
}

export function validateHeaderName(value: string): string {
  if (value.length === 0 || value.length > 128 || !HEADER_NAME_PATTERN.test(value)) {
    throw new PanelError('BAD_REQUEST', 'HTTP header 名不合法', { field: 'headers' });
  }
  return value;
}

export function validateHeaderValue(value: string): string {
  if (value.length > 4096 || CONTROL_CHAR_PATTERN.test(value)) {
    throw new PanelError('BAD_REQUEST', 'HTTP header 值包含控制字符', { field: 'headers' });
  }
  return value;
}

export function assertDistinctDomains(domains: readonly string[]): void {
  const seen = new Set<string>();
  for (const domain of domains) {
    validateSiteDomain(domain);
    const key = domain.toLowerCase();
    if (seen.has(key)) {
      throw new PanelError('BAD_REQUEST', '站点内域名重复', { field: 'domains', value: domain });
    }
    seen.add(key);
  }
}

/* ------------------------------------------------------------------ */
/* 转义                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Caddy token 引号化：拒绝所有控制字符，转义反斜杠与双引号。
 * preview/apply 生成 Caddyfile 时必须调用。
 */
export function quoteCaddyToken(value: string): string {
  if (CONTROL_CHAR_PATTERN.test(value)) {
    throw new PanelError('BAD_REQUEST', 'Caddyfile 值包含控制字符', { field: 'value' });
  }
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/* ------------------------------------------------------------------ */
/* 生成                                                                 */
/* ------------------------------------------------------------------ */

function renderTlsLines(config: SiteConfig, lines: string[]): void {
  const tls = config.tls;
  const mode = tls?.mode ?? 'auto';
  if (mode === 'internal') {
    lines.push('\ttls internal');
    return;
  }
  if (mode === 'auto' && tls?.email) {
    lines.push(`\ttls ${quoteCaddyToken(tls.email)}`);
  }
}

function renderProxyHandler(
  handler: Extract<SiteConfig['handler'], { type: 'reverse_proxy' }>,
  lines: string[],
): void {
  const upstreams = handler.upstreams.map((upstream) =>
    quoteCaddyToken(validateCaddyUpstream(upstream)),
  );
  if (handler.loadBalance !== undefined && !LOAD_BALANCE_POLICIES.has(handler.loadBalance)) {
    throw new PanelError('BAD_REQUEST', '负载均衡策略不合法', { field: 'loadBalance' });
  }
  const headerEntries = Object.entries(handler.headers ?? {}).sort(([a], [b]) =>
    a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0,
  );
  const hasBlock =
    handler.loadBalance !== undefined ||
    handler.healthUri !== undefined ||
    headerEntries.length > 0 ||
    handler.tlsSkipVerify === true;

  if (!hasBlock) {
    lines.push(`\treverse_proxy ${upstreams.join(' ')}`);
    return;
  }
  lines.push(`\treverse_proxy ${upstreams.join(' ')} {`);
  if (handler.loadBalance !== undefined) {
    lines.push(`\t\tlb_policy ${handler.loadBalance}`);
  }
  if (handler.healthUri !== undefined) {
    lines.push(`\t\thealth_uri ${quoteCaddyToken(handler.healthUri)}`);
  }
  for (const [name, value] of headerEntries) {
    lines.push(
      `\t\theader_up ${quoteCaddyToken(validateHeaderName(name))} ${quoteCaddyToken(
        validateHeaderValue(value),
      )}`,
    );
  }
  if (handler.tlsSkipVerify === true) {
    lines.push('\t\ttransport http {');
    lines.push('\t\t\ttls_insecure_skip_verify');
    lines.push('\t\t}');
  }
  lines.push('\t}');
}

function renderFileServerHandler(
  handler: Extract<SiteConfig['handler'], { type: 'file_server' }>,
  lines: string[],
): void {
  const root = validateSiteRoot(handler.root);
  lines.push(`\troot * ${quoteCaddyToken(root)}`);
  if (handler.spa === true) {
    lines.push('\ttry_files {path} /index.html');
  }
  const indexNames = (handler.indexNames ?? []).map((name) => quoteCaddyToken(name));
  const precompressed = handler.precompressed ?? [];
  const needsBlock = indexNames.length > 0 || precompressed.length > 0;
  if (!needsBlock) {
    lines.push(handler.browse === true ? '\tfile_server browse' : '\tfile_server');
    return;
  }
  lines.push('\tfile_server {');
  if (indexNames.length > 0) {
    lines.push(`\t\tindex ${indexNames.join(' ')}`);
  }
  if (handler.browse === true) {
    lines.push('\t\tbrowse');
  }
  if (precompressed.length > 0) {
    lines.push(`\t\tprecompressed ${precompressed.join(' ')}`);
  }
  lines.push('\t}');
}

function renderRedirectHandler(
  handler: Extract<SiteConfig['handler'], { type: 'redirect' }>,
  lines: string[],
): void {
  if (CONTROL_CHAR_PATTERN.test(handler.to) || /["\r\n]/.test(handler.to)) {
    throw new PanelError('BAD_REQUEST', '跳转目标包含非法字符', { field: 'to' });
  }
  const target = handler.preserveQuery === true ? `${handler.to}{uri}` : handler.to;
  lines.push(`\tredir ${quoteCaddyToken(target)}${handler.permanent === true ? ' permanent' : ''}`);
}

/** 生成单个站点的 Caddyfile 片段（不含站点名等元数据）。 */
export function renderSiteConfig(config: SiteConfig): string {
  assertDistinctDomains(config.domains);
  const tlsMode = config.tls?.mode ?? 'auto';
  const addresses = config.domains.map((domain) =>
    tlsMode === 'off' ? `http://${validateSiteDomain(domain)}` : validateSiteDomain(domain),
  );
  const lines: string[] = [`${addresses.join(', ')} {`];

  renderTlsLines(config, lines);

  for (const listen of config.listen ?? []) {
    lines.push(`\tbind ${quoteCaddyToken(validateListenAddress(listen))}`);
  }

  const handler = config.handler;
  switch (handler.type) {
    case 'reverse_proxy':
      renderProxyHandler(handler, lines);
      break;
    case 'file_server':
      renderFileServerHandler(handler, lines);
      break;
    case 'redirect':
      renderRedirectHandler(handler, lines);
      break;
    default: {
      const exhaustive: never = handler;
      throw new PanelError('BAD_REQUEST', '不支持的站点 handler', { handler: exhaustive });
    }
  }

  const headerEntries = Object.entries(config.headers ?? {}).sort(([a], [b]) =>
    a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0,
  );
  for (const [name, value] of headerEntries) {
    lines.push(
      `\theader ${quoteCaddyToken(validateHeaderName(name))} ${quoteCaddyToken(
        validateHeaderValue(value),
      )}`,
    );
  }
  if ((config.encode ?? []).length > 0) {
    lines.push(`\tencode ${(config.encode ?? []).join(' ')}`);
  }
  if (config.log === true) {
    lines.push('\tlog');
  }
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

/** 生成单个站点的片段；站点元数据（名称/状态）不进入 Caddyfile。 */
export function renderSite(site: Site): string {
  return renderSiteConfig(site.config);
}

/**
 * 生成受管根 Caddyfile：可选全局块（admin）+ `import sites.d/*.caddy`。
 * 相对 import 路径以根 Caddyfile 所在目录解析，因此 staging 与线上目录结构一致。
 */
export function renderRootConfig(sites: Site[], opts: { adminAddress?: string }): string {
  const lines: string[] = [];
  if (opts.adminAddress) {
    lines.push('{');
    lines.push(`\tadmin ${quoteCaddyToken(opts.adminAddress)}`);
    lines.push('}');
    lines.push('');
  }
  const enabled = sites.filter((site) => site.enabled).length;
  lines.push(`# MPanel 生成的根配置：${enabled} 个启用站点，请勿手工修改`);
  lines.push('import sites.d/*.caddy');
  return `${lines.join('\n')}\n`;
}

/** 契约别名：站点 → Caddyfile。 */
export function generateCaddyfile(site: Site): string {
  return renderSite(site);
}

/** 契约别名：SiteConfig → Caddyfile 片段。 */
export function generateSnippet(config: SiteConfig): string {
  return renderSiteConfig(config);
}

/* ------------------------------------------------------------------ */
/* 警告                                                                 */
/* ------------------------------------------------------------------ */

/** 配置级提示（与站点元数据无关）。 */
export function collectConfigWarnings(config: SiteConfig): string[] {
  const warnings: string[] = [];
  const tlsMode = config.tls?.mode ?? 'auto';
  if (tlsMode === 'off') {
    warnings.push('TLS 已关闭：站点只通过 http 提供服务');
  } else if (tlsMode === 'internal') {
    warnings.push('使用 Caddy 内部 CA：客户端需要安装并信任 Caddy 根证书');
    if (config.tls?.email) {
      warnings.push('tls.email 仅在 auto 模式下生效，internal 模式已忽略');
    }
  }
  if (tlsMode === 'auto') {
    for (const domain of config.domains) {
      if (domain.startsWith('*.')) {
        warnings.push(
          `通配符域名 ${domain} 无法使用 HTTP-01 自动签发，需要 DNS challenge 或改用 internal/off 模式`,
        );
      }
    }
  }
  for (const listen of config.listen ?? []) {
    if (listen.startsWith(':') || listen.startsWith('0.0.0.0:')) {
      warnings.push(`bind 地址 ${listen} 监听所有网卡，请确认防火墙与暴露面`);
    }
  }
  if (config.handler.type === 'file_server') {
    if (config.handler.browse === true) {
      warnings.push('file_server 已开启 browse：目录内容会被公开列出');
    }
    if (config.handler.spa === true && config.handler.browse === true) {
      warnings.push('spa 与 browse 同时开启时，未命中的路径会先回退到 index.html');
    }
  }
  return warnings;
}

/** 站点级提示：配置警告 + 未应用状态 + 跨站点域名冲突。 */
export function siteWarnings(site: Site, all: Site[]): string[] {
  const out: string[] = [];
  if (!site.enabled) {
    out.push(`站点「${site.name}」已禁用，apply 时不会写入 Caddyfile`);
  } else if (site.appliedRevision === null) {
    out.push(`站点「${site.name}」尚未应用`);
  } else if (site.appliedRevision !== site.revision) {
    out.push(
      `站点「${site.name}」有未应用的修改（revision ${site.revision}，已应用 ${site.appliedRevision}）`,
    );
  }
  out.push(...collectConfigWarnings(site.config));
  const ownDomains = new Set(site.config.domains.map((domain) => domain.toLowerCase()));
  for (const other of all) {
    if (other.id === site.id || !other.enabled) continue;
    for (const domain of other.config.domains) {
      if (ownDomains.has(domain.toLowerCase())) {
        out.push(`域名 ${domain} 同时被站点「${site.name}」与「${other.name}」使用，Caddy 只会匹配其中一个`);
      }
    }
  }
  return [...new Set(out)];
}

/** 纯预览：生成片段 + 警告，不做校验（validation 恒为 null）。 */
export function renderPreview(config: SiteConfig): SitePreviewResult {
  return {
    caddyfile: renderSiteConfig(config),
    warnings: collectConfigWarnings(config),
    validation: null,
  };
}

/* ------------------------------------------------------------------ */
/* 现有 Caddyfile 解析（离线工具，不暴露为 API）                        */
/* ------------------------------------------------------------------ */

export interface ParsedCaddySite {
  addresses: string[];
  config: SiteConfig | null;
  notes: string[];
}

type Token =
  | { kind: 'word'; value: string }
  | { kind: 'open' }
  | { kind: 'close' }
  | { kind: 'newline' };

interface Statement {
  tokens: string[];
  children: Statement[];
}

/**
 * 扫描 Caddyfile 结构。支持引号、反引号、# 注释、分号与花括号嵌套；
 * 不是完整 Caddyfile 词法器，但足以还原本项目生成的配置。
 */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let word = '';
  let index = 0;
  const flush = (): void => {
    if (word.length > 0) {
      tokens.push({ kind: 'word', value: word });
      word = '';
    }
  };
  while (index < text.length) {
    const char = text[index]!;
    if (char === '#') {
      flush();
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (char === '"') {
      flush();
      index += 1;
      let value = '';
      while (index < text.length && text[index] !== '"') {
        if (text[index] === '\\' && index + 1 < text.length) {
          value += text[index + 1];
          index += 2;
        } else {
          value += text[index];
          index += 1;
        }
      }
      index += 1;
      tokens.push({ kind: 'word', value });
      continue;
    }
    if (char === '`') {
      flush();
      index += 1;
      let value = '';
      while (index < text.length && text[index] !== '`') {
        value += text[index];
        index += 1;
      }
      index += 1;
      tokens.push({ kind: 'word', value });
      continue;
    }
    if (char === '{' || char === '}') {
      // Caddy 占位符 `{path}`/`{uri}` 与块花括号同字面，无空白的 {…} 视为单词内容。
      if (char === '{') {
        const close = text.indexOf('}', index + 1);
        if (close !== -1) {
          const inner = text.slice(index + 1, close);
          if (inner.length > 0 && !/[\s{}]/.test(inner)) {
            word += text.slice(index, close + 1);
            index = close + 1;
            continue;
          }
        }
      }
      flush();
      tokens.push(char === '{' ? { kind: 'open' } : { kind: 'close' });
      index += 1;
      continue;
    }
    if (char === '\r') {
      index += 1;
      continue;
    }
    if (char === '\n' || char === ';') {
      flush();
      tokens.push({ kind: 'newline' });
      index += 1;
      continue;
    }
    if (char === ' ' || char === '\t') {
      flush();
      index += 1;
      continue;
    }
    word += char;
    index += 1;
  }
  flush();
  if (tokens.length === 0 || tokens[tokens.length - 1]!.kind !== 'newline') {
    tokens.push({ kind: 'newline' });
  }
  return tokens;
}

function parseStatements(
  tokens: Token[],
  start: number,
  expectClose: boolean,
): { statements: Statement[]; index: number } {
  const statements: Statement[] = [];
  let current: Statement | null = null;
  let index = start;
  while (index < tokens.length) {
    const token = tokens[index]!;
    if (token.kind === 'close') {
      if (current) {
        statements.push(current);
        current = null;
      }
      if (expectClose) return { statements, index: index + 1 };
      index += 1;
      continue;
    }
    if (token.kind === 'open') {
      const nested = parseStatements(tokens, index + 1, true);
      const statement: Statement = {
        tokens: current ? current.tokens : [],
        children: nested.statements,
      };
      statements.push(statement);
      current = null;
      index = nested.index;
      continue;
    }
    if (token.kind === 'newline') {
      if (current) {
        statements.push(current);
        current = null;
      }
      index += 1;
      continue;
    }
    if (!current) current = { tokens: [], children: [] };
    current.tokens.push(token.value);
    index += 1;
  }
  if (current) statements.push(current);
  return { statements, index };
}

interface ParsedAddress {
  domain: string;
  scheme?: 'http' | 'https';
  port?: string;
}

function parseCaddyAddress(raw: string): ParsedAddress | null {
  let value = raw.replace(/,+$/, '').trim();
  if (value.length === 0) return null;
  let scheme: 'http' | 'https' | undefined;
  const schemeMatch = /^(https?):\/\//i.exec(value);
  if (schemeMatch) {
    scheme = schemeMatch[1]!.toLowerCase() as 'http' | 'https';
    value = value.slice(schemeMatch[0].length);
  }
  if (value.includes('/')) return null;
  let port: string | undefined;
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end === -1) return null;
    const after = value.slice(end + 1);
    if (after.startsWith(':')) port = after.slice(1);
    value = value.slice(0, end + 1);
  } else {
    const colon = value.lastIndexOf(':');
    if (colon > 0 && /^\d+$/.test(value.slice(colon + 1))) {
      port = value.slice(colon + 1);
      value = value.slice(0, colon);
    }
  }
  if (value.length === 0) return null;
  return {
    domain: value,
    ...(scheme === undefined ? {} : { scheme }),
    ...(port === undefined ? {} : { port }),
  };
}

function statementArgs(statement: Statement): string[] {
  return statement.tokens.slice(1);
}

function isSimpleTryFiles(args: string[]): boolean {
  return args.length === 2 && args[0] === '{path}' && args[1] === '/index.html';
}

function reconstructSite(siteStatement: Statement): ParsedCaddySite {
  const notes: string[] = [];
  const addresses = siteStatement.tokens
    .flatMap((token) => token.split(','))
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  const parsedAddresses: ParsedAddress[] = [];
  for (const address of addresses) {
    const parsed = parseCaddyAddress(address);
    if (!parsed) {
      notes.push(`无法还原站点地址：${address}`);
      continue;
    }
    parsedAddresses.push(parsed);
  }

  const domains: string[] = [];
  for (const parsed of parsedAddresses) {
    try {
      validateSiteDomain(parsed.domain);
      if (!domains.some((domain) => domain.toLowerCase() === parsed.domain.toLowerCase())) {
        domains.push(parsed.domain);
      }
    } catch {
      notes.push(`无法还原域名：${parsed.domain}`);
    }
  }

  const listen: string[] = [];
  const headers: Record<string, string> = {};
  const encode: ('gzip' | 'zstd')[] = [];
  let log = false;
  let tlsMode: 'auto' | 'internal' | 'off' | undefined;
  let tlsEmail: string | undefined;
  let root: string | undefined;
  let spa = false;
  let browse = false;
  let indexNames: string[] | undefined;
  let precompressed: ('gzip' | 'zstd')[] | undefined;
  let upstreams: string[] | undefined;
  let loadBalance: 'round_robin' | 'random' | 'least_conn' | 'uri_hash' | undefined;
  let proxyHeaders: Record<string, string> | undefined;
  let tlsSkipVerify = false;
  let healthUri: string | undefined;
  let redirectTo: string | undefined;
  let redirectPermanent = false;
  let firstHandler: 'proxy' | 'redirect' | 'file_server' | null = null;

  for (const statement of siteStatement.children) {
    if (statement.tokens.length === 0) continue;
    const name = statement.tokens[0]!.toLowerCase();
    const args = statementArgs(statement);
    switch (name) {
      case 'tls': {
        if (args.length === 0) {
          notes.push('tls 指令缺少参数，按 auto 处理');
          tlsMode ??= 'auto';
        } else if (args[0] === 'internal') {
          tlsMode = 'internal';
        } else if (args[0]!.includes('@')) {
          tlsMode ??= 'auto';
          tlsEmail = args[0];
          if (args.length > 1) notes.push('tls 指令的额外参数已忽略');
        } else {
          notes.push(`tls 指令参数 ${args.join(' ')} 无法还原，按 auto 处理`);
          tlsMode ??= 'auto';
        }
        break;
      }
      case 'bind': {
        for (const arg of args) {
          if (LISTEN_PATTERN.test(arg)) {
            if (!listen.includes(arg)) listen.push(arg);
          } else {
            notes.push(`bind 地址 ${arg} 不合法，已忽略`);
          }
        }
        break;
      }
      case 'root': {
        const rootPath = args[0] === '*' ? args.slice(1).join(' ') : args.join(' ');
        if (rootPath.length === 0) notes.push('root 指令缺少路径');
        else root = rootPath;
        break;
      }
      case 'try_files': {
        if (isSimpleTryFiles(args)) spa = true;
        else notes.push('try_files 指令无法完整还原，已忽略');
        break;
      }
      case 'file_server': {
        firstHandler ??= 'file_server';
        for (const arg of args) {
          if (arg === 'browse') browse = true;
          else notes.push(`file_server 参数 ${arg} 已忽略`);
        }
        for (const child of statement.children) {
          const childName = child.tokens[0]?.toLowerCase();
          if (childName === 'browse') browse = true;
          else if (childName === 'precompressed') {
            precompressed = statementArgs(child).filter(
              (value): value is 'gzip' | 'zstd' => value === 'gzip' || value === 'zstd',
            );
          } else if (childName === 'index') {
            indexNames = statementArgs(child);
          } else if (childName) {
            notes.push(`file_server 子指令 ${childName} 已忽略`);
          }
        }
        break;
      }
      case 'reverse_proxy': {
        firstHandler ??= 'proxy';
        if (upstreams) {
          notes.push('存在多个 reverse_proxy，仅还原第一个');
          break;
        }
        const parsedUpstreams: string[] = [];
        for (const arg of args) {
          try {
            parsedUpstreams.push(validateCaddyUpstream(arg));
          } catch {
            notes.push(`upstream ${arg} 不合法，已忽略`);
          }
        }
        upstreams = parsedUpstreams;
        for (const child of statement.children) {
          const childName = child.tokens[0]?.toLowerCase();
          const childArgs = statementArgs(child);
          if (childName === 'lb_policy') {
            const value = childArgs[0];
            if (value && LOAD_BALANCE_POLICIES.has(value)) {
              loadBalance = value as typeof loadBalance;
            } else {
              notes.push(`lb_policy ${childArgs.join(' ')} 不合法，已忽略`);
            }
          } else if (childName === 'health_uri') {
            healthUri = childArgs[0];
          } else if (childName === 'header_up') {
            if (childArgs.length >= 2 && !childArgs[0]!.startsWith('-')) {
              proxyHeaders ??= {};
              proxyHeaders[childArgs[0]!] = childArgs.slice(1).join(' ');
            } else {
              notes.push('header_up 子指令无法还原，已忽略');
            }
          } else if (childName === 'transport') {
            for (const grandChild of child.children) {
              if (grandChild.tokens[0] === 'tls_insecure_skip_verify') {
                tlsSkipVerify = true;
              } else if (grandChild.tokens[0]) {
                notes.push(`transport 子指令 ${grandChild.tokens[0]} 已忽略`);
              }
            }
          } else if (childName) {
            notes.push(`reverse_proxy 子指令 ${childName} 已忽略`);
          }
        }
        break;
      }
      case 'redir':
      case 'redirect': {
        firstHandler ??= 'redirect';
        if (!redirectTo) {
          redirectTo = args[0];
          redirectPermanent = args.includes('permanent');
          if (args.length > 1 && !redirectPermanent) {
            notes.push('redir 的额外参数已忽略');
          }
        } else {
          notes.push('存在多个 redir，仅还原第一个');
        }
        break;
      }
      case 'header': {
        if (args.length === 0) break;
        if (args[0]!.startsWith('-') || args[0]!.startsWith('+') || statement.children.length > 0) {
          notes.push('header 删除/块语法无法还原，已忽略');
          break;
        }
        headers[args[0]!] = args.slice(1).join(' ');
        break;
      }
      case 'encode': {
        for (const arg of args) {
          if (arg === 'gzip' || arg === 'zstd') {
            if (!encode.includes(arg)) encode.push(arg);
          } else {
            notes.push(`encode ${arg} 已忽略`);
          }
        }
        break;
      }
      case 'log': {
        log = true;
        if (statement.children.length > 0) notes.push('log 的子指令已忽略');
        break;
      }
      case 'php_fastcgi':
        notes.push('php_fastcgi 无法用 SiteConfig 表达，已忽略');
        break;
      case 'basic_auth':
      case 'basicauth':
        notes.push('basic_auth 无法用 SiteConfig 表达，已忽略');
        break;
      case 'handle':
      case 'handle_path':
      case 'route':
      case 'import':
      case 'respond':
      case 'abort':
      case 'error':
      case 'rewrite':
      case 'uri':
        notes.push(`不支持还原指令 ${name}，已忽略`);
        break;
      default:
        notes.push(`忽略未支持的指令：${statement.tokens[0]!}`);
        break;
    }
  }

  for (const parsed of parsedAddresses) {
    if (parsed.port && LISTEN_PATTERN.test(`:${parsed.port}`)) {
      const listenValue = `:${parsed.port}`;
      if (!listen.includes(listenValue)) listen.push(listenValue);
      notes.push(`站点地址端口已还原为 listen ${listenValue}`);
    }
  }

  const schemeModes = new Set(parsedAddresses.map((parsed) => parsed.scheme));
  if (tlsMode === undefined) {
    if (schemeModes.size === 1 && schemeModes.has('http')) tlsMode = 'off';
    else if (schemeModes.size === 1 && schemeModes.has('https')) tlsMode = 'auto';
    else {
      if (schemeModes.size > 1) notes.push('站点地址混用 http/https，tls 模式按 auto 处理');
      tlsMode = 'auto';
    }
  } else if (tlsMode === 'off' && schemeModes.has('https')) {
    notes.push('https:// 地址与 TLS off 冲突，按 auto 处理');
    tlsMode = 'auto';
  }

  let handler: SiteConfig['handler'] | undefined;
  if (firstHandler === 'redirect' && redirectTo) {
    handler = {
      type: 'redirect',
      to: redirectTo,
      ...(redirectPermanent ? { permanent: true } : {}),
    };
  } else if (firstHandler === 'proxy' && upstreams && upstreams.length > 0) {
    handler = {
      type: 'reverse_proxy',
      upstreams,
      ...(loadBalance === undefined ? {} : { loadBalance }),
      ...(proxyHeaders === undefined ? {} : { headers: proxyHeaders }),
      ...(tlsSkipVerify ? { tlsSkipVerify: true } : {}),
      ...(healthUri === undefined ? {} : { healthUri }),
    };
  } else if (firstHandler === 'file_server') {
    if (!root) {
      notes.push('file_server 缺少 root，无法还原静态站点');
    } else {
      handler = {
        type: 'file_server',
        root,
        ...(indexNames === undefined ? {} : { indexNames }),
        ...(browse ? { browse: true } : {}),
        ...(spa ? { spa: true } : {}),
        ...(precompressed === undefined || precompressed.length === 0 ? {} : { precompressed }),
      };
    }
  } else if (firstHandler === null) {
    notes.push('未找到可识别的站点 handler（reverse_proxy/file_server/redirect）');
  } else {
    notes.push('站点 handler 无法还原');
  }

  if (!handler) {
    return { addresses, config: null, notes };
  }
  if (domains.length === 0) {
    notes.push('没有可用域名，无法还原站点');
    return { addresses, config: null, notes };
  }

  const candidate: SiteConfig = {
    domains,
    ...(listen.length > 0 ? { listen } : {}),
    handler,
    ...(tlsMode === undefined ? {} : { tls: { mode: tlsMode, ...(tlsEmail === undefined ? {} : { email: tlsEmail }) } }),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(encode.length > 0 ? { encode } : {}),
    ...(log ? { log: true } : {}),
  };

  const checked = siteConfigSchema.safeParse(candidate);
  if (!checked.success) {
    for (const issue of checked.error.issues) {
      notes.push(`还原结果校验失败：${issue.path.join('.')} ${issue.message}`);
    }
    return { addresses, config: null, notes };
  }
  return { addresses, config: checked.data, notes };
}

/**
 * 尽力解析现有 Caddyfile 中的站点块。
 *
 * 注意：契约（docs/api-contract.md §6.1/§6.5）禁止把原始 Caddyfile 作为站点
 * 导入入口，因此本函数只是离线工具与单测目标，不注册任何 API 路由；
 * 无法还原的指令进入 notes，绝不静默丢弃。
 */
export function parseCaddyfile(text: string): ParsedCaddySite[] {
  const statements = parseStatements(tokenize(text), 0, false).statements;
  const result: ParsedCaddySite[] = [];
  for (const statement of statements) {
    if (statement.tokens.length === 0) continue;
    if (statement.children.length === 0) continue;
    result.push(reconstructSite(statement));
  }
  return result;
}
