import { chmod, mkdir, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Pool, PoolConfig } from 'pg';
import { PanelError, badRequest, isPanelError, unavailable } from '@mpanel/shared';
import type {
  BackupRecord,
  CommandRunner,
  DatabaseProfile,
  DatabaseTestResult,
  PostgresStats,
} from '@mpanel/shared';
import type { WorkerConfig } from '../../config.js';
import type { WorkerLogger } from '../../logger.js';
import {
  commandFailure,
  describeError,
  requireTool,
  runStreamingCommand,
  scrubSecret,
  tailText,
} from './exec.js';

/** 共享 PostgresStats 之外的补充指标（活跃事务最长时长）。 */
export type PostgresStatsDetail = PostgresStats & {
  longestTransactionSec: number | null;
};

export interface PostgresDatabaseInfo {
  name: string;
  sizeBytes: number;
  owner: string | null;
  allowConnections: boolean;
  isTemplate: boolean;
}

export interface PostgresTableInfo {
  schema: string;
  name: string;
  estimatedRows: number;
  sizeBytes: number;
}

export interface PostgresSlowQuery {
  pid: number;
  username: string | null;
  database: string | null;
  state: string | null;
  durationSec: number;
  query: string;
  client: string | null;
}

export interface PostgresBackupOptions {
  format: 'custom' | 'plain';
  filePath: string;
  label?: string;
  /** pg_dump --verbose 的进度文本（已脱敏，不含密码）。 */
  onProgress?: (message: string) => void;
}

export interface PostgresRestoreOptions {
  onProgress?: (message: string) => void;
}

export interface PostgresDriver {
  test(profile: DatabaseProfile, password: string | null): Promise<DatabaseTestResult>;
  stats(profile: DatabaseProfile, password: string | null): Promise<PostgresStatsDetail>;
  databases(
    profile: DatabaseProfile,
    password: string | null,
  ): Promise<PostgresDatabaseInfo[]>;
  tables(profile: DatabaseProfile, password: string | null): Promise<PostgresTableInfo[]>;
  slowQueries(
    profile: DatabaseProfile,
    password: string | null,
    limit?: number,
  ): Promise<PostgresSlowQuery[]>;
  probeTools(): Promise<{ pgDump: boolean; pgRestore: boolean; psql: boolean }>;
  backup(
    profile: DatabaseProfile,
    password: string | null,
    opts: PostgresBackupOptions,
  ): Promise<{ filePath: string; sizeBytes: number }>;
  restore(
    profile: DatabaseProfile,
    password: string | null,
    backup: BackupRecord,
    opts?: PostgresRestoreOptions,
  ): Promise<void>;
}

type PoolConstructor = new (config: PoolConfig) => Pool;

interface StatsRow {
  version: string;
  uptime_sec: number | string;
  connections_total: number | string;
  connections_active: number | string;
  connections_idle: number | string;
  connections_idle_in_transaction: number | string;
  database_size_bytes: number | string;
  cache_hit_ratio: number | string | null;
  xact_total: number | string;
  longest_transaction_sec: number | string | null;
}

interface DatabaseRow {
  name: string;
  size_bytes: number | string;
  owner: string | null;
  allow_connections: boolean;
  is_template: boolean;
}

interface TableRow {
  schema_name: string;
  table_name: string;
  estimated_rows: number | string;
  size_bytes: number | string;
}

interface SlowQueryRow {
  pid: number | string;
  username: string | null;
  db_name: string | null;
  state: string | null;
  duration_sec: number | string;
  query_text: string;
  client: string | null;
}

const BACKUP_TIMEOUT_MS = 6 * 60 * 60 * 1000;

const STATS_SQL = `
select
  current_setting('server_version')::text as version,
  extract(epoch from (now() - pg_postmaster_start_time()))::float8 as uptime_sec,
  (select count(*) from pg_stat_activity)::float8 as connections_total,
  (select count(*) from pg_stat_activity where state = 'active')::float8 as connections_active,
  (select count(*) from pg_stat_activity where state = 'idle')::float8 as connections_idle,
  (select count(*) from pg_stat_activity where state = 'idle in transaction')::float8 as connections_idle_in_transaction,
  pg_database_size(current_database())::float8 as database_size_bytes,
  (
    select sum(blks_hit)::float8 / nullif(sum(blks_hit + blks_read), 0)
    from pg_stat_database
    where datname = current_database()
  ) as cache_hit_ratio,
  (
    select coalesce(sum(xact_commit + xact_rollback), 0)::float8
    from pg_stat_database
  ) as xact_total,
  (
    select coalesce(max(extract(epoch from (now() - xact_start))), 0)::float8
    from pg_stat_activity
    where xact_start is not null and pid <> pg_backend_pid()
  ) as longest_transaction_sec
`;

const DATABASES_SQL = `
select
  datname::text as name,
  pg_database_size(datname)::float8 as size_bytes,
  pg_get_userbyid(datdba)::text as owner,
  datallowconn as allow_connections,
  datistemplate as is_template
from pg_database
order by datname
`;

const TABLES_SQL = `
select
  n.nspname::text as schema_name,
  c.relname::text as table_name,
  greatest(c.reltuples, 0)::float8 as estimated_rows,
  pg_total_relation_size(c.oid)::float8 as size_bytes
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p', 'm', 'v')
  and n.nspname not in ('pg_catalog', 'information_schema')
  and n.nspname not like 'pg_toast%'
  and n.nspname not like 'pg_temp_%'
order by pg_total_relation_size(c.oid) desc
limit 500
`;

const SLOW_QUERIES_SQL = `
select
  pid::float8 as pid,
  usename::text as username,
  datname::text as db_name,
  state::text as state,
  coalesce(extract(epoch from (now() - query_start)), 0)::float8 as duration_sec,
  left(coalesce(query, ''), 4000)::text as query_text,
  coalesce(client_addr::text, '')::text as client
from pg_stat_activity
where pid <> pg_backend_pid()
  and state <> 'idle'
  and query_start is not null
order by duration_sec desc
limit $1
`;

let cachedPool: PoolConstructor | null = null;

/** pg 是普通依赖；即使被裁剪也要降级为 UNAVAILABLE，而不是让 worker 启动失败。 */
async function loadPoolConstructor(): Promise<PoolConstructor> {
  if (cachedPool !== null) return cachedPool;
  try {
    const mod: unknown = await import('pg');
    const candidate = mod as {
      default?: { Pool?: PoolConstructor };
      Pool?: PoolConstructor;
    };
    const ctor = candidate.default?.Pool ?? candidate.Pool;
    if (typeof ctor !== 'function') throw new Error('pg.Pool not exported');
    cachedPool = ctor;
    return ctor;
  } catch {
    throw unavailable(
      'PostgreSQL 驱动（pg）不可用',
      '在 worker 主机执行 pnpm install 并重启 worker（pg 是普通依赖，不需要原生编译）。',
      { driver: 'pg' },
    );
  }
}

export function createPostgresDriver(
  config: WorkerConfig,
  runner: CommandRunner,
  logger: WorkerLogger,
): PostgresDriver {
  const backupDir = config.databases.backupDir;

  function poolSettings(profile: DatabaseProfile, password: string | null): PoolConfig {
    const settings: PoolConfig = {
      host: profile.host,
      port: profile.port,
      database: profile.database ?? 'postgres',
      application_name: 'mpanel-worker',
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 5000,
      max: 2,
      statement_timeout: 20000,
      query_timeout: 25000,
    };
    if (profile.username !== null && profile.username.length > 0) settings.user = profile.username;
    if (password !== null && password.length > 0) settings.password = password;
    // sslmode=require 语义：加密但不像 libpq 那样校验 CA。
    if (profile.tls) settings.ssl = { rejectUnauthorized: false };
    return settings;
  }

  async function withPool<T>(
    profile: DatabaseProfile,
    password: string | null,
    fn: (pool: Pool) => Promise<T>,
  ): Promise<T> {
    const PoolCtor = await loadPoolConstructor();
    const pool = new PoolCtor(poolSettings(profile, password));
    // 连接池的空闲连接可能异步报错；必须监听，避免 unhandled 'error'。
    pool.on('error', (error: Error) => {
      logger.warn('postgres_pool_error', {
        profileId: profile.id,
        error: scrubSecret(describeError(error), password),
      });
    });
    try {
      return await fn(pool);
    } finally {
      await pool.end().catch((error: unknown) => {
        logger.debug('postgres_pool_close_failed', {
          profileId: profile.id,
          error: scrubSecret(describeError(error), password),
        });
      });
    }
  }

  async function runQuery<T>(
    profile: DatabaseProfile,
    password: string | null,
    label: string,
    fn: (pool: Pool) => Promise<T>,
  ): Promise<T> {
    try {
      return await withPool(profile, password, fn);
    } catch (error) {
      if (isPanelError(error)) throw error;
      throw new PanelError(
        'UPSTREAM_ERROR',
        `${label}：${tailText(scrubSecret(describeError(error), password), 500)}`,
        { profileId: profile.id },
        { cause: error },
      );
    }
  }

  async function probeBinary(bin: string): Promise<boolean> {
    try {
      const resolved = await runner.which(bin);
      return resolved !== null && resolved.length > 0;
    } catch {
      return false;
    }
  }

  function backupFilePath(backup: BackupRecord): string {
    if (
      backup.fileName.length === 0 ||
      backup.fileName.includes('/') ||
      backup.fileName.includes('\\') ||
      backup.fileName.includes('..')
    ) {
      throw badRequest('备份文件名无效', { fileName: backup.fileName });
    }
    return join(backupDir, backup.profileId, backup.fileName);
  }

  function toolEnv(
    profile: DatabaseProfile,
    password: string | null,
  ): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {
      PGCONNECT_TIMEOUT: '15',
    };
    if (password !== null && password.length > 0) env.PGPASSWORD = password;
    if (profile.tls) env.PGSSLMODE = 'require';
    return env;
  }

  function connectionArgs(profile: DatabaseProfile): string[] {
    const args = [
      '--host',
      profile.host,
      '--port',
      String(profile.port),
      '--dbname',
      profile.database ?? 'postgres',
      '--no-password',
    ];
    if (profile.username !== null && profile.username.length > 0) {
      args.push('--username', profile.username);
    }
    return args;
  }

  return {
    async test(profile, password) {
      const started = performance.now();
      try {
        const version = await withPool(profile, password, async (pool) => {
          const result = await pool.query<{ version: string }>(
            "select current_setting('server_version')::text as version",
          );
          return result.rows[0]?.version ?? 'unknown';
        });
        return {
          ok: true,
          latencyMs: roundMs(performance.now() - started),
          serverVersion: version,
        };
      } catch (error) {
        if (isPanelError(error) && error.code === 'UNAVAILABLE') throw error;
        return {
          ok: false,
          latencyMs: roundMs(performance.now() - started),
          message: tailText(scrubSecret(describeError(error), password), 500),
        };
      }
    },

    async stats(profile, password) {
      return runQuery(profile, password, '读取 PostgreSQL 统计失败', async (pool) => {
        const result = await pool.query<StatsRow>(STATS_SQL);
        const row = result.rows[0];
        if (row === undefined) {
          throw new PanelError('UPSTREAM_ERROR', 'PostgreSQL 未返回统计信息');
        }
        const uptimeSec = Math.max(0, num(row.uptime_sec));
        const cacheHitRatio = nullableNum(row.cache_hit_ratio);
        const xactTotal = num(row.xact_total);
        return {
          kind: 'postgres' as const,
          version: String(row.version),
          uptimeSec: roundMs(uptimeSec),
          connections: {
            total: Math.trunc(num(row.connections_total)),
            active: Math.trunc(num(row.connections_active)),
            idle: Math.trunc(num(row.connections_idle)),
            idleInTransaction: Math.trunc(num(row.connections_idle_in_transaction)),
          },
          databaseSizeBytes: Math.max(0, num(row.database_size_bytes)),
          cacheHitRatio:
            cacheHitRatio === null ? null : roundMs(Math.min(1, Math.max(0, cacheHitRatio))),
          transactionsPerSec: uptimeSec > 0 ? roundMs(xactTotal / uptimeSec) : null,
          longestTransactionSec:
            row.longest_transaction_sec === null
              ? null
              : roundMs(Math.max(0, num(row.longest_transaction_sec))),
        };
      });
    },

    async databases(profile, password) {
      return runQuery(profile, password, '读取 PostgreSQL 数据库列表失败', async (pool) => {
        const result = await pool.query<DatabaseRow>(DATABASES_SQL);
        return result.rows.map((row) => ({
          name: String(row.name),
          sizeBytes: Math.max(0, num(row.size_bytes)),
          owner: row.owner ?? null,
          allowConnections: row.allow_connections === true,
          isTemplate: row.is_template === true,
        }));
      });
    },

    async tables(profile, password) {
      return runQuery(profile, password, '读取 PostgreSQL 数据表列表失败', async (pool) => {
        const result = await pool.query<TableRow>(TABLES_SQL);
        return result.rows.map((row) => ({
          schema: String(row.schema_name),
          name: String(row.table_name),
          estimatedRows: Math.max(0, Math.trunc(num(row.estimated_rows))),
          sizeBytes: Math.max(0, num(row.size_bytes)),
        }));
      });
    },

    async slowQueries(profile, password, limit = 10) {
      const bounded = Math.min(100, Math.max(1, Math.trunc(limit)));
      return runQuery(profile, password, '读取 PostgreSQL 慢查询失败', async (pool) => {
        const result = await pool.query<SlowQueryRow>(SLOW_QUERIES_SQL, [bounded]);
        return result.rows.map((row) => ({
          pid: Math.trunc(num(row.pid)),
          username: row.username ?? null,
          database: row.db_name ?? null,
          state: row.state ?? null,
          durationSec: roundMs(Math.max(0, num(row.duration_sec))),
          query: typeof row.query_text === 'string' ? row.query_text : '',
          client: row.client ?? null,
        }));
      });
    },

    async probeTools() {
      const [pgDump, pgRestore, psql] = await Promise.all([
        probeBinary(config.databases.pgDumpBin),
        probeBinary(config.databases.pgRestoreBin),
        probeBinary(config.databases.psqlBin),
      ]);
      return { pgDump, pgRestore, psql };
    },

    async backup(profile, password, opts) {
      const bin = await requireTool(
        runner,
        config.databases.pgDumpBin,
        'MPANEL_PG_DUMP_BIN',
        'pg_dump 备份',
      );
      await mkdir(dirname(opts.filePath), { recursive: true });
      const args = [
        ...connectionArgs(profile),
        `--format=${opts.format}`,
        `--file=${opts.filePath}`,
        '--verbose',
      ];
      logger.info('postgres_backup_started', {
        profileId: profile.id,
        format: opts.format,
        database: profile.database ?? 'postgres',
      });
      const result = await runStreamingCommand(
        runner,
        bin,
        args,
        { env: toolEnv(profile, password), timeoutMs: BACKUP_TIMEOUT_MS },
        {
          onStderrLine: (line) => {
            const message = parseDumpProgress(line);
            if (message !== undefined) opts.onProgress?.(message);
          },
        },
      );
      if (result.code !== 0) {
        await unlink(opts.filePath).catch(() => undefined);
        throw commandFailure('pg_dump', result, password);
      }
      const info = await stat(opts.filePath).catch(() => null);
      if (info === null) {
        throw new PanelError('UPSTREAM_ERROR', 'pg_dump 未生成备份文件');
      }
      await chmod(opts.filePath, 0o600).catch(() => undefined);
      logger.info('postgres_backup_finished', {
        profileId: profile.id,
        sizeBytes: info.size,
      });
      return { filePath: opts.filePath, sizeBytes: info.size };
    },

    async restore(profile, password, backup, opts = {}) {
      if (backup.kind !== 'postgres') {
        throw badRequest('备份与档案类型不匹配', { kind: backup.kind });
      }
      if (backup.format !== 'custom' && backup.format !== 'plain') {
        throw badRequest('PostgreSQL 只支持 custom/plain 格式恢复', {
          format: backup.format,
        });
      }
      const filePath = backupFilePath(backup);
      const info = await stat(filePath).catch(() => null);
      if (info === null) {
        throw new PanelError('NOT_FOUND', '备份文件不存在或已被删除', {
          backupId: backup.id,
        });
      }

      const env = toolEnv(profile, password);
      const isCustom = backup.format === 'custom';
      const bin = isCustom
        ? await requireTool(
            runner,
            config.databases.pgRestoreBin,
            'MPANEL_PG_RESTORE_BIN',
            'pg_restore 恢复',
          )
        : await requireTool(runner, config.databases.psqlBin, 'MPANEL_PSQL_BIN', 'psql 恢复');
      const args = isCustom
        ? [
            ...connectionArgs(profile),
            '--clean',
            '--if-exists',
            '--no-owner',
            '--verbose',
            filePath,
          ]
        : [
            ...connectionArgs(profile),
            '--set=ON_ERROR_STOP=on',
            '--file',
            filePath,
          ];

      opts.onProgress?.(
        isCustom ? '正在使用 pg_restore 恢复数据库' : '正在使用 psql 执行 SQL 脚本',
      );
      logger.info('postgres_restore_started', {
        profileId: profile.id,
        backupId: backup.id,
        format: backup.format,
      });
      const result = await runStreamingCommand(
        runner,
        bin,
        args,
        { env, timeoutMs: BACKUP_TIMEOUT_MS },
        {
          onStderrLine: (line) => {
            const message = parseRestoreProgress(line);
            if (message !== undefined) opts.onProgress?.(message);
          },
        },
      );
      if (result.code !== 0) {
        throw commandFailure(isCustom ? 'pg_restore' : 'psql', result, password);
      }
      logger.info('postgres_restore_finished', {
        profileId: profile.id,
        backupId: backup.id,
      });
    },
  };
}

function parseDumpProgress(line: string): string | undefined {
  const table = /dumping contents of table\s+"?([^"]+)"?/i.exec(line);
  if (table !== null && table[1] !== undefined) return `正在导出数据表 ${table[1]}`;
  if (/dumping database/i.test(line)) return '正在导出数据库';
  if (/reading schemas/i.test(line)) return '正在读取 schema';
  return undefined;
}

function parseRestoreProgress(line: string): string | undefined {
  const processing = /processing item\s+"?([^"]+)"?/i.exec(line);
  if (processing !== null && processing[1] !== undefined) {
    return `正在恢复 ${processing[1]}`;
  }
  if (/creating (?:table|index|constraint)/i.test(line)) {
    return tailText(line.replace(/^pg_restore:\s*/i, ''), 160);
  }
  return undefined;
}

function num(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function nullableNum(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = num(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundMs(value: number): number {
  const safe = Number.isFinite(value) ? value : 0;
  return Math.round(safe * 10) / 10;
}
