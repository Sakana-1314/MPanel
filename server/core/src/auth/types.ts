import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PanelError } from '@mpanel/shared';
import type { AuthUser, WsTicket } from '@mpanel/shared';
import type { MachineService } from '../machines/service.js';

export interface AuthContext {
  kind: 'session' | 'token';
  user: AuthUser;
  /** token 认证的权限范围；session 固定为 write。 */
  scope?: 'read' | 'write';
  /** API token 记录 id（仅 kind=token 且为持久化 token 时存在）。 */
  tokenId?: string;
  /** 当前会话原始 token（仅 kind=session），用于密码修改后保留本会话。 */
  sessionToken?: string;
  /** 滑动续期后的完整 Set-Cookie 值，由 app 的鉴权 hook 写回响应。 */
  cookieHeader?: string;
}

export interface AuthService {
  authenticate(req: FastifyRequest): Promise<AuthContext>;
  authenticateOrNull(req: FastifyRequest): Promise<AuthContext | null>;
  issueWsTicket(auth: AuthContext, path: string, machineId?: string): WsTicket;
  consumeWsTicket(ticket: string, path: string): AuthContext;
  registerRoutes(app: FastifyInstance, machines: MachineService): Promise<void>;
  /** 停止内部定时器并等待审计落盘。 */
  close?(): Promise<void>;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** 由鉴权 hook 注入；未经 /api/v1 保护 scope 的路由可能为空。 */
    mpanelAuth?: AuthContext;
  }
}

/* ------------------------------------------------------------------ */
/* 认证模块共用的小工具                                                */
/* ------------------------------------------------------------------ */

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** 用会话密钥对 API token 做 HMAC，落盘文件泄漏也无法直接重放 token。 */
export function hmacHex(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value, 'utf8').digest('hex');
}

/**
 * 比较两个秘密字符串。先各自 SHA-256 再 timingSafeEqual，
 * 避免长度差异与逐字节比较带来的时序侧信道。
 */
export function safeEqualString(left: string, right: string): boolean {
  const a = createHash('sha256').update(left, 'utf8').digest();
  const b = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/** 32 字节随机数的 base64url 表示，用作 session/ticket/token 的原始值。 */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** 从 Cookie 请求头读取指定名字的值；不做 URL 解码（token 本身是 base64url）。 */
export function readCookie(req: FastifyRequest, name: string): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== 'string' || header.length === 0) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (key !== name) continue;
    return part.slice(index + 1).trim();
  }
  return undefined;
}

export function isMutatingMethod(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}

export interface RequestPath {
  /** 不含 query 的原始路径。 */
  path: string;
  /** 原始 query（不含 ?）；不存在时为空字符串。 */
  query: string;
}

export function splitRequestUrl(rawUrl: string): RequestPath {
  const index = rawUrl.indexOf('?');
  if (index < 0) return { path: rawUrl, query: '' };
  return { path: rawUrl.slice(0, index), query: rawUrl.slice(index + 1) };
}

/**
 * WS ticket 绑定用的规范化路径：剔除 ticket/token 参数，其余参数按
 * key、value 排序后重新编码。取票与连接两端使用同一函数，因此比较稳定。
 */
export function normalizeTicketPath(rawUrl: string): string {
  const { path, query } = splitRequestUrl(rawUrl);
  const params = new URLSearchParams(query);
  params.delete('ticket');
  params.delete('token');
  const entries = [...params.entries()].sort(([ak, av], [bk, bv]) => {
    if (ak !== bk) return ak < bk ? -1 : 1;
    if (av === bv) return 0;
    return av < bv ? -1 : 1;
  });
  if (entries.length === 0) return path;
  const encoded = entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  return `${path}?${encoded}`;
}

/** 结构化最小 zod 协议：兼容 shared 包导出的 zod schema，避免直接依赖 zod。 */
export interface SafeParseSchema<T> {
  safeParse(input: unknown):
    | { success: true; data: T }
    | {
        success: false;
        error: {
          issues: ReadonlyArray<{
            path: ReadonlyArray<string | number | symbol>;
            message: string;
            code?: unknown;
          }>;
        };
      };
}

/** 用 zod schema 校验请求体；失败统一抛 BAD_REQUEST 信封错误。 */
export function parseInput<T>(
  schema: SafeParseSchema<T>,
  input: unknown,
  label: string,
): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => ({
    path: issue.path.map((part) => String(part)).join('.'),
    code: typeof issue.code === 'string' ? issue.code : 'custom',
    message: issue.message,
  }));
  throw new PanelError('BAD_REQUEST', `${label}校验失败`, { issues });
}

export function clientIp(req: FastifyRequest): string | undefined {
  return req.ip || undefined;
}

/** 把任意值里的字符串字段安全取出。 */
export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
