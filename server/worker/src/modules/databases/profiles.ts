import { PanelError, badRequest, isPanelError } from '@mpanel/shared';
import type {
  CapabilityName,
  CapabilityProvider,
  DatabaseCheck,
  DatabaseKind,
  DatabaseProfileCreateInput,
  DatabaseProfileUpdateInput,
  DatabaseStats,
  DatabaseTestResult,
  ListResult,
  PageQuery,
  SecretCipher,
} from '@mpanel/shared';
import { assertCapability } from '../../util.js';
import type { WorkerLogger } from '../../logger.js';
import type { DatabaseProfileRecord, DatabaseStore } from './store.js';
import type { PostgresDriver } from './postgres.js';
import type { RedisDriver } from './redis.js';
import { describeError, scrubSecret, tailText } from './exec.js';
import { pageSlice } from './paging.js';

export interface ProfileCreateInput extends DatabaseProfileCreateInput {
  notes?: string | null;
}

export interface ProfileUpdateInput extends DatabaseProfileUpdateInput {
  notes?: string | null;
}

export interface ProfileService {
  list(
    q: PageQuery & { kind?: DatabaseKind; q?: string },
  ): Promise<ListResult<DatabaseProfileRecord>>;
  get(id: string): Promise<DatabaseProfileRecord>;
  create(input: ProfileCreateInput): Promise<DatabaseProfileRecord>;
  update(id: string, input: ProfileUpdateInput): Promise<DatabaseProfileRecord>;
  remove(id: string): Promise<void>;
  test(id: string): Promise<DatabaseTestResult>;
  stats(id: string): Promise<DatabaseStats>;
}

const MAX_NOTES_LENGTH = 2000;

export function createProfileService(deps: {
  store: DatabaseStore;
  postgres: PostgresDriver;
  redis: RedisDriver;
  cipher: SecretCipher;
  logger: WorkerLogger;
  capabilities?: CapabilityProvider;
}): ProfileService {
  const { store, postgres, redis, cipher, logger } = deps;

  async function requireProfile(id: string): Promise<DatabaseProfileRecord> {
    const profile = await store.getProfile(id);
    if (profile === undefined) {
      throw new PanelError('NOT_FOUND', '数据库档案不存在', { id });
    }
    return profile;
  }

  async function requirePassword(id: string): Promise<string | null> {
    const password = await store.getPassword(id);
    if (password === undefined) {
      throw new PanelError('NOT_FOUND', '数据库档案不存在', { id });
    }
    return password;
  }

  async function gateCapability(kind: DatabaseKind): Promise<void> {
    if (deps.capabilities === undefined) return;
    const name: CapabilityName = kind === 'postgres' ? 'postgres' : 'redis';
    await assertCapability(deps.capabilities, name);
  }

  function kindOf(profile: DatabaseProfileRecord): DatabaseKind {
    return profile.kind;
  }

  function validateCrossFields(
    kind: DatabaseKind,
    input: { database?: string | null; redisDb?: number | null },
  ): void {
    if (kind === 'postgres' && input.redisDb !== undefined && input.redisDb !== null) {
      throw badRequest('PostgreSQL 档案不支持 redisDb 字段', { field: 'redisDb' });
    }
    if (kind === 'redis' && input.database !== undefined && input.database !== null) {
      throw badRequest('Redis 档案不支持 database 字段', { field: 'database' });
    }
  }

  function normalizeNotes(value: string | null | undefined): string | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    const trimmed = value.trim();
    if (trimmed.length > MAX_NOTES_LENGTH) {
      throw badRequest(`备注不能超过 ${MAX_NOTES_LENGTH} 个字符`, { field: 'notes' });
    }
    return trimmed.length === 0 ? null : trimmed;
  }

  function encryptPassword(password: string | null | undefined): string | null {
    if (password === undefined || password === null || password.length === 0) return null;
    return cipher.encrypt(password);
  }

  return {
    async list(q) {
      const all = await store.listProfiles();
      const needle = q.q?.trim().toLocaleLowerCase();
      const filtered = all.filter((profile) => {
        if (q.kind !== undefined && profile.kind !== q.kind) return false;
        if (needle === undefined || needle.length === 0) return true;
        const haystack = [
          profile.name,
          profile.host,
          profile.username ?? '',
          profile.database ?? '',
        ]
          .join('\n')
          .toLocaleLowerCase();
        return haystack.includes(needle);
      });
      return pageSlice(filtered, q);
    },

    async get(id) {
      return requireProfile(id);
    },

    async create(input) {
      const kind = input.kind;
      validateCrossFields(kind, input);
      const { password: plaintext, notes, ...rest } = input;
      if (rest.name.trim().length === 0) {
        throw badRequest('档案名称不能为空', { field: 'name' });
      }
      if (rest.host.trim().length === 0) {
        throw badRequest('主机地址不能为空', { field: 'host' });
      }
      const normalizedNotes = normalizeNotes(notes);
      const created = await store.createProfile({
        ...rest,
        name: rest.name.trim(),
        host: rest.host.trim(),
        encryptedPassword: encryptPassword(plaintext),
        ...(normalizedNotes !== undefined ? { notes: normalizedNotes } : {}),
      });
      logger.info('database_profile_created', {
        profileId: created.id,
        kind: created.kind,
      });
      return created;
    },

    async update(id, input) {
      const existing = await requireProfile(id);
      const kind = kindOf(existing);
      validateCrossFields(kind, input);
      const { password: plaintext, notes, ...rest } = input;
      const patch: DatabaseProfileUpdateInput & {
        encryptedPassword?: string | null;
        notes?: string | null;
      } = { ...rest };
      if (Object.prototype.hasOwnProperty.call(input, 'password')) {
        patch.encryptedPassword = encryptPassword(plaintext);
      }
      const normalizedNotes = normalizeNotes(notes);
      if (normalizedNotes !== undefined) patch.notes = normalizedNotes;
      if (Object.keys(patch).length === 0) {
        throw badRequest('至少需要修改一个字段');
      }
      if (patch.name !== undefined && patch.name.trim().length === 0) {
        throw badRequest('档案名称不能为空', { field: 'name' });
      }
      if (patch.host !== undefined && patch.host.trim().length === 0) {
        throw badRequest('主机地址不能为空', { field: 'host' });
      }
      const updated = await store.updateProfile(id, patch);
      logger.info('database_profile_updated', { profileId: id });
      return updated;
    },

    async remove(id) {
      const profile = await requireProfile(id);
      const jobs = await store.listJobs(id);
      const running = jobs.find((job) => job.status === 'running' || job.status === 'queued');
      if (running !== undefined) {
        throw new PanelError('CONFLICT', '该档案有正在运行的备份/恢复任务', {
          id,
          jobId: running.id,
        });
      }
      await store.deleteProfile(id);
      logger.info('database_profile_deleted', { profileId: id, kind: profile.kind });
    },

    async test(id) {
      const profile = await requireProfile(id);
      await gateCapability(profile.kind);
      const password = await requirePassword(id);
      const started = performance.now();
      let result: DatabaseTestResult;
      try {
        result =
          profile.kind === 'postgres'
            ? await postgres.test(profile, password)
            : await redis.test(profile, password);
      } catch (error) {
        if (isPanelError(error) && error.code === 'UNAVAILABLE') throw error;
        result = {
          ok: false,
          latencyMs: roundMs(performance.now() - started),
          message: tailText(scrubSecret(describeError(error), password), 500),
        };
      }
      const check: DatabaseCheck = {
        at: new Date().toISOString(),
        ok: result.ok,
        latencyMs: Math.max(0, roundMs(result.latencyMs)),
        ...(result.serverVersion !== undefined ? { serverVersion: result.serverVersion } : {}),
        ...(result.message !== undefined ? { message: result.message } : {}),
      };
      await store.setLastCheck(id, check);
      logger.info('database_profile_tested', {
        profileId: id,
        ok: result.ok,
        latencyMs: check.latencyMs,
      });
      return { ...result, latencyMs: check.latencyMs };
    },

    async stats(id) {
      const profile = await requireProfile(id);
      await gateCapability(profile.kind);
      const password = await requirePassword(id);
      try {
        return profile.kind === 'postgres'
          ? await postgres.stats(profile, password)
          : await redis.stats(profile, password);
      } catch (error) {
        if (isPanelError(error)) throw error;
        throw new PanelError(
          'UPSTREAM_ERROR',
          `读取数据库统计失败：${tailText(scrubSecret(describeError(error), password), 500)}`,
          { profileId: id },
          { cause: error },
        );
      }
    },
  };
}

function roundMs(value: number): number {
  const safe = Number.isFinite(value) ? value : 0;
  return Math.round(safe * 10) / 10;
}
