import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PanelError } from '@mpanel/shared';
import type {
  BackupRecord,
  DatabaseCheck,
  DatabaseJob,
  DatabaseKind,
  DatabaseProfile,
  DatabaseProfileCreateInput,
  DatabaseProfileUpdateInput,
  SecretCipher,
} from '@mpanel/shared';

/**
 * 档案在 API 上的附加字段。canonical `DatabaseProfile` 由 @mpanel/shared 定义；
 * `notes` 只在这里存储/返回，不改变共享契约。
 */
export type DatabaseProfileRecord = DatabaseProfile & { notes: string | null };

/** 备份记录额外的落盘路径。共享 BackupRecord 只有 fileName，下载时需要真实路径。 */
export type DatabaseBackupRecord = BackupRecord & { path?: string | null };

export interface DatabaseStore {
  listProfiles(): Promise<DatabaseProfileRecord[]>;
  getProfile(id: string): Promise<DatabaseProfileRecord | undefined>;
  /** 仅内部使用：返回加密后的密码密文，绝不对外序列化。 */
  getProfileSecret(
    id: string,
  ): Promise<{ profile: DatabaseProfileRecord; encryptedPassword: string | null } | undefined>;
  /** 解密已保存的密码；档案不存在返回 undefined，未设置密码返回 null。 */
  getPassword(id: string): Promise<string | null | undefined>;
  createProfile(
    input: DatabaseProfileCreateInput & {
      encryptedPassword?: string | null;
      notes?: string | null;
    },
  ): Promise<DatabaseProfileRecord>;
  updateProfile(
    id: string,
    input: DatabaseProfileUpdateInput & {
      encryptedPassword?: string | null;
      notes?: string | null;
    },
  ): Promise<DatabaseProfileRecord>;
  setLastCheck(id: string, check: DatabaseCheck): Promise<DatabaseProfileRecord>;
  deleteProfile(id: string): Promise<void>;

  listBackups(profileId: string): Promise<DatabaseBackupRecord[]>;
  listAllBackups(): Promise<DatabaseBackupRecord[]>;
  getBackup(id: string): Promise<DatabaseBackupRecord | undefined>;
  createBackup(record: DatabaseBackupRecord): Promise<DatabaseBackupRecord>;
  updateBackup(id: string, patch: Partial<DatabaseBackupRecord>): Promise<DatabaseBackupRecord>;
  deleteBackup(id: string): Promise<void>;

  listJobs(profileId?: string): Promise<DatabaseJob[]>;
  createJob(job: DatabaseJob): Promise<DatabaseJob>;
  updateJob(id: string, patch: Partial<DatabaseJob>): Promise<DatabaseJob>;
  getJob(id: string): Promise<DatabaseJob | undefined>;
}

interface StoredProfile {
  id: string;
  name: string;
  kind: DatabaseKind;
  host: string;
  port: number;
  username: string | null;
  database: string | null;
  tls: boolean;
  redisDb: number | null;
  notes: string | null;
  encryptedPassword: string | null;
  lastCheck: DatabaseCheck | null;
  createdAt: string;
  updatedAt: string;
}

interface DatabasesFile {
  schemaVersion: 1;
  profiles: StoredProfile[];
  backups: DatabaseBackupRecord[];
  jobs: DatabaseJob[];
}

const SCHEMA_VERSION = 1 as const;

function emptyFile(): DatabasesFile {
  return { schemaVersion: SCHEMA_VERSION, profiles: [], backups: [], jobs: [] };
}

export function createDatabaseStore(file: string, cipher: SecretCipher): DatabaseStore {
  const filePath = file;
  let chain: Promise<unknown> = Promise.resolve();

  /** 串行化读-改-写，避免同一进程内并发请求互相覆盖。 */
  function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function readState(): Promise<DatabasesFile> {
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return emptyFile();
      throw new PanelError(
        'INTERNAL',
        `无法读取数据库档案存储（${describeErrno(error)}）`,
        { path: filePath },
        { cause: error },
      );
    }
    if (raw.trim().length === 0) return emptyFile();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new PanelError('INTERNAL', '数据库档案存储不是合法 JSON', { path: filePath }, {
        cause: error,
      });
    }
    if (typeof parsed !== 'object' || parsed === null) {
      throw new PanelError('INTERNAL', '数据库档案存储结构无效', { path: filePath });
    }
    const record = parsed as Partial<DatabasesFile> & Record<string, unknown>;
    return {
      schemaVersion: SCHEMA_VERSION,
      profiles: Array.isArray(record.profiles) ? (record.profiles as StoredProfile[]) : [],
      backups: Array.isArray(record.backups) ? (record.backups as DatabaseBackupRecord[]) : [],
      jobs: Array.isArray(record.jobs) ? (record.jobs as DatabaseJob[]) : [],
    };
  }

  async function writeState(state: DatabasesFile): Promise<void> {
    const payload = `${JSON.stringify(state, null, 2)}\n`;
    await mkdir(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const handle = await open(tmp, 'w', 0o600);
    try {
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(tmp, filePath);
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw new PanelError(
        'INTERNAL',
        `无法写入数据库档案存储（${describeErrno(error)}）`,
        { path: filePath },
        { cause: error },
      );
    }
    await syncDirectory(dirname(filePath));
  }

  async function mutate<T>(fn: (state: DatabasesFile) => T): Promise<T> {
    return withLock(async () => {
      const state = await readState();
      const result = fn(state);
      await writeState(state);
      return result;
    });
  }

  function toProfile(record: StoredProfile): DatabaseProfileRecord {
    return {
      id: record.id,
      name: record.name,
      kind: record.kind,
      host: record.host,
      port: record.port,
      username: record.username ?? null,
      database: record.database ?? null,
      tls: record.tls === true,
      redisDb: record.redisDb ?? null,
      notes: record.notes ?? null,
      hasPassword:
        typeof record.encryptedPassword === 'string' && record.encryptedPassword.length > 0,
      lastCheck: record.lastCheck ?? null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  function findProfile(state: DatabasesFile, id: string): StoredProfile | undefined {
    return state.profiles.find((profile) => profile.id === id);
  }

  function requireProfile(state: DatabasesFile, id: string): StoredProfile {
    const profile = findProfile(state, id);
    if (profile === undefined) {
      throw new PanelError('NOT_FOUND', '数据库档案不存在', { id });
    }
    return profile;
  }

  function assertNameAvailable(
    state: DatabasesFile,
    name: string,
    exceptId?: string,
  ): void {
    const key = name.trim().toLowerCase();
    const clash = state.profiles.find(
      (profile) => profile.id !== exceptId && profile.name.trim().toLowerCase() === key,
    );
    if (clash !== undefined) {
      throw new PanelError('CONFLICT', '数据库档案名称已存在', { name, id: clash.id });
    }
  }

  return {
    async listProfiles() {
      return withLock(async () => {
        const state = await readState();
        return state.profiles
          .map(toProfile)
          .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
      });
    },

    async getProfile(id) {
      return withLock(async () => {
        const state = await readState();
        const profile = findProfile(state, id);
        return profile === undefined ? undefined : toProfile(profile);
      });
    },

    async getProfileSecret(id) {
      return withLock(async () => {
        const state = await readState();
        const profile = findProfile(state, id);
        if (profile === undefined) return undefined;
        return {
          profile: toProfile(profile),
          encryptedPassword: profile.encryptedPassword ?? null,
        };
      });
    },

    async getPassword(id) {
      return withLock(async () => {
        const state = await readState();
        const profile = findProfile(state, id);
        if (profile === undefined) return undefined;
        if (profile.encryptedPassword === null || profile.encryptedPassword.length === 0) {
          return null;
        }
        return cipher.decrypt(profile.encryptedPassword);
      });
    },

    async createProfile(input) {
      return mutate((state) => {
        const { password: plaintext, ...rest } = input;
        if (plaintext !== undefined && rest.encryptedPassword === undefined) {
          throw new PanelError('INTERNAL', '密码必须先加密再写入存储');
        }
        const name = input.name.trim();
        assertNameAvailable(state, name);
        const now = new Date().toISOString();
        const kind = input.kind;
        const stored: StoredProfile = {
          id: newLocalId('dbp'),
          name,
          kind,
          host: input.host.trim(),
          port: input.port ?? defaultPort(kind),
          username: normalizeOptionalText(input.username),
          database: kind === 'postgres' ? normalizeOptionalText(input.database) : null,
          tls: input.tls === true,
          redisDb: kind === 'redis' ? (input.redisDb ?? 0) : null,
          notes: normalizeOptionalText(input.notes),
          encryptedPassword: normalizeCipher(rest.encryptedPassword),
          lastCheck: null,
          createdAt: now,
          updatedAt: now,
        };
        state.profiles.push(stored);
        return toProfile(stored);
      });
    },

    async updateProfile(id, input) {
      return mutate((state) => {
        const { password: plaintext, ...rest } = input;
        if (plaintext !== undefined && rest.encryptedPassword === undefined) {
          throw new PanelError('INTERNAL', '密码必须先加密再写入存储');
        }
        const profile = requireProfile(state, id);
        if (input.name !== undefined) {
          const name = input.name.trim();
          assertNameAvailable(state, name, id);
          profile.name = name;
        }
        if (input.host !== undefined) profile.host = input.host.trim();
        if (input.port !== undefined) profile.port = input.port;
        if (input.username !== undefined) {
          profile.username = normalizeOptionalText(input.username);
        }
        if (input.database !== undefined) {
          profile.database =
            profile.kind === 'postgres' ? normalizeOptionalText(input.database) : null;
        }
        if (input.tls !== undefined) profile.tls = input.tls;
        if (input.redisDb !== undefined) {
          profile.redisDb = profile.kind === 'redis' ? input.redisDb : null;
        }
        if (input.notes !== undefined) profile.notes = normalizeOptionalText(input.notes);
        if (rest.encryptedPassword !== undefined) {
          profile.encryptedPassword = normalizeCipher(rest.encryptedPassword);
        }
        profile.updatedAt = new Date().toISOString();
        return toProfile(profile);
      });
    },

    async setLastCheck(id, check) {
      return mutate((state) => {
        const profile = requireProfile(state, id);
        profile.lastCheck = check;
        return toProfile(profile);
      });
    },

    async deleteProfile(id) {
      return mutate((state) => {
        const index = state.profiles.findIndex((profile) => profile.id === id);
        if (index < 0) {
          throw new PanelError('NOT_FOUND', '数据库档案不存在', { id });
        }
        state.profiles.splice(index, 1);
        // 备份与历史 job 保留（api-contract §8.2：删除档案时备份保留）。
      });
    },

    async listBackups(profileId) {
      return withLock(async () => {
        const state = await readState();
        return state.backups
          .filter((backup) => backup.profileId === profileId)
          .map((backup) => ({ ...backup }))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      });
    },

    async listAllBackups() {
      return withLock(async () => {
        const state = await readState();
        return state.backups.map((backup) => ({ ...backup }));
      });
    },

    async getBackup(id) {
      return withLock(async () => {
        const state = await readState();
        const backup = state.backups.find((item) => item.id === id);
        return backup === undefined ? undefined : { ...backup };
      });
    },

    async createBackup(record) {
      return mutate((state) => {
        if (state.backups.some((item) => item.id === record.id)) {
          throw new PanelError('CONFLICT', '备份记录已存在', { id: record.id });
        }
        state.backups.push({ ...record });
        return { ...record };
      });
    },

    async updateBackup(id, patch) {
      return mutate((state) => {
        const backup = state.backups.find((item) => item.id === id);
        if (backup === undefined) {
          throw new PanelError('NOT_FOUND', '备份记录不存在', { id });
        }
        Object.assign(backup, patch, { id: backup.id });
        return { ...backup };
      });
    },

    async deleteBackup(id) {
      return mutate((state) => {
        const index = state.backups.findIndex((item) => item.id === id);
        if (index < 0) {
          throw new PanelError('NOT_FOUND', '备份记录不存在', { id });
        }
        state.backups.splice(index, 1);
      });
    },

    async listJobs(profileId) {
      return withLock(async () => {
        const state = await readState();
        return state.jobs
          .filter((job) => profileId === undefined || job.profileId === profileId)
          .map((job) => ({ ...job }))
          .sort((a, b) => {
            const left = a.startedAt ?? '';
            const right = b.startedAt ?? '';
            return right.localeCompare(left) || b.id.localeCompare(a.id);
          });
      });
    },

    async createJob(job) {
      return mutate((state) => {
        if (state.jobs.some((item) => item.id === job.id)) {
          throw new PanelError('CONFLICT', '数据库任务已存在', { id: job.id });
        }
        state.jobs.push({ ...job });
        return { ...job };
      });
    },

    async updateJob(id, patch) {
      return mutate((state) => {
        const job = state.jobs.find((item) => item.id === id);
        if (job === undefined) {
          throw new PanelError('NOT_FOUND', '数据库任务不存在', { id });
        }
        Object.assign(job, patch, { id: job.id });
        return { ...job };
      });
    },

    async getJob(id) {
      return withLock(async () => {
        const state = await readState();
        const job = state.jobs.find((item) => item.id === id);
        return job === undefined ? undefined : { ...job };
      });
    },
  };
}

export function newDatabaseId(prefix: string): string {
  return newLocalId(prefix);
}

function newLocalId(prefix: string): string {
  const time = Date.now().toString(36);
  return `${prefix}_${time}${randomBytes(8).toString('hex')}`;
}

function defaultPort(kind: DatabaseKind): number {
  return kind === 'postgres' ? 5432 : 6379;
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function normalizeCipher(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value.length === 0 ? null : value;
}

async function syncDirectory(dir: string): Promise<void> {
  // 目录 fsync 在 Windows 上不被支持；仅 POSIX 尽力而为。
  if (process.platform === 'win32') return;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(dir, 'r');
    await handle.sync();
  } catch {
    // 忽略：rename 已经保证可见性，目录 fsync 只是崩溃持久性优化。
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function describeErrno(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as NodeJS.ErrnoException).code;
    if (typeof code === 'string') return code;
  }
  return 'unknown error';
}
