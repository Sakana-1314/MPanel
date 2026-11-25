import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  availableCapability,
  capabilitiesSchema,
  unavailableCapability,
} from '@mpanel/shared';
import type {
  Capabilities,
  CapabilityProvider,
  CapabilityStatus,
  CommandRunner,
} from '@mpanel/shared';
import type { WorkerConfig } from './config.js';
import type { WorkerLogger } from './logger.js';

/**
 * 宿主能力探测：caddy / docker / postgres / redis / pty。
 * 探测失败只返回 available=false，绝不向调用方抛异常；30 秒 TTL 缓存，
 * `GET /system/info?refresh=1` 或写操作前可强制刷新。
 */
export interface CapabilityService extends CapabilityProvider {
  get(force?: boolean): Promise<Capabilities>;
  snapshot(): Capabilities;
  invalidate(): void;
}

export const CAPABILITY_TTL_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;
const PROBE_MAX_BYTES = 256 * 1024;

function errnoOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = errnoOf(error);
    return code === undefined ? error.message : `${code}: ${error.message}`;
  }
  return String(error);
}

function installedVersion(packageName: string): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const packageFile = require.resolve(`${packageName}/package.json`);
    const parsed = JSON.parse(readFileSync(packageFile, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

function tail(text: string, limit = 300): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit)}…`;
}

function versionFrom(text: string): string | undefined {
  const match = /(?:^|\s)(v?\d+\.\d+(?:\.\d+)?(?:[-+][^\s]*)?)/.exec(text);
  return match?.[1];
}

function unavailable(reason: string, details?: Record<string, unknown>): CapabilityStatus {
  return unavailableCapability(reason, details);
}

function initialCapabilities(): Capabilities {
  const waiting = (): CapabilityStatus => unavailable('尚未探测');
  return {
    caddy: waiting(),
    docker: waiting(),
    postgres: waiting(),
    redis: waiting(),
    pty: waiting(),
  };
}

async function probeBinaryVersion(
  runner: CommandRunner,
  bin: string,
  args: readonly string[],
): Promise<{ available: boolean; version?: string; reason?: string; details?: Record<string, unknown> }> {
  const resolved = await runner.which(bin);
  if (resolved === null) {
    return {
      available: false,
      reason: `未找到可执行文件：${bin}`,
      details: { bin, stage: 'lookup', hint: `安装该工具，或用环境变量把 *_BIN 指向绝对路径。` },
    };
  }
  const result = await runner.run(resolved, args, {
    timeoutMs: PROBE_TIMEOUT_MS,
    maxBufferBytes: PROBE_MAX_BYTES,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.timedOut) {
    return {
      available: false,
      reason: `${bin} 版本探测超时`,
      details: { bin: resolved, stage: 'version', hint: `检查 ${resolved} 是否可正常执行。` },
    };
  }
  if (result.code !== 0) {
    return {
      available: false,
      reason: `${bin} 版本探测失败（退出码 ${String(result.code)}）：${tail(output)}`,
      details: { bin: resolved, stage: 'version', code: result.code },
    };
  }
  return {
    available: true,
    ...(versionFrom(output) === undefined ? {} : { version: versionFrom(output) }),
    details: { bin: resolved },
  };
}

export async function probeCaddy(
  config: WorkerConfig,
  runner: CommandRunner,
): Promise<CapabilityStatus> {
  try {
    const probe = await probeBinaryVersion(runner, config.caddy.bin, ['version']);
    if (!probe.available) {
      return unavailable(probe.reason ?? 'Caddy 不可用', {
        ...(probe.details ?? {}),
        hint: '安装 Caddy，或把 MPANEL_CADDY_BIN 设为 caddy 可执行文件的绝对路径，然后重试。',
      });
    }
    return availableCapability(probe.version, {
      ...(probe.details ?? {}),
      ...(config.caddy.adminAddress === undefined
        ? {}
        : { adminAddress: config.caddy.adminAddress }),
      configDir: config.caddy.configDir,
      dataDir: config.caddy.dataDir,
    });
  } catch (error) {
    return unavailable(`Caddy 探测失败：${describe(error)}`, {
      hint: '检查 caddy 二进制是否可执行，以及 worker 进程的运行权限。',
    });
  }
}

export async function probeDocker(
  config: WorkerConfig,
  runner: CommandRunner,
): Promise<CapabilityStatus> {
  try {
    const resolved = await runner.which(config.docker.bin);
    if (resolved === null) {
      return unavailable(`未找到 docker CLI：${config.docker.bin}`, {
        bin: config.docker.bin,
        stage: 'cli',
        hint: '安装 Docker CLI，或把 MPANEL_DOCKER_BIN 设为 docker 可执行文件的绝对路径。',
      });
    }
    const result = await runner.run(
      resolved,
      ['version', '--format', '{{json .Server.Version}}'],
      { timeoutMs: PROBE_TIMEOUT_MS, maxBufferBytes: PROBE_MAX_BYTES },
    );
    if (result.timedOut) {
      return unavailable('docker daemon 探测超时', {
        bin: resolved,
        stage: 'daemon',
        hint: '确认 docker daemon 正在运行，并检查 worker 用户是否有 socket 访问权限。',
      });
    }
    if (result.code !== 0) {
      return unavailable(`docker daemon 不可达：${tail(`${result.stderr}\n${result.stdout}`)}`, {
        bin: resolved,
        stage: 'daemon',
        code: result.code,
        hint: '启动 Docker daemon/Desktop，确认 /var/run/docker.sock（Windows 为命名管道）可访问。',
      });
    }
    const raw = result.stdout.trim();
    let version: string | undefined;
    if (raw.length > 0) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        version = typeof parsed === 'string' ? parsed.trim() : undefined;
      } catch {
        version = raw.replace(/^"|"$/g, '').trim() || undefined;
      }
    }
    return availableCapability(version, {
      bin: resolved,
      daemon: true,
      ...(config.docker.socket === undefined ? {} : { socket: config.docker.socket }),
    });
  } catch (error) {
    return unavailable(`Docker 探测失败：${describe(error)}`, {
      hint: '检查 docker 二进制、daemon 状态与 socket 权限。',
    });
  }
}

interface ToolProbe {
  available: boolean;
  version?: string;
  reason?: string;
  path?: string;
}

async function probeTool(
  runner: CommandRunner,
  bin: string,
  args: readonly string[],
): Promise<ToolProbe> {
  try {
    const resolved = await runner.which(bin);
    if (resolved === null) {
      return { available: false, reason: `未找到 ${bin}` };
    }
    const result = await runner.run(resolved, args, {
      timeoutMs: PROBE_TIMEOUT_MS,
      maxBufferBytes: PROBE_MAX_BYTES,
    });
    if (result.timedOut) {
      return { available: false, reason: `${bin} 探测超时`, path: resolved };
    }
    if (result.code !== 0) {
      return {
        available: false,
        reason: `${bin} 退出码 ${String(result.code)}：${tail(`${result.stderr}\n${result.stdout}`)}`,
        path: resolved,
      };
    }
    const text = `${result.stdout}\n${result.stderr}`;
    return {
      available: true,
      ...(versionFrom(text) === undefined ? {} : { version: versionFrom(text) }),
      path: resolved,
    };
  } catch (error) {
    return { available: false, reason: `${bin} 探测失败：${describe(error)}` };
  }
}

async function loadDriver(specifier: string): Promise<{ ok: boolean; reason?: string; version?: string }> {
  try {
    const moduleValue = (await Promise.race([
      import(specifier),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('加载超时'));
        }, PROBE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ])) as Record<string, unknown>;
    if (typeof moduleValue !== 'object' || moduleValue === null) {
      return { ok: false, reason: '模块为空' };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: describe(error) };
  }
}

export async function probePostgres(
  config: WorkerConfig,
  runner: CommandRunner,
): Promise<CapabilityStatus> {
  try {
    const [driver, pgDump, pgRestore, psql] = await Promise.all([
      loadDriver('pg'),
      probeTool(runner, config.databases.pgDumpBin, ['--version']),
      probeTool(runner, config.databases.pgRestoreBin, ['--version']),
      probeTool(runner, config.databases.psqlBin, ['--version']),
    ]);
    const tools = {
      driver: driver.ok
        ? { available: true }
        : { available: false, reason: driver.reason },
      pgDump: {
        available: pgDump.available,
        ...(pgDump.version === undefined ? {} : { version: pgDump.version }),
        ...(pgDump.path === undefined ? {} : { path: pgDump.path }),
        ...(pgDump.reason === undefined ? {} : { reason: pgDump.reason }),
      },
      pgRestore: {
        available: pgRestore.available,
        ...(pgRestore.version === undefined ? {} : { version: pgRestore.version }),
        ...(pgRestore.path === undefined ? {} : { path: pgRestore.path }),
        ...(pgRestore.reason === undefined ? {} : { reason: pgRestore.reason }),
      },
      psql: {
        available: psql.available,
        ...(psql.version === undefined ? {} : { version: psql.version }),
        ...(psql.path === undefined ? {} : { path: psql.path }),
        ...(psql.reason === undefined ? {} : { reason: psql.reason }),
      },
    };
    const available = driver.ok && pgDump.available && psql.available;
    if (!available) {
      const missing: string[] = [];
      if (!driver.ok) missing.push(`pg 驱动（${driver.reason ?? '不可加载'}）`);
      if (!pgDump.available) missing.push(`pg_dump（${pgDump.reason ?? '不可用'}）`);
      if (!psql.available) missing.push(`psql（${psql.reason ?? '不可用'}）`);
      return unavailable(`PostgreSQL 工具不可用：${missing.join('；')}`, {
        tools,
        hint: '安装 PostgreSQL 客户端工具（pg_dump/psql）与 pg 驱动，或修正 MPANEL_PG_DUMP_BIN / MPANEL_PSQL_BIN。',
      });
    }
    return availableCapability(pgDump.version ?? psql.version, {
      tools,
      pgRestoreAvailable: pgRestore.available,
      driverVersion: installedVersion('pg'),
    });
  } catch (error) {
    return unavailable(`PostgreSQL 探测失败：${describe(error)}`, {
      hint: '检查 pg 驱动与 PostgreSQL 客户端工具。',
    });
  }
}

export async function probeRedis(
  config: WorkerConfig,
  runner: CommandRunner,
): Promise<CapabilityStatus> {
  try {
    const [driver, cli] = await Promise.all([
      loadDriver('ioredis'),
      probeTool(runner, config.databases.redisCliBin, ['--version']),
    ]);
    if (!driver.ok) {
      return unavailable(`Redis 驱动不可用：${driver.reason ?? '无法加载 ioredis'}`, {
        tools: { cli: { available: cli.available, reason: cli.reason, version: cli.version } },
        hint: '重新安装 worker 依赖（ioredis），或改用支持 Redis 的部署产物。',
      });
    }
    return availableCapability(cli.version, {
      tools: {
        driver: { available: true, version: installedVersion('ioredis') },
        cli: {
          available: cli.available,
          ...(cli.version === undefined ? {} : { version: cli.version }),
          ...(cli.reason === undefined ? {} : { reason: cli.reason }),
        },
      },
      rdbAvailable: cli.available,
      ...(cli.available
        ? {}
        : { note: '缺少 redis-cli 时，连通性/统计与 logical 备份仍可用，rdb 物理快照不可用。' }),
    });
  } catch (error) {
    return unavailable(`Redis 探测失败：${describe(error)}`, {
      hint: '检查 ioredis 依赖与 redis-cli 是否安装。',
    });
  }
}

export async function probePty(): Promise<CapabilityStatus> {
  try {
    const specifier = 'node-pty';
    const moduleValue = (await Promise.race([
      import(specifier),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('加载超时'));
        }, PROBE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ])) as Record<string, unknown>;
    const spawnFn =
      typeof moduleValue.spawn === 'function'
        ? moduleValue.spawn
        : typeof (moduleValue.default as Record<string, unknown> | undefined)?.spawn === 'function'
          ? (moduleValue.default as Record<string, unknown>).spawn
          : undefined;
    if (spawnFn === undefined) {
      return unavailable('node-pty 已安装但缺少 spawn 导出', {
        hint: '终端将降级为管道模式；如需 PTY，请重新安装 node-pty 原生模块。',
      });
    }
    return availableCapability(installedVersion('node-pty'), { module: 'node-pty' });
  } catch (error) {
    return unavailable(`node-pty 不可用：${describe(error)}`, {
      hint: '终端会降级为 child_process 管道（pty=false, resize 无效）；需要 PTY 时安装构建工具后重装 node-pty。',
    });
  }
}

async function probeAll(
  config: WorkerConfig,
  runner: CommandRunner,
  logger: WorkerLogger,
): Promise<Capabilities> {
  const results = await Promise.all([
    probeCaddy(config, runner).catch((error: unknown) =>
      unavailable(`Caddy 探测异常：${describe(error)}`),
    ),
    probeDocker(config, runner).catch((error: unknown) =>
      unavailable(`Docker 探测异常：${describe(error)}`),
    ),
    probePostgres(config, runner).catch((error: unknown) =>
      unavailable(`PostgreSQL 探测异常：${describe(error)}`),
    ),
    probeRedis(config, runner).catch((error: unknown) =>
      unavailable(`Redis 探测异常：${describe(error)}`),
    ),
    probePty().catch((error: unknown) => unavailable(`PTY 探测异常：${describe(error)}`)),
  ]);
  const capabilities: Capabilities = {
    caddy: results[0] ?? unavailable('Caddy 探测未返回结果'),
    docker: results[1] ?? unavailable('Docker 探测未返回结果'),
    postgres: results[2] ?? unavailable('PostgreSQL 探测未返回结果'),
    redis: results[3] ?? unavailable('Redis 探测未返回结果'),
    pty: results[4] ?? unavailable('PTY 探测未返回结果'),
  };
  const validated = capabilitiesSchema.safeParse(capabilities);
  if (!validated.success) {
    logger.warn('能力探测结果不符合契约 schema，已降级', {
      issues: validated.error.issues.map((issue) => issue.path.join('.')),
    });
    return initialCapabilities();
  }
  logger.info('能力探测完成', {
    capabilities: Object.fromEntries(
      Object.entries(validated.data).map(([name, status]) => [
        name,
        status.available ? (status.version ?? 'available') : (status.reason ?? 'unavailable'),
      ]),
    ),
  });
  return validated.data;
}

export function createCapabilityService(
  config: WorkerConfig,
  runner: CommandRunner,
  logger: WorkerLogger,
): CapabilityService {
  let cached = initialCapabilities();
  let cachedAt = 0;
  let inflight: Promise<Capabilities> | null = null;

  const get = async (force = false): Promise<Capabilities> => {
    const fresh = cachedAt > 0 && Date.now() - cachedAt < CAPABILITY_TTL_MS;
    if (!force && fresh) return cached;
    if (inflight !== null) return inflight;
    const run = async (): Promise<Capabilities> => {
      try {
        const probed = await probeAll(config, runner, logger);
        cached = probed;
        cachedAt = Date.now();
        return probed;
      } catch (error) {
        logger.warn('能力探测整体失败，保留上一次结果', { error: describe(error) });
        cachedAt = Date.now();
        return cached;
      } finally {
        inflight = null;
      }
    };
    inflight = run();
    return inflight;
  };

  return {
    get,
    snapshot(): Capabilities {
      return structuredClone(cached);
    },
    invalidate(): void {
      cachedAt = 0;
    },
  };
}

/** 返回五个能力的可用性摘要，用于 hello 帧的 worker.capabilities。 */
export function summarizeCapabilities(capabilities: Capabilities): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const [name, status] of Object.entries(capabilities)) {
    summary[name] = {
      available: status.available,
      ...(status.version === undefined ? {} : { version: status.version }),
    };
  }
  return summary;
}

/** 探测相关常量，诊断命令复用。 */
export const CAPABILITY_PROBE_TIMEOUT_MS = PROBE_TIMEOUT_MS;

/** 类型辅助：确保初始对象满足 Capabilities。 */
export function pendingCapabilities(): Capabilities {
  return initialCapabilities();
}
