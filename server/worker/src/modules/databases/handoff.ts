import { createHash, randomBytes } from 'node:crypto';
import { PanelError, badRequest } from '@mpanel/shared';
import type {
  DatabaseProfile,
  HandoffPayload,
  HandoffTicket,
  SecretCipher,
} from '@mpanel/shared';
import type { WorkerLogger } from '../../logger.js';
import type { DatabaseStore } from './store.js';

export interface HandoffService {
  /** 只返回 HandoffTicket；密码绝不出现在 issue 响应中。 */
  issue(profileId: string, ttlSec?: number): Promise<HandoffTicket>;
  /** 唯一返回明文连接凭据的出口（一次性 ticket 校验后）。 */
  redeem(ticket: string, clientKey?: string): Promise<HandoffPayload>;
  /** 档案删除时清理其未消费票据。 */
  revokeProfile(profileId: string): void;
}

/** api-contract §8.4：默认 60s，10–300s。 */
const DEFAULT_TTL_SEC = 60;
const MAX_TTL_SEC = 300;
const MIN_TTL_SEC = 10;
const REDEEM_URL = '/databases/handoff/redeem';
/** 未消费票据上限，避免已认证用户反复 issue 造成内存无界增长。 */
const MAX_PENDING_TICKETS = 5000;

interface TicketEntry {
  profileId: string;
  expiresAtMs: number;
}

interface RateWindow {
  count: number;
  resetAtMs: number;
}

/**
 * 一次性票据保存在 worker 内存中（重启即失效）。redeem 只从 JSON body 取
 * ticket，并按来源 IP 固定窗口限速（默认 10/min），超限 401 + retryAfterSec。
 * `publicUrl` 保留在依赖签名中以兼容装配方，但契约要求 redeemUrl 固定为
 * 相对路径，因此不参与拼接。
 */
export function createHandoffService(deps: {
  store: DatabaseStore;
  cipher: SecretCipher;
  publicUrl?: string;
  rateLimit: { windowSec: number; max: number };
  logger?: WorkerLogger;
}): HandoffService {
  const { store, cipher, logger } = deps;
  const tickets = new Map<string, TicketEntry>();
  const windows = new Map<string, RateWindow>();
  const configuredWindow = Number(deps.rateLimit?.windowSec);
  const configuredMax = Number(deps.rateLimit?.max);
  const windowSec = Math.max(
    1,
    Math.trunc(Number.isFinite(configuredWindow) ? configuredWindow : 60),
  );
  const maxHits = Math.max(1, Math.trunc(Number.isFinite(configuredMax) ? configuredMax : 10));

  function sweep(now: number): void {
    for (const [ticket, entry] of tickets) {
      if (entry.expiresAtMs <= now) tickets.delete(ticket);
    }
    for (const [key, window] of windows) {
      if (window.resetAtMs <= now) windows.delete(key);
    }
  }

  function hitRateLimit(clientKey: string): void {
    const now = Date.now();
    const key = clientKey.length > 0 ? clientKey : 'unknown';
    const existing = windows.get(key);
    if (existing === undefined || existing.resetAtMs <= now) {
      windows.set(key, { count: 1, resetAtMs: now + windowSec * 1000 });
      return;
    }
    if (existing.count >= maxHits) {
      throw new PanelError('UNAUTHORIZED', 'handoff redeem 请求过于频繁', {
        retryAfterSec: Math.max(1, Math.ceil((existing.resetAtMs - now) / 1000)),
      });
    }
    existing.count += 1;
  }

  function decryptPassword(profileId: string, encrypted: string | null): string | null {
    if (encrypted === null || encrypted.length === 0) return null;
    try {
      return cipher.decrypt(encrypted);
    } catch {
      logger?.error('database_handoff_decrypt_failed', { profileId });
      throw new PanelError('INTERNAL', '无法解密数据库密码（密钥可能已更换）', { profileId });
    }
  }

  return {
    async issue(profileId, ttlSec) {
      const ttl = ttlSec ?? DEFAULT_TTL_SEC;
      if (!Number.isInteger(ttl) || ttl < MIN_TTL_SEC || ttl > MAX_TTL_SEC) {
        throw badRequest(`handoff TTL 必须在 ${MIN_TTL_SEC}-${MAX_TTL_SEC} 秒之间`, {
          ttlSec: ttl,
        });
      }
      const record = await store.getProfileSecret(profileId);
      if (record === undefined) {
        throw new PanelError('NOT_FOUND', '数据库档案不存在', { profileId });
      }
      const now = Date.now();
      sweep(now);
      if (tickets.size >= MAX_PENDING_TICKETS) {
        throw new PanelError('CONFLICT', '待消费的 handoff 票据过多，请稍后重试', {
          limit: MAX_PENDING_TICKETS,
        });
      }
      const ticket = randomBytes(32).toString('base64url');
      const expiresAtMs = now + ttl * 1000;
      tickets.set(ticket, { profileId, expiresAtMs });
      // 契约 HandoffTicket 只有这四个字段：绝不在此响应中解密/返回密码。
      const payload: HandoffTicket = {
        ticket,
        expiresAt: new Date(expiresAtMs).toISOString(),
        redeemUrl: REDEEM_URL,
        kind: record.profile.kind,
      };
      logger?.info('database_handoff_issued', {
        profileId,
        kind: record.profile.kind,
        expiresAt: payload.expiresAt,
        ticketTag: ticketTag(ticket),
      });
      return payload;
    },

    async redeem(ticket, clientKey = 'unknown') {
      hitRateLimit(clientKey);
      const now = Date.now();
      sweep(now);
      const entry = tickets.get(ticket);
      if (entry === undefined) {
        logger?.warn('database_handoff_rejected', {
          reason: 'unknown_or_used',
          ticketTag: ticketTag(ticket),
        });
        throw new PanelError('NOT_FOUND', 'handoff 票据无效、已过期或已使用');
      }
      // 原子消费：先删除再校验，重复 redeem 一律 404。
      tickets.delete(ticket);
      if (entry.expiresAtMs <= now) {
        logger?.warn('database_handoff_rejected', {
          reason: 'expired',
          ticketTag: ticketTag(ticket),
        });
        throw new PanelError('NOT_FOUND', 'handoff 票据无效、已过期或已使用');
      }
      const record = await store.getProfileSecret(entry.profileId);
      if (record === undefined) {
        logger?.warn('database_handoff_rejected', {
          reason: 'profile_deleted',
          profileId: entry.profileId,
          ticketTag: ticketTag(ticket),
        });
        throw new PanelError('NOT_FOUND', 'handoff 票据无效、已过期或已使用');
      }
      // 密码唯一出口：只在这里解密；响应必须 no-store。
      const password = decryptPassword(entry.profileId, record.encryptedPassword);
      const payload: HandoffPayload = {
        profileId: record.profile.id,
        name: record.profile.name,
        kind: record.profile.kind,
        host: record.profile.host,
        port: record.profile.port,
        username: record.profile.username,
        password,
        database: record.profile.database,
        tls: record.profile.tls,
        redisDb: record.profile.redisDb,
        connectionString: buildConnectionString(record.profile, password),
      };
      logger?.info('database_handoff_redeemed', {
        profileId: record.profile.id,
        kind: record.profile.kind,
        ticketTag: ticketTag(ticket),
      });
      return payload;
    },

    revokeProfile(profileId) {
      for (const [ticket, entry] of tickets) {
        if (entry.profileId === profileId) tickets.delete(ticket);
      }
    },
  };
}

export function buildConnectionString(
  profile: DatabaseProfile,
  password: string | null,
): string {
  const host = profile.host.includes(':') ? `[${profile.host}]` : profile.host;
  if (profile.kind === 'postgres') {
    const user = profile.username === null ? '' : encodeURIComponent(profile.username);
    const auth =
      password === null
        ? user.length > 0
          ? `${user}@`
          : ''
        : `${user}:${encodeURIComponent(password)}@`;
    const database = encodeURIComponent(profile.database ?? 'postgres');
    const query = profile.tls ? '?sslmode=require' : '';
    return `postgresql://${auth}${host}:${profile.port}/${database}${query}`;
  }
  const user = profile.username === null ? '' : encodeURIComponent(profile.username);
  const auth =
    password === null
      ? user.length > 0
        ? `${user}@`
        : ''
      : `${user}:${encodeURIComponent(password)}@`;
  const scheme = profile.tls ? 'rediss' : 'redis';
  const db = profile.redisDb ?? 0;
  return `${scheme}://${auth}${host}:${profile.port}/${db}`;
}

/** 日志中只允许出现 ticket 的 SHA-256 前 8 位。 */
function ticketTag(ticket: string): string {
  return createHash('sha256').update(ticket).digest('hex').slice(0, 8);
}
