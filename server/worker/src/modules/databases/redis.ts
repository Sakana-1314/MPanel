import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { chmod, copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { finished } from 'node:stream/promises';
import { PanelError, badRequest, isPanelError, unavailable } from '@mpanel/shared';
import type {
  BackupRecord,
  CommandRunner,
  DatabaseProfile,
  DatabaseTestResult,
  RedisStats,
} from '@mpanel/shared';
import type { Redis, RedisOptions } from 'ioredis';
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

/** 共享 RedisStats 之外的补充指标：命中率与 key 总数。 */
export type RedisStatsDetail = RedisStats & {
  hitRate: number | null;
  totalKeys: number;
};

export interface RedisKeyspaceEntry {
  db: number;
  keys: number;
  expires: number;
}

export interface RedisSlowlogEntry {
  id: number;
  timestamp: number;
  durationUs: number;
  command: string[];
  client: string | null;
  clientName: string | null;
}

export interface RedisBackupOptions {
  filePath: string;
  onProgress?: (message: string) => void;
}

export interface RedisRestoreOptions {
  onProgress?: (message: string) => void;
}

export interface RedisDriver {
  test(profile: DatabaseProfile, password: string | null): Promise<DatabaseTestResult>;
  stats(profile: DatabaseProfile, password: string | null): Promise<RedisStatsDetail>;
  keyspace(
    profile: DatabaseProfile,
    password: string | null,
  ): Promise<RedisKeyspaceEntry[]>;
  slowlog(
    profile: DatabaseProfile,
    password: string | null,
    limit?: number,
  ): Promise<RedisSlowlogEntry[]>;
  /** 仅允许 REDIS_READONLY_COMMANDS 中的命令。 */
  readOnly(
    profile: DatabaseProfile,
    password: string | null,
    command: string,
    args?: readonly (string | number)[],
  ): Promise<unknown>;
  probeTools(): Promise<{ redisCli: boolean }>;
  /** ioredis SCAN/DUMP + RESTORE；可在线恢复。 */
  backupLogical(
    profile: DatabaseProfile,
    password: string | null,
    opts: RedisBackupOptions,
  ): Promise<{ filePath: string; sizeBytes: number }>;
  restoreLogical(
    profile: DatabaseProfile,
    password: string | null,
    backup: BackupRecord,
    opts?: RedisRestoreOptions,
  ): Promise<void>;
  /** BGSAVE + CONFIG GET dir/dbfilename 后复制 rdb；恢复必须离线，返回 UNAVAILABLE。 */
  backupRdb(
    profile: DatabaseProfile,
    password: string | null,
    opts: RedisBackupOptions,
  ): Promise<{ filePath: string; sizeBytes: number }>;
}

type RedisConstructor = new (options: RedisOptions) => Redis;

const BGSAVE_TIMEOUT_MS = 30 * 60 * 1000;
/** 备份/恢复时单条 DUMP/RESTORE 可能很慢，放宽 ioredis 命令超时。 */
const LONG_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const SCAN_BATCH = 500;
const LOGICAL_HEADER = 'mpanel-redis-logical';

/**
 * 只读命令白名单。CONFIG/CLIENT/DEBUG/KEYS 等可能泄露凭据或阻塞实例的命令
 * 一律不在此列；调用方必须经 assertReadOnlyRedisCommand。
 */
export const REDIS_READONLY_COMMANDS: ReadonlySet<string> = new Set([
  'PING',
  'INFO',
  'DBSIZE',
  'SCAN',
  'TYPE',
  'TTL',
  'PTTL',
  'EXISTS',
  'GET',
  'MGET',
  'STRLEN',
  'GETRANGE',
  'HGET',
  'HMGET',
  'HGETALL',
  'HLEN',
  'HKEYS',
  'HVALS',
  'HEXISTS',
  'HSCAN',
  'LLEN',
  'LRANGE',
  'LINDEX',
  'SMEMBERS',
  'SCARD',
  'SISMEMBER',
  'SSCAN',
  'ZCARD',
  'ZRANGE',
  'ZSCORE',
  'ZRANK',
  'ZSCAN',
  'XLEN',
  'XRANGE',
  'XINFO',
  'OBJECT',
  'MEMORY',
  'SLOWLOG',
  'TIME',
  'LASTSAVE',
  'ROLE',
  'COMMAND',
  'RANDOMKEY',
]);

export function assertReadOnlyRedisCommand(command: string): string {
  const name = command.trim().toUpperCase();
  if (!/^[A-Z]{2,32}$/.test(name) || !REDIS_READONLY_COMMANDS.has(name)) {
    throw new PanelError('BAD_REQUEST', `Redis 命令不在只读白名单内：${name || '(empty)'}`, {
      command: name,
    });
  }
  return name;
}

let cachedRedis: RedisConstructor | null = null;

async function loadRedisConstructor(): Promise<RedisConstructor> {
  if (cachedRedis !== null) return cachedRedis;
  try {
    const mod: unknown = await import('ioredis');
    const candidate = mod as { default?: unknown; Redis?: unknown };
    const ctor = typeof candidate.Redis === 'function' ? candidate.Redis : candidate.default;
    if (typeof ctor !== 'function') throw new Error('Redis constructor not exported');
    cachedRedis = ctor as RedisConstructor;
    return cachedRedis;
  } catch {
    throw unavailable(
      'Redis 驱动（ioredis）不可用',
      '在 worker 主机执行 pnpm install 并重启 worker（ioredis 不需要原生编译）。',
      { driver: 'ioredis' },
    );
  }
}

export function createRedisDriver(
  config: WorkerConfig,
  runner: CommandRunner,
  logger: WorkerLogger,
): RedisDriver {
  const backupDir = config.databases.backupDir;

  function options(
    profile: DatabaseProfile,
    password: string | null,
    commandTimeoutMs = 30000,
  ): RedisOptions {
    const settings: RedisOptions = {
      host: profile.host,
      port: profile.port,
      db: profile.redisDb ?? 0,
      lazyConnect: true,
      connectTimeout: 5000,
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      retryStrategy: () => null,
      connectionName: 'mpanel-worker',
    };
    if (commandTimeoutMs > 0) settings.commandTimeout = commandTimeoutMs;
    if (profile.username !== null && profile.username.length > 0) {
      settings.username = profile.username;
    }
    if (password !== null && password.length > 0) settings.password = password;
    if (profile.tls) settings.tls = {};
    return settings;
  }

  async function withRedis<T>(
    profile: DatabaseProfile,
    password: string | null,
    fn: (client: Redis) => Promise<T>,
    commandTimeoutMs?: number,
  ): Promise<T> {
    const RedisCtor = await loadRedisConstructor();
    const client = new RedisCtor(options(profile, password, commandTimeoutMs));
    // 连接失败也会 emit 'error'；不监听会导致未捕获异常。
    client.on('error', (error: Error) => {
      logger.debug('redis_client_error', {
        profileId: profile.id,
        error: scrubSecret(describeError(error), password),
      });
    });
    try {
      await client.connect();
      return await fn(client);
    } finally {
      try {
        client.disconnect();
      } catch (error) {
        logger.debug('redis_client_close_failed', {
          profileId: profile.id,
          error: scrubSecret(describeError(error), password),
        });
      }
    }
  }

  async function runRedis<T>(
    profile: DatabaseProfile,
    password: string | null,
    label: string,
    fn: (client: Redis) => Promise<T>,
    commandTimeoutMs?: number,
  ): Promise<T> {
    try {
      return await withRedis(profile, password, fn, commandTimeoutMs);
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

  /** 本地无法读取数据目录时的兜底：redis-cli --rdb <file>。 */
  async function rdbViaCli(
    profile: DatabaseProfile,
    password: string | null,
    opts: RedisBackupOptions,
  ): Promise<void> {
    const bin = await requireTool(
      runner,
      config.databases.redisCliBin,
      'MPANEL_REDIS_CLI_BIN',
      'redis-cli RDB 备份',
    );
    const args = ['-h', profile.host, '-p', String(profile.port), '--no-auth-warning'];
    if (profile.username !== null && profile.username.length > 0) {
      args.push('--user', profile.username);
    }
    if (profile.tls) args.push('--tls', '--insecure');
    args.push('--rdb', opts.filePath);
    const env: Record<string, string | undefined> = {};
    if (password !== null && password.length > 0) env.REDISCLI_AUTH = password;
    const result = await runStreamingCommand(
      runner,
      bin,
      args,
      { env, timeoutMs: BGSAVE_TIMEOUT_MS },
      {
        onStderrLine: (line) => {
          if (line.trim().length > 0) {
            opts.onProgress?.(tailText(scrubSecret(line, password), 160));
          }
        },
        onStdoutLine: (line) => {
          if (line.trim().length > 0) {
            opts.onProgress?.(tailText(scrubSecret(line, password), 160));
          }
        },
      },
    );
    if (result.code !== 0) {
      throw commandFailure('redis-cli --rdb', result, password);
    }
  }

  return {
    async test(profile, password) {
      const started = performance.now();
      try {
        const version = await withRedis(profile, password, async (client) => {
          await client.ping();
          const info = parseInfo(await client.info('server'));
          return info.redis_version ?? 'unknown';
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
      return runRedis(profile, password, '读取 Redis 统计失败', async (client) => {
        const info = parseInfo(await client.info());
        let role = mapRole(info.role);
        try {
          const raw = await client.role();
          const first = Array.isArray(raw) ? raw[0] : undefined;
          if (typeof first === 'string') role = mapRole(first);
        } catch {
          // 旧版本可能不支持 ROLE；INFO replication 已提供 role。
        }
        const keyspace = parseKeyspace(info);
        const maxMemory = num(info.maxmemory);
        const hits = num(info.keyspace_hits);
        const misses = num(info.keyspace_misses);
        return {
          kind: 'redis' as const,
          version: info.redis_version ?? 'unknown',
          uptimeSec: Math.max(0, num(info.uptime_in_seconds)),
          role,
          connectedClients: Math.trunc(Math.max(0, num(info.connected_clients))),
          usedMemoryBytes: Math.max(0, num(info.used_memory)),
          maxMemoryBytes: maxMemory > 0 ? maxMemory : null,
          opsPerSec:
            info.instantaneous_ops_per_sec === undefined
              ? null
              : Math.max(0, num(info.instantaneous_ops_per_sec)),
          keyspace,
          hitRate: hits + misses > 0 ? roundMs(hits / (hits + misses)) : null,
          totalKeys: keyspace.reduce((sum, entry) => sum + entry.keys, 0),
        };
      });
    },

    async keyspace(profile, password) {
      return runRedis(profile, password, '读取 Redis keyspace 失败', async (client) =>
        parseKeyspace(parseInfo(await client.info('keyspace'))),
      );
    },

    async slowlog(profile, password, limit = 20) {
      const bounded = Math.min(100, Math.max(1, Math.trunc(limit)));
      // 再次确认只读白名单，避免未来把该入口扩展到危险命令。
      assertReadOnlyRedisCommand('SLOWLOG');
      return runRedis(profile, password, '读取 Redis slowlog 失败', async (client) => {
        const raw = await client.slowlog('GET', bounded);
        return parseSlowlog(raw);
      });
    },

    async readOnly(profile, password, command, args = []) {
      const name = assertReadOnlyRedisCommand(command);
      return runRedis(profile, password, '执行 Redis 只读命令失败', async (client) =>
        client.call(name, ...args),
      );
    },

    async probeTools() {
      try {
        const resolved = await runner.which(config.databases.redisCliBin);
        return { redisCli: resolved !== null && resolved.length > 0 };
      } catch {
        return { redisCli: false };
      }
    },

    async backupLogical(profile, password, opts) {
      await mkdir(dirname(opts.filePath), { recursive: true });
      const stream = createWriteStream(opts.filePath, { flags: 'w', mode: 0o600 });
      let total = 0;
      let skipped = 0;
      try {
        await writeLine(
          stream,
          JSON.stringify({
            format: LOGICAL_HEADER,
            version: 1,
            createdAt: new Date().toISOString(),
            db: profile.redisDb ?? 0,
          }),
        );
        await runRedis(profile, password, 'Redis 逻辑备份失败', async (client) => {
          let cursor = '0';
          do {
            const [next, keys] = await client.scan(cursor, 'COUNT', SCAN_BATCH);
            cursor = next;
            for (const key of keys) {
              try {
                const rawDump = await client.callBuffer('DUMP', key);
                if (!Buffer.isBuffer(rawDump)) {
                  skipped += 1;
                  continue;
                }
                const pttl = Number(await client.pttl(key));
                const ttl = Number.isFinite(pttl) && pttl > 0 ? pttl : 0;
                await writeLine(
                  stream,
                  JSON.stringify({
                    key: Buffer.from(key, 'utf8').toString('base64'),
                    dump: rawDump.toString('base64'),
                    ttl,
                  }),
                );
                total += 1;
                if (total % 500 === 0) opts.onProgress?.(`已导出 ${total} 个 key`);
              } catch (error) {
                // 模块私有编码等无法 DUMP 的 key 跳过，不中断整库备份。
                skipped += 1;
                logger.warn('redis_backup_skip_key', {
                  profileId: profile.id,
                  reason: tailText(scrubSecret(describeError(error), password), 160),
                });
              }
            }
          } while (cursor !== '0');
        }, LONG_COMMAND_TIMEOUT_MS);
        stream.end();
        await finished(stream);
      } catch (error) {
        stream.destroy();
        throw error;
      }
      const info = await stat(opts.filePath).catch(() => null);
      if (info === null) {
        throw new PanelError('UPSTREAM_ERROR', 'Redis 逻辑备份未生成文件');
      }
      logger.info('redis_logical_backup_finished', {
        profileId: profile.id,
        keys: total,
        skipped,
        sizeBytes: info.size,
      });
      return { filePath: opts.filePath, sizeBytes: info.size };
    },

    async restoreLogical(profile, password, backup, opts = {}) {
      if (backup.kind !== 'redis' || backup.format !== 'logical') {
        throw badRequest('备份格式与 Redis 逻辑恢复不匹配', {
          kind: backup.kind,
          format: backup.format,
        });
      }
      const filePath = backupFilePath(backup);
      const info = await stat(filePath).catch(() => null);
      if (info === null) {
        throw new PanelError('NOT_FOUND', '备份文件不存在或已被删除', { backupId: backup.id });
      }

      let restored = 0;
      let skipped = 0;
      let headerSeen = false;
      const reader = createInterface({
        input: createReadStream(filePath, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      });
      try {
        await runRedis(profile, password, 'Redis 逻辑恢复失败', async (client) => {
          for await (const line of reader) {
            if (line.trim().length === 0) continue;
            let parsed: unknown;
            try {
              parsed = JSON.parse(line);
            } catch {
              throw new PanelError('BAD_REQUEST', '备份文件格式无效（JSON 行解析失败）');
            }
            const record = asLogicalRecord(parsed);
            if (!headerSeen) {
              if (record.header) {
                headerSeen = true;
                continue;
              }
              throw new PanelError('BAD_REQUEST', '备份文件缺少 mpanel 逻辑备份头');
            }
            if (record.key === undefined || record.dump === undefined) continue;
            try {
              const key = Buffer.from(record.key, 'base64');
              const dump = Buffer.from(record.dump, 'base64');
              const ttl = record.ttl !== undefined && record.ttl > 0 ? record.ttl : 0;
              await client.call('RESTORE', key, ttl, dump, 'REPLACE');
              restored += 1;
              if (restored % 500 === 0) opts.onProgress?.(`已恢复 ${restored} 个 key`);
            } catch (error) {
              skipped += 1;
              logger.warn('redis_restore_skip_key', {
                profileId: profile.id,
                reason: tailText(scrubSecret(describeError(error), password), 160),
              });
            }
          }
        }, LONG_COMMAND_TIMEOUT_MS);
      } finally {
        reader.close();
      }
      if (!headerSeen) {
        throw new PanelError('BAD_REQUEST', '备份文件缺少 mpanel 逻辑备份头');
      }
      logger.info('redis_logical_restore_finished', {
        profileId: profile.id,
        backupId: backup.id,
        keys: restored,
        skipped,
      });
    },

    async backupRdb(profile, password, opts) {
      await mkdir(dirname(opts.filePath), { recursive: true });
      let sourcePath: string | null = null;
      try {
        sourcePath = await runRedis(
          profile,
          password,
          'Redis RDB 备份失败',
          async (client) => {
            opts.onProgress?.('正在触发 BGSAVE');
            await client.bgsave();
            await waitForBgsave(client);
            const dir = await readConfigValue(client, 'dir');
            const fileName = (await readConfigValue(client, 'dbfilename')) ?? 'dump.rdb';
            if (dir === null || dir.length === 0) {
              throw new PanelError('UPSTREAM_ERROR', '无法通过 CONFIG GET 获取 Redis 数据目录');
            }
            return isAbsolute(dir) ? join(dir, fileName) : resolve(dir, fileName);
          },
        );
      } catch (error) {
        // 驱动缺失必须直接 UNAVAILABLE；BGSAVE/CONFIG 受限（托管 Redis、只读副本）
        // 或数据目录不可读时改走 redis-cli --rdb。
        if (isPanelError(error) && error.code === 'UNAVAILABLE') throw error;
        logger.warn('redis_rdb_bgsave_unavailable', {
          profileId: profile.id,
          error: tailText(scrubSecret(describeError(error), password), 200),
        });
      }

      if (sourcePath !== null) {
        opts.onProgress?.('正在复制 RDB 文件');
        try {
          await copyFile(sourcePath, opts.filePath);
          await chmod(opts.filePath, 0o600).catch(() => undefined);
        } catch (error) {
          // 远程 Redis（或权限不足）无法直接读数据目录时回退到 redis-cli --rdb。
          logger.warn('redis_rdb_copy_failed', {
            profileId: profile.id,
            error: tailText(scrubSecret(describeError(error), password), 160),
          });
          opts.onProgress?.('正在通过 redis-cli 获取 RDB');
          await rdbViaCli(profile, password, opts);
        }
      } else {
        opts.onProgress?.('正在通过 redis-cli 获取 RDB');
        await rdbViaCli(profile, password, opts);
      }

      const info = await stat(opts.filePath).catch(() => null);
      if (info === null) {
        throw new PanelError('UPSTREAM_ERROR', 'Redis RDB 备份未生成文件');
      }
      logger.info('redis_rdb_backup_finished', {
        profileId: profile.id,
        sizeBytes: info.size,
      });
      return { filePath: opts.filePath, sizeBytes: info.size };
    },
  };
}

function parseInfo(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const index = line.indexOf(':');
    if (index <= 0) continue;
    result[line.slice(0, index)] = line.slice(index + 1);
  }
  return result;
}

function parseKeyspace(info: Record<string, string>): RedisKeyspaceEntry[] {
  const entries: RedisKeyspaceEntry[] = [];
  for (const [key, value] of Object.entries(info)) {
    if (!/^db\d+$/.test(key)) continue;
    const db = Number(key.slice(2));
    let keys = 0;
    let expires = 0;
    for (const part of value.split(',')) {
      const [field, raw] = part.split('=');
      if (field === 'keys') keys = Math.max(0, Math.trunc(num(raw)));
      if (field === 'expires') expires = Math.max(0, Math.trunc(num(raw)));
    }
    entries.push({ db, keys, expires });
  }
  return entries.sort((a, b) => a.db - b.db);
}

function parseSlowlog(raw: unknown): RedisSlowlogEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: RedisSlowlogEntry[] = [];
  for (const item of raw) {
    if (!Array.isArray(item)) continue;
    const args = Array.isArray(item[3])
      ? (item[3] as unknown[]).map((arg) =>
          Buffer.isBuffer(arg) ? arg.toString('utf8') : String(arg),
        )
      : [];
    entries.push({
      id: Math.trunc(num(item[0])),
      timestamp: Math.trunc(num(item[1])),
      durationUs: Math.max(0, num(item[2])),
      command: args,
      client: typeof item[4] === 'string' ? item[4] : null,
      clientName: typeof item[5] === 'string' ? item[5] : null,
    });
  }
  return entries;
}

interface LogicalLine {
  header: boolean;
  key?: string;
  dump?: string;
  ttl?: number;
}

function asLogicalRecord(value: unknown): LogicalLine {
  if (typeof value !== 'object' || value === null) {
    throw new PanelError('BAD_REQUEST', '备份文件格式无效（记录不是对象）');
  }
  const record = value as Record<string, unknown>;
  if (record.format === LOGICAL_HEADER) return { header: true };
  return {
    header: false,
    key: typeof record.key === 'string' ? record.key : undefined,
    dump: typeof record.dump === 'string' ? record.dump : undefined,
    ttl: typeof record.ttl === 'number' ? record.ttl : undefined,
  };
}

async function writeLine(stream: WriteStream, line: string): Promise<void> {
  if (!stream.write(`${line}\n`)) {
    await once(stream, 'drain');
  }
}

async function readConfigValue(client: Redis, parameter: string): Promise<string | null> {
  const reply: unknown = await client.config('GET', parameter);
  if (Array.isArray(reply)) {
    for (let index = 0; index < reply.length - 1; index += 2) {
      if (String(reply[index]).toLowerCase() === parameter.toLowerCase()) {
        return String(reply[index + 1]);
      }
    }
  }
  return null;
}

async function waitForBgsave(client: Redis): Promise<void> {
  const deadline = Date.now() + BGSAVE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const info = parseInfo(await client.info('persistence'));
    const inProgress = info.rdb_bgsave_in_progress;
    const status = info.rdb_last_bgsave_status;
    if (inProgress === '0') {
      if (status !== undefined && status !== 'ok') {
        throw new PanelError('UPSTREAM_ERROR', `Redis BGSAVE 失败：${status}`);
      }
      // 再等一个采样周期，确保 lastsave 已落盘。
      await delay(200);
      return;
    }
    await delay(500);
  }
  throw new PanelError('UPSTREAM_ERROR', 'Redis BGSAVE 超时', { timeoutMs: BGSAVE_TIMEOUT_MS });
}

function mapRole(value: string | undefined): RedisStats['role'] {
  switch ((value ?? '').toLowerCase()) {
    case 'master':
      return 'master';
    case 'slave':
    case 'replica':
      return 'replica';
    case 'sentinel':
      return 'sentinel';
    default:
      return 'unknown';
  }
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

function roundMs(value: number): number {
  const safe = Number.isFinite(value) ? value : 0;
  return Math.round(safe * 10) / 10;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}
