import { mkdir, stat, unlink } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { PanelError, badRequest, isPanelError, unavailable } from '@mpanel/shared';
import type {
  BackupFormat,
  BackupRequest,
  DatabaseJob,
  DatabaseProfile,
  ListResult,
  PageQuery,
  RestoreRequest,
} from '@mpanel/shared';
import type { WorkerConfig } from '../../config.js';
import type { WorkerLogger } from '../../logger.js';
import type { DatabaseBackupRecord, DatabaseStore } from './store.js';
import { newDatabaseId } from './store.js';
import type { PostgresDriver } from './postgres.js';
import type { RedisDriver } from './redis.js';
import { describeError, scrubSecret, tailText } from './exec.js';
import { pageSlice } from './paging.js';

export interface DatabaseJobService {
  startBackup(profileId: string, body: BackupRequest): Promise<DatabaseJob>;
  startRestore(profileId: string, body: RestoreRequest): Promise<DatabaseJob>;
  getJob(id: string): Promise<DatabaseJob | undefined>;
  listJobs(
    q: PageQuery & { profileId?: string; status?: string },
  ): Promise<ListResult<DatabaseJob>>;
  cancel(profileId: string): void;
  listBackups(profileId: string, q: PageQuery): Promise<ListResult<DatabaseBackupRecord>>;
  getBackup(id: string): Promise<DatabaseBackupRecord | undefined>;
  deleteBackup(id: string): Promise<void>;
  /** 下载前校验记录与路径前缀，并确认文件存在。 */
  resolveBackupFile(
    id: string,
  ): Promise<{ backup: DatabaseBackupRecord; path: string; sizeBytes: number }>;
}

const ACTIVE_JOB_STATUSES = new Set(['queued', 'running']);
const PROGRESS_THROTTLE_MS = 500;

export function createDatabaseJobService(deps: {
  config: WorkerConfig;
  store: DatabaseStore;
  postgres: PostgresDriver;
  redis: RedisDriver;
  logger: WorkerLogger;
}): DatabaseJobService {
  const { config, store, postgres, redis, logger } = deps;
  const baseDir = resolve(config.databases.backupDir);
  const profileChains = new Map<string, Promise<unknown>>();
  const cancelled = new Set<string>();
  let markReady: () => void = () => undefined;
  const ready = new Promise<void>((resolveReady) => {
    markReady = resolveReady;
  });

  function withProfileLock<T>(profileId: string, fn: () => Promise<T>): Promise<T> {
    const previous = profileChains.get(profileId) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    profileChains.set(profileId, tail);
    void tail.finally(() => {
      if (profileChains.get(profileId) === tail) profileChains.delete(profileId);
    });
    return run;
  }

  function backupFilePath(profileId: string, fileName: string): string {
    if (
      fileName.length === 0 ||
      fileName.includes('/') ||
      fileName.includes('\\') ||
      fileName.includes('..')
    ) {
      throw badRequest('备份文件名无效', { fileName });
    }
    const target = resolve(baseDir, profileId, fileName);
    if (target === baseDir || !target.startsWith(`${baseDir}${sep}`)) {
      throw new PanelError('INTERNAL', '备份路径越界', { profileId, fileName });
    }
    return target;
  }

  function filePathOf(backup: DatabaseBackupRecord): string {
    // 记录里的 path 仅供审计展示；实际路径总是从 baseDir + profileId + fileName 推导。
    return backupFilePath(backup.profileId, backup.fileName);
  }

  async function requireProfile(profileId: string): Promise<DatabaseProfile> {
    const profile = await store.getProfile(profileId);
    if (profile === undefined) {
      throw new PanelError('NOT_FOUND', '数据库档案不存在', { id: profileId });
    }
    return profile;
  }

  async function requirePassword(profileId: string): Promise<string | null> {
    const password = await store.getPassword(profileId);
    if (password === undefined) {
      throw new PanelError('NOT_FOUND', '数据库档案不存在', { id: profileId });
    }
    return password;
  }

  async function assertNoActiveJob(profileId: string): Promise<void> {
    const jobs = await store.listJobs(profileId);
    const active = jobs.find((job) => ACTIVE_JOB_STATUSES.has(job.status));
    if (active !== undefined) {
      throw new PanelError('CONFLICT', '该档案已有正在运行的备份/恢复任务', {
        profileId,
        jobId: active.id,
      });
    }
  }

  function defaultFormat(kind: DatabaseProfile['kind']): BackupFormat {
    return kind === 'postgres' ? 'custom' : 'logical';
  }

  function assertFormat(kind: DatabaseProfile['kind'], format: BackupFormat): void {
    if (kind === 'postgres' && format !== 'custom' && format !== 'plain') {
      throw badRequest('PostgreSQL 备份只支持 custom 或 plain 格式', { format });
    }
    if (kind === 'redis' && format !== 'logical' && format !== 'rdb') {
      throw badRequest('Redis 备份只支持 logical 或 rdb 格式', { format });
    }
  }

  function extensionFor(format: BackupFormat): string {
    switch (format) {
      case 'custom':
        return 'dump';
      case 'plain':
        return 'sql';
      case 'logical':
        return 'jsonl';
      case 'rdb':
        return 'rdb';
      default:
        return 'bin';
    }
  }

  async function assertPgTools(format: 'custom' | 'plain', action: 'backup' | 'restore'): Promise<void> {
    const tools = await postgres.probeTools();
    if (action === 'backup' && !tools.pgDump) {
      throw unavailable(
        '缺少 pg_dump，无法备份 PostgreSQL',
        '在 worker 主机安装 PostgreSQL 客户端，或设置 MPANEL_PG_DUMP_BIN 指向 pg_dump。',
        { tool: 'pg_dump' },
      );
    }
    if (action === 'restore') {
      const tool = format === 'custom' ? 'pg_restore' : 'psql';
      const present = format === 'custom' ? tools.pgRestore : tools.psql;
      if (!present) {
        throw unavailable(
          `缺少 ${tool}，无法恢复 PostgreSQL`,
          format === 'custom'
            ? '在 worker 主机安装 PostgreSQL 客户端，或设置 MPANEL_PG_RESTORE_BIN。'
            : '在 worker 主机安装 PostgreSQL 客户端，或设置 MPANEL_PSQL_BIN。',
          { tool },
        );
      }
    }
  }

  function jobError(error: unknown, password: string | null): string {
    let message = isPanelError(error) ? error.message : describeError(error);
    if (isPanelError(error)) {
      const details = error.details as { hint?: unknown } | undefined;
      if (typeof details?.hint === 'string' && details.hint.length > 0) {
        message = `${message}（${details.hint}）`;
      }
    }
    return tailText(scrubSecret(message, password), 1000);
  }

  function progressUpdater(jobId: string): (message: string) => void {
    let lastAt = 0;
    return (message: string) => {
      const now = Date.now();
      if (now - lastAt < PROGRESS_THROTTLE_MS) return;
      lastAt = now;
      void store
        .updateJob(jobId, { progress: tailText(message, 200) })
        .catch((error: unknown) => {
          logger.debug('database_job_progress_failed', {
            jobId,
            error: tailText(describeError(error), 200),
          });
        });
    };
  }

  async function markBackupFailed(
    backup: DatabaseBackupRecord,
    message: string,
    removeFile: boolean,
  ): Promise<void> {
    const finishedAt = new Date().toISOString();
    await store
      .updateBackup(backup.id, { status: 'failed', error: message, finishedAt })
      .catch((error: unknown) => {
        logger.warn('database_backup_mark_failed_error', {
          backupId: backup.id,
          error: tailText(describeError(error), 200),
        });
      });
    if (removeFile) {
      await unlink(filePathOf(backup)).catch(() => undefined);
    }
  }

  async function runBackup(
    profile: DatabaseProfile,
    password: string | null,
    backup: DatabaseBackupRecord,
    jobId: string,
  ): Promise<void> {
    if (cancelled.has(jobId)) {
      await markBackupFailed(backup, '任务已取消', true);
      await store
        .updateJob(jobId, {
          status: 'failed',
          error: '任务已取消',
          finishedAt: new Date().toISOString(),
        })
        .catch(() => undefined);
      cancelled.delete(jobId);
      return;
    }
    const startedAt = new Date().toISOString();
    const onProgress = progressUpdater(jobId);
    try {
      await store.updateJob(jobId, {
        status: 'running',
        startedAt,
        progress: '准备备份',
      });
      const filePath = filePathOf(backup);
      const result =
        profile.kind === 'postgres'
          ? await postgres.backup(profile, password, {
              format: backup.format === 'plain' ? 'plain' : 'custom',
              filePath,
              ...(backup.label !== null && backup.label !== undefined
                ? { label: backup.label }
                : {}),
              onProgress,
            })
          : backup.format === 'rdb'
            ? await redis.backupRdb(profile, password, { filePath, onProgress })
            : await redis.backupLogical(profile, password, { filePath, onProgress });

      const finishedAt = new Date().toISOString();
      if (cancelled.has(jobId)) {
        await markBackupFailed(backup, '任务已取消', true);
        await store.updateJob(jobId, {
          status: 'failed',
          error: '任务已取消',
          finishedAt,
          progress: null,
        });
        return;
      }
      await store.updateBackup(backup.id, {
        status: 'success',
        sizeBytes: result.sizeBytes,
        finishedAt,
        error: null,
      });
      await store.updateJob(jobId, {
        status: 'success',
        finishedAt,
        progress: '完成',
      });
      logger.info('database_backup_job_success', {
        profileId: profile.id,
        backupId: backup.id,
        jobId,
        sizeBytes: result.sizeBytes,
      });
    } catch (error) {
      const message = jobError(error, password);
      await markBackupFailed(backup, message, true);
      await store
        .updateJob(jobId, {
          status: 'failed',
          error: message,
          finishedAt: new Date().toISOString(),
        })
        .catch(() => undefined);
      logger.error('database_backup_job_failed', {
        profileId: profile.id,
        backupId: backup.id,
        jobId,
        error: message,
      });
    } finally {
      cancelled.delete(jobId);
    }
  }

  async function runRestore(
    profile: DatabaseProfile,
    password: string | null,
    backup: DatabaseBackupRecord,
    jobId: string,
  ): Promise<void> {
    if (cancelled.has(jobId)) {
      await store
        .updateJob(jobId, {
          status: 'failed',
          error: '任务已取消',
          finishedAt: new Date().toISOString(),
        })
        .catch(() => undefined);
      cancelled.delete(jobId);
      return;
    }
    const startedAt = new Date().toISOString();
    const onProgress = progressUpdater(jobId);
    try {
      await store.updateJob(jobId, {
        status: 'running',
        startedAt,
        progress: '准备恢复',
      });
      if (profile.kind === 'postgres') {
        await postgres.restore(profile, password, backup, { onProgress });
      } else {
        await redis.restoreLogical(profile, password, backup, { onProgress });
      }
      const finishedAt = new Date().toISOString();
      if (cancelled.has(jobId)) {
        await store.updateJob(jobId, {
          status: 'failed',
          error: '任务已取消',
          finishedAt,
        });
        return;
      }
      await store.updateJob(jobId, {
        status: 'success',
        finishedAt,
        progress: '完成',
      });
      logger.info('database_restore_job_success', {
        profileId: profile.id,
        backupId: backup.id,
        jobId,
      });
    } catch (error) {
      const message = jobError(error, password);
      await store
        .updateJob(jobId, {
          status: 'failed',
          error: message,
          finishedAt: new Date().toISOString(),
        })
        .catch(() => undefined);
      logger.error('database_restore_job_failed', {
        profileId: profile.id,
        backupId: backup.id,
        jobId,
        error: message,
      });
    } finally {
      cancelled.delete(jobId);
    }
  }

  function schedule(task: () => Promise<void>): void {
    setImmediate(() => {
      void task().catch((error: unknown) => {
        logger.error('database_job_unhandled', { error: tailText(describeError(error), 300) });
      });
    });
  }

  // worker 重启后遗留的 queued/running 标记为 failed，绝不续跑。
  void (async () => {
    try {
      const now = new Date().toISOString();
      let reaped = 0;
      for (const job of await store.listJobs()) {
        if (!ACTIVE_JOB_STATUSES.has(job.status)) continue;
        await store.updateJob(job.id, {
          status: 'failed',
          error: 'worker restarted',
          finishedAt: now,
        });
        reaped += 1;
      }
      for (const backup of await store.listAllBackups()) {
        if (backup.status !== 'running') continue;
        await store.updateBackup(backup.id, {
          status: 'failed',
          error: 'worker restarted',
          finishedAt: now,
        });
      }
      if (reaped > 0) logger.warn('database_jobs_reaped', { count: reaped });
    } catch (error) {
      logger.warn('database_jobs_reap_failed', {
        error: tailText(describeError(error), 300),
      });
    } finally {
      // 新任务必须等清理完成，避免把刚创建的任务误标为 worker restarted。
      markReady();
    }
  })();

  return {
    async startBackup(profileId, body) {
      await ready;
      return withProfileLock(profileId, async () => {
        const profile = await requireProfile(profileId);
        await assertNoActiveJob(profileId);
        const format = body.format ?? defaultFormat(profile.kind);
        assertFormat(profile.kind, format);
        if (profile.kind === 'postgres') {
          await assertPgTools(format === 'plain' ? 'plain' : 'custom', 'backup');
        }
        const password = await requirePassword(profileId);
        const backupId = newDatabaseId('bkp');
        const jobId = newDatabaseId('job');
        const fileName = `${backupId}.${extensionFor(format)}`;
        const filePath = backupFilePath(profileId, fileName);
        await mkdir(dirname(filePath), { recursive: true });
        const now = new Date().toISOString();
        const label = body.label?.trim();
        const backup: DatabaseBackupRecord = {
          id: backupId,
          profileId,
          kind: profile.kind,
          format,
          label: label !== undefined && label.length > 0 ? label : null,
          fileName,
          sizeBytes: 0,
          status: 'running',
          createdAt: now,
          finishedAt: null,
          error: null,
          path: filePath,
        };
        await store.createBackup(backup);
        const job: DatabaseJob = {
          id: jobId,
          profileId,
          type: 'backup',
          status: 'queued',
          backupId,
          startedAt: null,
          finishedAt: null,
          progress: '等待开始',
          error: null,
        };
        await store.createJob(job);
        schedule(() => runBackup(profile, password, backup, jobId));
        return job;
      });
    },

    async startRestore(profileId, body) {
      await ready;
      return withProfileLock(profileId, async () => {
        const profile = await requireProfile(profileId);
        if (body.confirm !== true) {
          throw badRequest('恢复操作必须显式传入 confirm=true');
        }
        await assertNoActiveJob(profileId);
        const backup = await store.getBackup(body.backupId);
        if (backup === undefined) {
          throw new PanelError('NOT_FOUND', '备份记录不存在', { backupId: body.backupId });
        }
        if (backup.profileId !== profileId) {
          throw badRequest('备份不属于该数据库档案', { backupId: backup.id });
        }
        if (backup.status !== 'success') {
          throw badRequest('只允许从成功的备份恢复', { backupId: backup.id, status: backup.status });
        }
        if (backup.kind !== profile.kind) {
          throw badRequest('备份与档案类型不匹配', { kind: backup.kind });
        }
        if (profile.kind === 'postgres') {
          if (backup.format !== 'custom' && backup.format !== 'plain') {
            throw badRequest('PostgreSQL 只支持 custom/plain 格式恢复', {
              format: backup.format,
            });
          }
          await assertPgTools(backup.format, 'restore');
        } else if (backup.format === 'rdb') {
          throw unavailable(
            'RDB 备份不能在线恢复',
            '停止 Redis，用备份的 rdb 文件替换数据目录中的 dump 文件后再启动；在线恢复请使用 logical 备份。',
            { format: 'rdb' },
          );
        }
        const filePath = filePathOf(backup);
        const info = await stat(filePath).catch(() => null);
        if (info === null) {
          throw new PanelError('NOT_FOUND', '备份文件不存在或已被删除', {
            backupId: backup.id,
          });
        }
        const password = await requirePassword(profileId);
        const job: DatabaseJob = {
          id: newDatabaseId('job'),
          profileId,
          type: 'restore',
          status: 'queued',
          backupId: backup.id,
          startedAt: null,
          finishedAt: null,
          progress: '等待开始',
          error: null,
        };
        await store.createJob(job);
        schedule(() => runRestore(profile, password, backup, job.id));
        return job;
      });
    },

    async getJob(id) {
      return store.getJob(id);
    },

    async listJobs(q) {
      const jobs = await store.listJobs(q.profileId);
      const filtered = jobs.filter((job) => q.status === undefined || job.status === q.status);
      return pageSlice(filtered, q);
    },

    cancel(profileId) {
      void (async () => {
        const jobs = await store.listJobs(profileId);
        for (const job of jobs) {
          if (!ACTIVE_JOB_STATUSES.has(job.status)) continue;
          cancelled.add(job.id);
          await store
            .updateJob(job.id, {
              status: 'failed',
              error: '任务已取消',
              finishedAt: new Date().toISOString(),
            })
            .catch(() => undefined);
        }
      })().catch((error: unknown) => {
        logger.warn('database_job_cancel_failed', {
          profileId,
          error: tailText(describeError(error), 200),
        });
      });
    },

    async listBackups(profileId, q) {
      const backups = await store.listBackups(profileId);
      return pageSlice(backups, q);
    },

    async getBackup(id) {
      return store.getBackup(id);
    },

    async deleteBackup(id) {
      const backup = await store.getBackup(id);
      if (backup === undefined) {
        throw new PanelError('NOT_FOUND', '备份记录不存在', { id });
      }
      if (backup.status === 'running') {
        throw new PanelError('CONFLICT', '备份仍在进行中，不能删除', { id });
      }
      const jobs = await store.listJobs(backup.profileId);
      const using = jobs.find(
        (job) => job.backupId === id && ACTIVE_JOB_STATUSES.has(job.status),
      );
      if (using !== undefined) {
        throw new PanelError('CONFLICT', '备份正被恢复任务使用', { id, jobId: using.id });
      }
      const filePath = filePathOf(backup);
      try {
        await unlink(filePath);
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) {
          throw new PanelError(
            'UPSTREAM_ERROR',
            `删除备份文件失败：${tailText(describeError(error), 300)}`,
            { id },
            { cause: error },
          );
        }
      }
      await store.deleteBackup(id);
      logger.info('database_backup_deleted', { backupId: id, profileId: backup.profileId });
    },

    async resolveBackupFile(id) {
      const backup = await store.getBackup(id);
      if (backup === undefined) {
        throw new PanelError('NOT_FOUND', '备份记录不存在', { id });
      }
      const filePath = filePathOf(backup);
      const info = await stat(filePath).catch(() => null);
      if (info === null) {
        throw new PanelError('NOT_FOUND', '备份文件不存在或已被删除', { id });
      }
      return { backup, path: filePath, sizeBytes: info.size };
    },
  };
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === code
  );
}
