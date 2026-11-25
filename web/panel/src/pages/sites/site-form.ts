import type {
  FileServerHandler,
  RedirectHandler,
  ReverseProxyHandler,
  SiteConfig,
  SiteHandler,
} from '@/api/types';

export interface SiteDraft {
  name: string;
  enabled: boolean;
  config: SiteConfig;
}

export const EMPTY_SITE_DRAFT: SiteDraft = {
  name: '',
  enabled: true,
  config: {
    domains: [''],
    handler: { type: 'reverse_proxy', upstreams: [''] },
    tls: { mode: 'auto' },
    encode: ['gzip', 'zstd'],
    log: true,
  },
};

export function emptySiteDraft(): SiteDraft {
  return {
    name: '',
    enabled: true,
    config: {
      domains: [''],
      handler: { type: 'reverse_proxy', upstreams: [''] },
      tls: { mode: 'auto' },
      encode: ['gzip', 'zstd'],
      log: true,
    },
  };
}

export const HANDLER_LABEL: Record<SiteHandler['type'], string> = {
  reverse_proxy: '反向代理',
  file_server: '静态文件',
  redirect: '重定向',
};

const HOSTNAME_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.?$/i;
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

function validateDomain(domain: string): string | null {
  if (domain.length > 253) return '域名过长';
  if (domain.includes('://')) return '域名不能包含协议';
  if (/[\s/\\]/.test(domain)) return '域名不能包含空白或路径';
  if (domain === 'localhost') return null;
  if (IPV4_RE.test(domain)) return null;
  if (!HOSTNAME_RE.test(domain)) return '域名格式不正确';
  return null;
}

function validateHeaders(headers: Record<string, string> | undefined): string | null {
  if (headers === undefined) return null;
  for (const [name, value] of Object.entries(headers)) {
    if (!HEADER_NAME_RE.test(name)) return `响应头名称不合法：${name}`;
    if (/[\u0000-\u001f\u007f]/.test(value)) return `响应头值包含控制字符：${name}`;
  }
  return null;
}

export function validateSiteDraft(draft: SiteDraft): string | null {
  if (draft.name.trim().length === 0) return '请填写站点名称。';
  if (draft.name.length > 100) return '站点名称不能超过 100 个字符。';

  const domains = draft.config.domains.map((domain) => domain.trim()).filter((domain) => domain.length > 0);
  if (domains.length === 0) return '至少填写一个域名。';
  if (domains.length > 50) return '域名最多 50 个。';
  const seen = new Set<string>();
  for (const domain of domains) {
    const problem = validateDomain(domain);
    if (problem !== null) return `${problem}：${domain}`;
    if (seen.has(domain.toLowerCase())) return `域名重复：${domain}`;
    seen.add(domain.toLowerCase());
  }

  for (const listen of draft.config.listen ?? []) {
    if (listen.trim().length === 0) return '监听地址不能为空。';
    if (/\s/.test(listen.trim())) return `监听地址不能包含空白：${listen}`;
  }

  const handler = draft.config.handler;
  if (handler.type === 'reverse_proxy') {
    const upstreams = handler.upstreams.map((item) => item.trim()).filter((item) => item.length > 0);
    if (upstreams.length === 0) return '反向代理至少需要一个上游地址。';
    for (const upstream of upstreams) {
      if (/[\s"'{}]/.test(upstream)) return `上游地址包含非法字符（空白/引号/花括号）：${upstream}`;
    }
    if (handler.healthUri !== undefined && /[\s"'{}]/.test(handler.healthUri)) {
      return '健康检查 URI 不能包含空白、引号或花括号。';
    }
    const problem = validateHeaders(handler.headers);
    if (problem !== null) return problem;
  } else if (handler.type === 'file_server') {
    const root = handler.root.trim();
    if (root.length === 0) return '静态文件站点需要根目录。';
    if (!/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(root)) {
      return '根目录必须是绝对路径（以 / 或盘符开头）。';
    }
  } else {
    const to = handler.to.trim();
    if (to.length === 0) return '请填写重定向目标。';
    if (/[\u0000-\u001f"]/.test(to)) return '重定向目标不能包含引号或控制字符。';
  }

  const headerProblem = validateHeaders(draft.config.headers);
  if (headerProblem !== null) return headerProblem;

  const email = draft.config.tls?.email;
  if (email !== undefined && email.length > 0 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return 'ACME 邮箱格式不正确。';
  }
  return null;
}

export function parseCommaList(raw: string): string[] | undefined {
  const list = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return list.length === 0 ? undefined : list;
}

export function defaultHandler(type: SiteHandler['type']): SiteHandler {
  if (type === 'reverse_proxy') {
    return { type, upstreams: [''] } satisfies ReverseProxyHandler;
  }
  if (type === 'file_server') {
    return { type, root: '', spa: false, browse: false } satisfies FileServerHandler;
  }
  return { type, to: '', permanent: true, preserveQuery: true } satisfies RedirectHandler;
}
