import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

/**
 * Core configuration (docs/file-layout.md §4.2).
 *
 * 环境变量同时兼容本轨道契约（MPANEL_CORE_HOME / MPANEL_LISTEN /
 * MPANEL_WEB_DIST / MPANEL_SESSION_SECRET / MPANEL_TOKEN_TTL）与文档中的
 * 历史名称（MPANEL_HOME / MPANEL_HOST / MPANEL_PORT / MPANEL_WEB_DIR …）。
 * 新名称优先，旧名称作为回退，避免两种部署脚本互相破坏。
 *
 * 校验方式：@mpanel/core 的 package.json 未声明 zod（zod 仅属于
 * @mpanel/shared 且未 re-export z），因此这里用显式的字段解析与结构化错误；
 * HTTP 请求体校验仍使用 shared 导出的 zod schema（见 auth/routes.ts）。
 */
export interface CoreConfig {
  home: string;
  /** 解析自 MPANEL_LISTEN 的原始值，便于日志展示。 */
  listen: string;
  /** Default 127.0.0.1. */
  host: string;
  /** Default 8788; 0 means random (smoke). */
  port: number;
  /** Public reverse-proxy URL used for reverse enrollment. */
  publicUrl?: string;
  /** web/dist; when missing only the API is served. */
  webDir?: string;
  /** MPANEL_ALLOW_STDIO=1. */
  allowStdio: boolean;
  /** MPANEL_WORKER_ENTRY, default stdio args. */
  workerEntry: string;
  corsOrigins: string[];
  dbxOrigin?: string;
  cookieName: string;
  cookieSecure: boolean;
  cookieSameSite: 'lax' | 'none' | 'strict';
  /** 会话 TTL（滑动续期），默认 12 小时。 */
  sessionTtlSec: number;
  /** API token 默认 TTL，默认同 MPANEL_TOKEN_TTL（12 小时）。 */
  tokenTtlSec: number;
  allowWsQuerySecret: boolean;
  redeemRateLimit: { windowSec: number; max: number };
  /** MPANEL_CSP static CSP override. */
  csp?: string;
  coreToken?: string;
  adminUser?: string;
  adminPassword?: string;
  trustProxy: boolean;
  secretKey?: string;
  /**
   * 会话签名/派生密钥。MPANEL_SESSION_SECRET 未设置时自动生成并持久化到
   * $HOME/session.secret（0600）。用于 HMAC API token 摘要。
   */
  sessionSecret: string;
  logLevel: string;
}

/** 配置错误：由 CLI 捕获后打印中文提示并以退出码 1 结束，绝不进入 HTTP 层。 */
export class CoreConfigError extends Error {
  readonly variable: string;

  constructor(variable: string, message: string) {
    super(`${variable}: ${message}`);
    this.name = 'CoreConfigError';
    this.variable = variable;
  }
}

const LOG_LEVELS = new Set(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

function read(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return undefined;
}

function fail(name: string, message: string): never {
  throw new CoreConfigError(name, message);
}

function parseBool(name: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fail(name, '必须是 true/false/1/0');
}

/** 解析 `10/60s`、`5/1m` 形式的限流配置。 */
function parseRate(name: string, value: string | undefined, max: number, windowSec: number): {
  windowSec: number;
  max: number;
} {
  if (value === undefined) return { max, windowSec };
  const match = /^(\d+)\s*\/\s*(\d+)\s*(ms|s|m|h|d)?$/.exec(value);
  if (match === null) return fail(name, '格式应为 `<次数>/<窗口>`，例如 10/60s');
  const count = Number(match[1]);
  const amount = Number(match[2]);
  const unit = match[3] ?? 's';
  if (!Number.isInteger(count) || count < 1) return fail(name, '次数必须是正整数');
  const multipliers: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 };
  const seconds = amount * (multipliers[unit] ?? 1);
  if (!(seconds > 0)) return fail(name, '窗口必须大于 0 秒');
  return { max: count, windowSec: Math.max(1, Math.round(seconds)) };
}

/** 解析 `3600`、`30m`、`12h`、`7d` 形式的 TTL（秒）。 */
function parseDuration(name: string, value: string | undefined, fallbackSec: number): number {
  if (value === undefined) return fallbackSec;
  const match = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(value);
  if (match === null) return fail(name, '格式应为秒数或 <数字><s|m|h|d>，例如 12h');
  const amount = Number(match[1]);
  const unit = match[2] ?? 's';
  const multipliers: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 };
  const seconds = Math.round(amount * (multipliers[unit] ?? 1));
  if (!(seconds > 0)) return fail(name, '必须大于 0');
  return seconds;
}

function parsePort(name: string, value: string): number {
  if (!/^\d+$/.test(value)) return fail(name, '端口必须是 0-65535 的整数');
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return fail(name, '端口必须是 0-65535 的整数');
  }
  return port;
}

/** 解析 MPANEL_LISTEN：`host:port`、`[::1]:port`、裸端口或 `:port`。 */
function parseListen(value: string): { host: string; port: number } {
  const trimmed = value.trim();
  if (trimmed === '') return fail('MPANEL_LISTEN', '不能为空');
  if (/^\d+$/.test(trimmed)) return { host: '127.0.0.1', port: parsePort('MPANEL_LISTEN', trimmed) };

  if (trimmed.startsWith('[')) {
    const match = /^\[([^\]]+)\]:(\d+)$/.exec(trimmed);
    if (match === null) return fail('MPANEL_LISTEN', 'IPv6 地址格式应为 [::1]:8788');
    return { host: match[1] ?? '::1', port: parsePort('MPANEL_LISTEN', match[2] ?? '') };
  }

  const index = trimmed.lastIndexOf(':');
  if (index < 0) return fail('MPANEL_LISTEN', '格式应为 host:port，例如 127.0.0.1:8788');
  const host = trimmed.slice(0, index).trim();
  const port = trimmed.slice(index + 1).trim();
  return { host: host === '' ? '127.0.0.1' : host, port: parsePort('MPANEL_LISTEN', port) };
}

function parseOrigin(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail(name, `不是合法 URL: ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return fail(name, '只支持 http/https 源');
  }
  if (url.origin !== value.replace(/\/$/, '')) {
    return fail(name, '必须是纯 origin（协议+主机+端口），不能带路径');
  }
  return url.origin;
}

function parseOrigins(name: string, value: string | undefined): string[] {
  if (value === undefined) return [];
  const parts = value
    .split(',')
    .flatMap((part) => part.split(/\s+/))
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.includes('*')) {
    return fail(name, '凭证模式下不允许通配符 *，请显式列出来源');
  }
  const origins = parts.map((part) => parseOrigin(name, part));
  return [...new Set(origins)];
}

function parseLogLevel(value: string | undefined): string {
  if (value === undefined) return 'info';
  if (!LOG_LEVELS.has(value)) {
    return fail('MPANEL_LOG_LEVEL', `必须是 ${[...LOG_LEVELS].join('/')} 之一`);
  }
  return value;
}

function resolvePath(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

/**
 * 读取/生成会话密钥由 auth/index.ts 的 ensureSessionSecret 完成；
 * 这里只保留环境变量值，未配置时给出静态占位，便于纯配置解析可测试。
 * （loadCoreConfig 不触碰文件系统，服务器启动时再落盘。）
 */
const SESSION_SECRET_PLACEHOLDER = '';

export function loadCoreConfig(env: NodeJS.ProcessEnv = process.env): CoreConfig {
  const homeRaw = read(env, 'MPANEL_CORE_HOME', 'MPANEL_HOME');
  const home = homeRaw === undefined
    ? defaultCoreHome()
    : resolvePath(homeRaw, defaultCoreHome());

  const listenValue = read(env, 'MPANEL_LISTEN');
  const legacyHost = read(env, 'MPANEL_HOST') ?? '127.0.0.1';
  const legacyPort = read(env, 'MPANEL_PORT', 'MPANEL_CORE_PORT') ?? '8788';
  const listen = parseListen(
    listenValue ?? `${legacyHost}:${parsePort('MPANEL_PORT', legacyPort)}`,
  );

  const publicUrlRaw = read(env, 'MPANEL_PUBLIC_URL');
  if (publicUrlRaw !== undefined) {
    try {
      const url = new URL(publicUrlRaw);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        fail('MPANEL_PUBLIC_URL', '只支持 http/https');
      }
    } catch (error) {
      if (error instanceof CoreConfigError) throw error;
      fail('MPANEL_PUBLIC_URL', '不是合法 URL');
    }
  }

  const dbxOriginRaw = read(env, 'MPANEL_DBX_ORIGIN');
  const dbxOrigin = dbxOriginRaw === undefined
    ? undefined
    : parseOrigin('MPANEL_DBX_ORIGIN', dbxOriginRaw);

  const tokenTtlSec = parseDuration('MPANEL_TOKEN_TTL', read(env, 'MPANEL_TOKEN_TTL'), 12 * 3600);
  const sessionTtlHours = read(env, 'MPANEL_SESSION_TTL_HOURS');
  const sessionTtlSec = sessionTtlHours === undefined
    ? tokenTtlSec
    : Math.max(60, Math.round(Number(sessionTtlHours) * 3600));
  if (sessionTtlHours !== undefined && (!Number.isFinite(Number(sessionTtlHours)) || Number(sessionTtlHours) <= 0)) {
    fail('MPANEL_SESSION_TTL_HOURS', '必须是大于 0 的小时数');
  }

  const cookieSameSiteRaw = (read(env, 'MPANEL_COOKIE_SAMESITE') ?? 'lax').toLowerCase();
  if (cookieSameSiteRaw !== 'lax' && cookieSameSiteRaw !== 'none' && cookieSameSiteRaw !== 'strict') {
    fail('MPANEL_COOKIE_SAMESITE', '必须是 lax/none/strict');
  }
  const cookieSameSite = cookieSameSiteRaw as 'lax' | 'none' | 'strict';
  const cookieSecure = parseBool(
    'MPANEL_COOKIE_SECURE',
    read(env, 'MPANEL_COOKIE_SECURE'),
    cookieSameSite === 'none' || (publicUrlRaw?.startsWith('https://') ?? false),
  );

  const adminUser = read(env, 'MPANEL_ADMIN_USER');
  const adminPassword = read(env, 'MPANEL_ADMIN_PASSWORD');
  if (adminUser !== undefined && adminPassword === undefined) {
    fail('MPANEL_ADMIN_PASSWORD', '设置 MPANEL_ADMIN_USER 时必须同时设置密码');
  }
  if (adminPassword !== undefined && adminPassword.length < 10) {
    fail('MPANEL_ADMIN_PASSWORD', '密码至少 10 个字符');
  }

  const coreToken = read(env, 'MPANEL_CORE_TOKEN');
  if (coreToken !== undefined && coreToken.length < 16) {
    fail('MPANEL_CORE_TOKEN', '至少 16 个字符（建议 32 字节随机）');
  }

  const sessionSecret = read(env, 'MPANEL_SESSION_SECRET') ?? SESSION_SECRET_PLACEHOLDER;
  if (sessionSecret !== '' && sessionSecret.length < 16) {
    fail('MPANEL_SESSION_SECRET', '至少 16 个字符');
  }

  const webDir = resolvePath(
    read(env, 'MPANEL_WEB_DIST', 'MPANEL_WEB_DIR'),
    resolve(process.cwd(), 'web', 'dist'),
  );

  return {
    home,
    listen: listenValue ?? `${listen.host}:${listen.port}`,
    host: listen.host,
    port: listen.port,
    publicUrl: publicUrlRaw,
    webDir,
    allowStdio: parseBool('MPANEL_ALLOW_STDIO', read(env, 'MPANEL_ALLOW_STDIO'), false),
    workerEntry: resolvePath(
      read(env, 'MPANEL_WORKER_ENTRY'),
      resolve(process.cwd(), 'server', 'worker', 'dist', 'index.js'),
    ),
    corsOrigins: parseOrigins('MPANEL_CORS_ORIGINS', read(env, 'MPANEL_CORS_ORIGINS')),
    dbxOrigin,
    cookieName: read(env, 'MPANEL_COOKIE_NAME') ?? 'mpanel_session',
    cookieSecure,
    cookieSameSite,
    sessionTtlSec,
    tokenTtlSec,
    allowWsQuerySecret: parseBool(
      'MPANEL_ALLOW_WS_QUERY_SECRET',
      read(env, 'MPANEL_ALLOW_WS_QUERY_SECRET'),
      false,
    ),
    redeemRateLimit: parseRate('MPANEL_REDEEM_RATE_LIMIT', read(env, 'MPANEL_REDEEM_RATE_LIMIT'), 10, 60),
    csp: read(env, 'MPANEL_CSP'),
    coreToken,
    adminUser,
    adminPassword,
    trustProxy: parseBool('MPANEL_TRUST_PROXY', read(env, 'MPANEL_TRUST_PROXY'), false),
    secretKey: read(env, 'MPANEL_SECRET_KEY'),
    sessionSecret,
    logLevel: parseLogLevel(read(env, 'MPANEL_LOG_LEVEL')),
  };
}

/** 默认状态目录：~/.mpanel-core（MPANEL_CORE_HOME 可覆盖）。 */
export function defaultCoreHome(): string {
  return resolve(homedir(), '.mpanel-core');
}
