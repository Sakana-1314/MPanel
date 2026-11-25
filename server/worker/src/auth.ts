import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PanelError, wsTicketRequestSchema } from '@mpanel/shared';
import type { WsTicket } from '@mpanel/shared';
import type { WorkerConfig } from './config.js';

/**
 * Worker 认证：静态 token（Authorization: Bearer 或 X-MPanel-Token，timing-safe）
 * 与一次性 WS ticket。ticket 60 秒有效、绑定用途与“path + 业务 query”。
 */
export interface WorkerAuth {
  authenticate(req: FastifyRequest): Promise<void>;
  issueWsTicket(req: FastifyRequest, path: string): WsTicket;
  consumeWsTicket(ticket: string, path: string): boolean;
  registerRoutes(app: FastifyInstance): Promise<void>;
  /** WS gateway 使用：验证 `?token=` 形式的静态 token。 */
  verifyToken(value: string): boolean;
}

const TICKET_TTL_SEC = 60;
const TICKET_MAX_TTL_SEC = 300;
const TICKET_MAX_ENTRIES = 4096;
const TICKET_BYTES = 32;

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function bearerValue(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const trimmed = header.trim();
  if (trimmed.length === 0) return undefined;
  const match = /^bearer\s+(.+)$/i.exec(trimmed);
  return match?.[1]?.trim() ?? trimmed;
}

/**
 * 规范化 ticket 绑定的路径：保留 pathname；业务 query 参数排序；
 * 剔除 ticket/token（连接时额外带的票据不影响匹配）。
 */
export function normalizeWsTicketPath(rawPath: string): string {
  const withoutHash = rawPath.split('#', 1)[0] ?? '';
  const question = withoutHash.indexOf('?');
  const pathname = question >= 0 ? withoutHash.slice(0, question) : withoutHash;
  const rawQuery = question >= 0 ? withoutHash.slice(question + 1) : '';
  if (rawQuery.length === 0) return pathname;
  const params = new URLSearchParams(rawQuery);
  params.delete('ticket');
  params.delete('token');
  const entries: Array<[string, string]> = [];
  params.forEach((value, key) => {
    entries.push([key, value]);
  });
  if (entries.length === 0) return pathname;
  entries.sort((left, right) => {
    if (left[0] < right[0]) return -1;
    if (left[0] > right[0]) return 1;
    if (left[1] < right[1]) return -1;
    if (left[1] > right[1]) return 1;
    return 0;
  });
  const sorted = new URLSearchParams();
  for (const [key, value] of entries) sorted.append(key, value);
  return `${pathname}?${sorted.toString()}`;
}

interface TicketRecord {
  normalizedPath: string;
  subject: string;
  expiresAtMs: number;
  createdAtMs: number;
}

/**
 * 内存一次性 ticket。issuer 与 consumer 必须在同一进程（v1 单 worker）。
 */
export class TicketStore {
  private readonly tickets = new Map<string, TicketRecord>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  issue(
    path: string,
    subject: string,
    ttlSec?: number,
  ): { ticket: string; expiresAt: string } {
    this.sweep();
    const requested = ttlSec === undefined ? TICKET_TTL_SEC : Math.floor(ttlSec);
    const ttl = Math.min(TICKET_MAX_TTL_SEC, Math.max(1, requested));
    const ticket = randomBytes(TICKET_BYTES).toString('base64url');
    const createdAtMs = this.now();
    const expiresAtMs = createdAtMs + ttl * 1000;
    this.tickets.set(ticket, {
      normalizedPath: normalizeWsTicketPath(path),
      subject,
      expiresAtMs,
      createdAtMs,
    });
    if (this.tickets.size > TICKET_MAX_ENTRIES) {
      // Map 迭代顺序即插入顺序，淘汰最旧的票据，避免被无限撑大。
      const first = this.tickets.keys().next();
      if (!first.done) this.tickets.delete(first.value);
    }
    return { ticket, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  consume(ticket: string, normalizedPath: string): boolean {
    if (typeof ticket !== 'string' || ticket.length === 0) return false;
    const record = this.tickets.get(ticket);
    if (record === undefined) return false;
    // 一次性：无论校验结果如何都移除，避免用它探测路径。
    this.tickets.delete(ticket);
    if (record.expiresAtMs <= this.now()) return false;
    return record.normalizedPath === normalizeWsTicketPath(normalizedPath);
  }

  sweep(): void {
    const current = this.now();
    for (const [ticket, record] of this.tickets) {
      if (record.expiresAtMs <= current) this.tickets.delete(ticket);
    }
  }

  /** 诊断用：当前票据数量。 */
  size(): number {
    return this.tickets.size;
  }
}

/** 常量时间比较静态 token；header 可为 `Bearer xxx` 或裸 token。 */
export function verifyStaticToken(expected: string, header: string | undefined): boolean {
  if (typeof expected !== 'string' || expected.length === 0) return false;
  const candidate = bearerValue(header);
  if (candidate === undefined || candidate.length === 0) return false;
  // 先哈希再比较，避免长度差异与提前返回泄漏信息。
  const left = sha256(expected);
  const right = sha256(candidate);
  return timingSafeEqual(left, right);
}

function unauthorized(message: string, details?: unknown): PanelError {
  return new PanelError('UNAUTHORIZED', message, details);
}

export function createWorkerAuth(config: WorkerConfig, tickets: TicketStore): WorkerAuth {
  const authenticate = async (req: FastifyRequest): Promise<void> => {
    const authorization = firstHeader(req.headers.authorization);
    const alt = firstHeader(req.headers['x-mpanel-token']);
    const candidate = bearerValue(authorization) ?? bearerValue(alt);
    if (candidate === undefined || candidate.length === 0) {
      throw unauthorized('缺少访问令牌', {
        hint: '使用 Authorization: Bearer <MPANEL_TOKEN> 或 X-MPanel-Token 头。',
      });
    }
    if (!verifyStaticToken(config.token, candidate)) {
      throw unauthorized('访问令牌无效');
    }
  };

  const issueWsTicket = (req: FastifyRequest, path: string): WsTicket => {
    void req;
    const normalized = normalizeWsTicketPath(path);
    if (!normalized.startsWith('/ws/')) {
      throw new PanelError('BAD_REQUEST', 'WS ticket 的 path 必须以 /ws/ 开头', {
        path,
      });
    }
    const issued = tickets.issue(normalized, 'worker-token');
    return { ticket: issued.ticket, expiresAt: issued.expiresAt, path: normalized };
  };

  const auth: WorkerAuth = {
    authenticate,

    issueWsTicket,

    consumeWsTicket(ticket: string, path: string): boolean {
      return tickets.consume(ticket, normalizeWsTicketPath(path));
    },

    verifyToken(value: string): boolean {
      return verifyStaticToken(config.token, value);
    },

    async registerRoutes(app: FastifyInstance): Promise<void> {
      // 契约端点 GET /auth/me；/auth/check 是等价的便捷别名。
      app.get('/auth/me', async () => ({
        ok: true as const,
        data: { authenticated: true as const, role: 'worker' as const, authType: 'token' as const },
      }));
      app.get('/auth/check', async () => ({
        ok: true as const,
        data: { authenticated: true as const, role: 'worker' as const, authType: 'token' as const },
      }));

      app.post('/auth/ws-ticket', async (request) => {
        const parsed = wsTicketRequestSchema.safeParse(request.body);
        if (!parsed.success) {
          throw new PanelError('BAD_REQUEST', '请求参数校验失败', {
            issues: parsed.error.issues.map((issue) => ({
              path: issue.path.map(String).join('.'),
              code: issue.code,
              message: issue.message,
            })),
          });
        }
        if (parsed.data.machineId !== undefined) {
          throw new PanelError('BAD_REQUEST', 'worker 直连 ticket 不接受 machineId');
        }
        if (!parsed.data.path.startsWith('/ws/')) {
          throw new PanelError('BAD_REQUEST', 'worker ticket 的 path 必须以 /ws/ 开头');
        }
        return { ok: true as const, data: issueWsTicket(request, parsed.data.path) };
      });
    },
  };
  return auth;
}
