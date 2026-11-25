import type { AuthUser } from '@mpanel/shared';
import type { CoreConfig } from '../config.js';
import type { AuthContext } from './types.js';
import type { SessionStore, UserRecord } from './store.js';

export interface SessionService {
  issue(user: AuthUser): Promise<{ token: string; expiresAt: string }>;
  resolve(token: string): Promise<AuthContext | null>;
  revoke(token: string): Promise<void>;
  revokeUser(userId: string, keepToken?: string): Promise<void>;
  cookieHeader(token: string, expiresAt: string): string;
  clearCookieHeader(): string;
}

export interface SessionServiceOptions {
  /** 每次解析会话时读取最新用户，保证改密/删号立即生效。 */
  findUser?: (id: string) => Promise<UserRecord | undefined>;
}

function toAuthUser(record: UserRecord): AuthUser {
  return {
    id: record.id,
    username: record.username,
    displayName: record.displayName,
    role: record.role,
  };
}

function sameSiteValue(value: CoreConfig['cookieSameSite']): string {
  if (value === 'none') return 'None';
  if (value === 'strict') return 'Strict';
  return 'Lax';
}

export function createSessionService(
  config: CoreConfig,
  store: SessionStore,
  options: SessionServiceOptions = {},
): SessionService {
  const cookieName = config.cookieName;
  const sameSite = sameSiteValue(config.cookieSameSite);
  const secure = config.cookieSecure || config.cookieSameSite === 'none';

  function serializeCookie(token: string, maxAgeSec: number): string {
    const parts = [
      `${cookieName}=${token}`,
      'Path=/',
      'HttpOnly',
      `SameSite=${sameSite}`,
      `Max-Age=${Math.max(0, Math.floor(maxAgeSec))}`,
    ];
    if (secure) parts.push('Secure');
    return parts.join('; ');
  }

  return {
    async issue(user) {
      const result = await store.create(user.id, config.sessionTtlSec, user);
      return result;
    },

    async resolve(token) {
      const record = await store.get(token);
      if (record === null) return null;

      let user: AuthUser | undefined;
      if (options.findUser !== undefined) {
        const found = await options.findUser(record.userId);
        if (found !== undefined) user = toAuthUser(found);
      }
      if (user === undefined && record.user !== undefined) user = record.user;
      if (user === undefined) {
        // 用户已被删除：顺手清理失效会话。
        await store.delete(token);
        return null;
      }

      const expiresAtMs = Date.parse(record.expiresAt);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) return null;
      const maxAgeSec = Math.max(1, Math.round((expiresAtMs - Date.now()) / 1000));

      return {
        kind: 'session',
        user,
        scope: 'write',
        sessionToken: token,
        cookieHeader: serializeCookie(token, maxAgeSec),
      };
    },

    async revoke(token) {
      await store.delete(token);
    },

    async revokeUser(userId, keepToken) {
      await store.deleteForUser(userId, keepToken);
    },

    cookieHeader(token, expiresAt) {
      const expiresAtMs = Date.parse(expiresAt);
      const maxAgeSec = Number.isFinite(expiresAtMs)
        ? Math.max(1, Math.round((expiresAtMs - Date.now()) / 1000))
        : config.sessionTtlSec;
      return serializeCookie(token, maxAgeSec);
    },

    clearCookieHeader() {
      const parts = [
        `${cookieName}=`,
        'Path=/',
        'HttpOnly',
        `SameSite=${sameSite}`,
        'Max-Age=0',
        'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
      ];
      if (secure) parts.push('Secure');
      return parts.join('; ');
    },
  };
}
