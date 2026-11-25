import { readFile, stat } from 'node:fs/promises';
import type { AuthUser } from '@mpanel/shared';
import { newId, writeFileAtomic } from '../store.js';
import { hmacHex, randomToken, sha256Hex } from './types.js';
import type { StoredPassword } from './scrypt.js';

/*
 * 认证数据落盘约定：
 * - 每个文件是独立的 schemaVersion=1 JSON 根对象；
 * - 写入复用 store.ts 的 writeFileAtomic（tmp + fsync + rename + .bak）；
 * - 读穿磁盘而不是长期缓存 root，使独立进程的 `mpanel-core user` CLI
 *   修改能立即被运行中的 core 看到；会话额外保留一层 mtime 内存缓存。
 */

/** 进程内串行化写入，避免同一 store 的并发 update 互相覆盖。 */
function createWriteQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}

async function readJsonFile(file: string): Promise<unknown> {
  let text: string | undefined;
  for (const candidate of [file, `${file}.bak`]) {
    try {
      text = await readFile(candidate, 'utf8');
      if (text.trim() === '') text = undefined;
      if (text !== undefined) break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* ------------------------------------------------------------------ */
/* Users                                                               */
/* ------------------------------------------------------------------ */

export interface UserRecord {
  id: string;
  username: string;
  displayName: string | null;
  role: 'admin' | 'operator';
  password: StoredPassword;
  createdAt: string;
  updatedAt: string;
}

export interface UserStore {
  list(): Promise<UserRecord[]>;
  findByUsername(name: string): Promise<UserRecord | undefined>;
  get(id: string): Promise<UserRecord | undefined>;
  create(user: UserRecord): Promise<UserRecord>;
  update(id: string, patch: Partial<UserRecord>): Promise<UserRecord>;
  remove(id: string): Promise<void>;
}

interface UsersFile {
  schemaVersion: 1;
  users: UserRecord[];
}

function normalizeUsersFile(value: unknown): UsersFile {
  if (!isRecord(value) || !Array.isArray(value.users)) return { schemaVersion: 1, users: [] };
  return { schemaVersion: 1, users: value.users as UserRecord[] };
}

export function createUserStore(file: string): UserStore {
  const enqueue = createWriteQueue();

  async function readUsers(): Promise<UserRecord[]> {
    return normalizeUsersFile(await readJsonFile(file)).users;
  }

  return {
    async list() {
      const users = await readUsers();
      return [...users].sort((a, b) => a.username.localeCompare(b.username));
    },

    async findByUsername(name) {
      const users = await readUsers();
      const needle = name.trim().toLowerCase();
      return users.find((user) => user.username.toLowerCase() === needle);
    },

    async get(id) {
      const users = await readUsers();
      return users.find((user) => user.id === id);
    },

    create(user) {
      return enqueue(async () => {
        const users = await readUsers();
        users.push(user);
        await writeJsonFile(file, { schemaVersion: 1, users } satisfies UsersFile);
        return user;
      });
    },

    update(id, patch) {
      return enqueue(async () => {
        const users = await readUsers();
        const index = users.findIndex((user) => user.id === id);
        if (index < 0) throw new Error(`用户不存在: ${id}`);
        const current = users[index];
        if (current === undefined) throw new Error(`用户不存在: ${id}`);
        const next: UserRecord = {
          ...current,
          ...patch,
          id: current.id,
          updatedAt: new Date().toISOString(),
        };
        users[index] = next;
        await writeJsonFile(file, { schemaVersion: 1, users } satisfies UsersFile);
        return next;
      });
    },

    remove(id) {
      return enqueue(async () => {
        const users = await readUsers();
        await writeJsonFile(file, {
          schemaVersion: 1,
          users: users.filter((user) => user.id !== id),
        } satisfies UsersFile);
      });
    },
  };
}

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

/** Sessions are persisted by token SHA-256 only. */
export interface SessionRecord {
  tokenHash: string;
  userId: string;
  expiresAt: string;
  /** 创建时 TTL（秒），用于滑动续期；缺失时按 12 小时处理。 */
  ttlSec?: number;
  createdAt?: string;
  /** 用户快照，仅在未提供 UserStore 查询函数时作为回退。 */
  user?: AuthUser;
}

export interface SessionStore {
  create(
    userId: string,
    ttlSec: number,
    user?: AuthUser,
  ): Promise<{ token: string; expiresAt: string }>;
  get(token: string): Promise<SessionRecord | null>;
  delete(token: string): Promise<void>;
  /** 删除某用户全部会话；keepToken 为原始 token（当前会话）时保留。 */
  deleteForUser(userId: string, keepToken?: string): Promise<void>;
  sweep(): void;
}

interface SessionsFile {
  schemaVersion: 1;
  sessions: SessionRecord[];
}

function normalizeSessionsFile(value: unknown): SessionsFile {
  if (!isRecord(value) || !Array.isArray(value.sessions)) {
    return { schemaVersion: 1, sessions: [] };
  }
  return { schemaVersion: 1, sessions: value.sessions as SessionRecord[] };
}

const DEFAULT_SESSION_TTL_SEC = 12 * 3600;

export function createSessionStore(file: string): SessionStore {
  const enqueue = createWriteQueue();
  /** 内存缓存 + 文件 mtime/size 指纹；外部进程改文件后自动失效。 */
  let cache: SessionRecord[] | undefined;
  let fingerprint = '';

  async function refreshFingerprint(): Promise<void> {
    try {
      const info = await stat(file);
      fingerprint = `${info.mtimeMs}:${info.size}`;
    } catch {
      fingerprint = 'missing';
    }
  }

  async function load(): Promise<SessionRecord[]> {
    try {
      const info = await stat(file);
      const next = `${info.mtimeMs}:${info.size}`;
      if (cache !== undefined && next === fingerprint) return cache;
      cache = normalizeSessionsFile(await readJsonFile(file)).sessions;
      fingerprint = next;
      return cache;
    } catch {
      if (cache !== undefined && fingerprint === 'missing') return cache;
      cache = [];
      fingerprint = 'missing';
      return cache;
    }
  }

  async function persist(sessions: SessionRecord[]): Promise<void> {
    await writeJsonFile(file, { schemaVersion: 1, sessions } satisfies SessionsFile);
    cache = sessions;
    await refreshFingerprint();
  }

  async function sweepInternal(): Promise<void> {
    const sessions = await load();
    const now = Date.now();
    const alive = sessions.filter((session) => Date.parse(session.expiresAt) > now);
    if (alive.length !== sessions.length) await enqueue(() => persist(alive));
  }

  return {
    create(userId, ttlSec, user) {
      return enqueue(async () => {
        const token = randomToken(32);
        const now = Date.now();
        const expiresAt = new Date(now + Math.max(1, ttlSec) * 1000).toISOString();
        const record: SessionRecord = {
          tokenHash: sha256Hex(token),
          userId,
          expiresAt,
          ttlSec,
          createdAt: new Date(now).toISOString(),
          ...(user === undefined ? {} : { user }),
        };
        const sessions = (await load()).filter(
          (session) => Date.parse(session.expiresAt) > now,
        );
        sessions.push(record);
        await persist(sessions);
        return { token, expiresAt };
      });
    },

    async get(token) {
      const sessions = await load();
      const tokenHash = sha256Hex(token);
      const index = sessions.findIndex((session) => session.tokenHash === tokenHash);
      if (index < 0) return null;
      const record = sessions[index];
      if (record === undefined) return null;
      const now = Date.now();
      const expiresAtMs = Date.parse(record.expiresAt);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) {
        await enqueue(async () => {
          const current = await load();
          await persist(current.filter((session) => session.tokenHash !== tokenHash));
        });
        return null;
      }
      // 滑动续期：剩余不足 TTL 的 7/8 时延长，最多每分钟写一次盘。
      const ttlSec = record.ttlSec ?? DEFAULT_SESSION_TTL_SEC;
      const ttlMs = ttlSec * 1000;
      if (expiresAtMs - now < ttlMs - 60_000) {
        const next: SessionRecord = {
          ...record,
          expiresAt: new Date(now + ttlMs).toISOString(),
          ttlSec,
        };
        sessions[index] = next;
        await enqueue(() => persist(sessions));
        return next;
      }
      return record;
    },

    delete(token) {
      return enqueue(async () => {
        const tokenHash = sha256Hex(token);
        const sessions = (await load()).filter(
          (session) => session.tokenHash !== tokenHash,
        );
        await persist(sessions);
      });
    },

    deleteForUser(userId, keepToken) {
      return enqueue(async () => {
        const keepHash = keepToken === undefined ? undefined : sha256Hex(keepToken);
        const sessions = (await load()).filter(
          (session) => session.userId !== userId || session.tokenHash === keepHash,
        );
        await persist(sessions);
      });
    },

    sweep() {
      void sweepInternal().catch(() => {
        // 过期清理失败不影响请求；下次写入时仍会过滤过期记录。
      });
    },
  };
}

/* ------------------------------------------------------------------ */
/* API tokens                                                          */
/* ------------------------------------------------------------------ */

export interface ApiTokenInfo {
  id: string;
  name: string;
  scope: 'read' | 'write';
  userId: string;
  createdAt: string;
  expiresAt: string | null;
}

export interface ApiTokenStore {
  list(): Promise<ApiTokenInfo[]>;
  create(input: {
    name: string;
    scope: 'read' | 'write';
    userId: string;
    ttlSec?: number;
    expiresAt?: string;
  }): Promise<{ info: ApiTokenInfo; token: string }>;
  /** 按原始 Bearer token 查找；过期或不存在返回 null。 */
  findByToken(token: string): Promise<ApiTokenInfo | null>;
  remove(id: string): Promise<boolean>;
}

interface ApiTokenRecord extends ApiTokenInfo {
  tokenHash: string;
}

interface ApiTokensFile {
  schemaVersion: 1;
  tokens: ApiTokenRecord[];
}

function normalizeTokensFile(value: unknown): ApiTokensFile {
  if (!isRecord(value) || !Array.isArray(value.tokens)) {
    return { schemaVersion: 1, tokens: [] };
  }
  return { schemaVersion: 1, tokens: value.tokens as ApiTokenRecord[] };
}

function toInfo(record: ApiTokenRecord): ApiTokenInfo {
  return {
    id: record.id,
    name: record.name,
    scope: record.scope,
    userId: record.userId,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}

/**
 * API token 只以 HMAC-SHA256(sessionSecret, token) 落盘；明文仅在创建响应中
 * 返回一次。token 前缀 mpat_，便于日志/审计识别但不得记录完整值。
 */
export function createApiTokenStore(file: string, secret: string): ApiTokenStore {
  const enqueue = createWriteQueue();
  const hash = (token: string): string => hmacHex(secret, token);

  async function readTokens(): Promise<ApiTokenRecord[]> {
    return normalizeTokensFile(await readJsonFile(file)).tokens;
  }

  return {
    async list() {
      const tokens = await readTokens();
      return tokens.map(toInfo).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    create(input) {
      return enqueue(async () => {
        const token = `mpat_${randomToken(32)}`;
        const now = new Date();
        const expiresAt = input.expiresAt
          ?? new Date(now.getTime() + Math.max(1, input.ttlSec ?? 12 * 3600) * 1000).toISOString();
        const record: ApiTokenRecord = {
          id: newId('tok'),
          name: input.name,
          scope: input.scope,
          userId: input.userId,
          createdAt: now.toISOString(),
          expiresAt,
          tokenHash: hash(token),
        };
        const tokens = (await readTokens()).filter(
          (item) => item.expiresAt === null || Date.parse(item.expiresAt) > Date.now(),
        );
        tokens.push(record);
        await writeJsonFile(file, { schemaVersion: 1, tokens } satisfies ApiTokensFile);
        return { info: toInfo(record), token };
      });
    },

    async findByToken(token) {
      const tokens = await readTokens();
      const needle = hash(token);
      const record = tokens.find((item) => item.tokenHash === needle);
      if (record === undefined) return null;
      if (record.expiresAt !== null) {
        const expiresAt = Date.parse(record.expiresAt);
        if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
      }
      return toInfo(record);
    },

    remove(id) {
      return enqueue(async () => {
        const tokens = await readTokens();
        const next = tokens.filter((item) => item.id !== id);
        const removed = next.length !== tokens.length;
        if (removed) {
          await writeJsonFile(file, { schemaVersion: 1, tokens: next } satisfies ApiTokensFile);
        }
        return removed;
      });
    },
  };
}
