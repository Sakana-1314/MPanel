import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PanelError } from '@mpanel/shared';
import type { CapabilityStatus } from '@mpanel/shared';
import {
  ConfigError,
  assertServableConfig,
  describeConfig,
  defaultHomeDir,
  isConfigError,
  loadWorkerConfig,
} from './config.js';
import type { WorkerConfig } from './config.js';
import { createLogger } from './logger.js';
import type { WorkerLogger } from './logger.js';
import { createCommandRunner } from './exec.js';
import { createCapabilityService } from './capabilities.js';
import { acquireStateLock, writeFileAtomic } from './store.js';
import { createWorkerApp } from './http.js';
import { workerVersion } from './registry.js';
import { createHttpTransport } from './transports/http.js';
import { createStdioTransport } from './transports/stdio.js';
import { createReverseWsTransport } from './transports/reverse-ws.js';
import type { WorkerTransport } from './transports/types.js';
import { createEdgeRuntime } from './edge/index.js';

/**
 * Worker CLI：serve（默认）/ doctor / token generate / --version / --help。
 * SIGINT/SIGTERM 优雅关闭传输、Fastify 与状态锁；stdio 模式 stdout 只允许帧。
 */

const EXIT_CONFIG = 2;
const EXIT_FAILURE = 1;

function writeStdout(text: string): void {
  process.stdout.write(text);
}

function writeStderr(text: string): void {
  process.stderr.write(text);
}

function printHelp(): void {
  writeStdout(
    [
      'MPanel worker',
      '',
      '用法：',
      '  mpanel-worker [serve] [--transport http|stdio|reverse-ws] [--home DIR] [--listen HOST:PORT]',
      '  mpanel-worker doctor [--home DIR]',
      '  mpanel-worker token generate [--length N] [--write] [--home DIR]',
      '  mpanel-worker --version | --help',
      '',
      '命令：',
      '  serve    启动 worker（默认命令）；传输由 --transport 或 MPANEL_TRANSPORT 决定',
      '  doctor   打印配置与能力探测表，不启动监听；能力缺失不视为失败',
      '  token    生成随机访问令牌；--write 写入 $MPANEL_HOME/config.json',
      '',
      '关键环境变量：MPANEL_HOME、MPANEL_LISTEN、MPANEL_TOKEN、MPANEL_TRANSPORT、',
      '  MPANEL_CORE_URL、MPANEL_EDGE_KEY（边缘自助入网）、MPANEL_LOG_LEVEL、',
      '  MPANEL_FILES_ROOTS、MPANEL_CADDY_BIN、MPANEL_DOCKER_BIN、MPANEL_PG_DUMP_BIN、MPANEL_PSQL_BIN。',
      '完整说明见 server/worker/README.md 与 docs/file-layout.md §4.1。',
      '',
    ].join('\n'),
  );
}

function printVersion(): void {
  writeStdout(`mpanel-worker ${workerVersion()}\n`);
}

function flagValue(argv: readonly string[], name: string): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token === `--${name}`) {
      const next = argv[index + 1];
      return next !== undefined && !next.startsWith('-') ? next : undefined;
    }
    if (token.startsWith(`--${name}=`)) return token.slice(name.length + 3);
  }
  return undefined;
}

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function resolveHome(argv: readonly string[]): string {
  const fromFlag = flagValue(argv, 'home');
  if (fromFlag !== undefined) return path.resolve(fromFlag);
  const env = process.env.MPANEL_HOME;
  if (env !== undefined && env.trim().length > 0) return path.resolve(env.trim());
  return defaultHomeDir();
}

function capabilityLine(name: string, status: CapabilityStatus): string {
  const state = status.available ? '可用  ' : '不可用';
  const detail = status.available
    ? status.version ?? '（版本未知）'
    : status.reason ?? '未知原因';
  return `  ${name.padEnd(10, ' ')} ${state}  ${detail}`;
}

async function commandDoctor(argv: readonly string[]): Promise<void> {
  const config = loadWorkerConfig(process.env, argv);
  const logger = createLogger(config.logLevel === 'silent' ? 'error' : config.logLevel, {
    stderrOnly: true,
  });
  const runner = createCommandRunner(logger.child({ component: 'exec' }), {
    defaultTimeoutMs: 5_000,
    maxBufferBytes: 256 * 1024,
  });
  const capabilities = createCapabilityService(config, runner, logger.child({ component: 'capabilities' }));
  const snapshot = await capabilities.get(true);
  const lines: string[] = [
    'MPanel worker 诊断',
    '',
    '配置',
    describeConfig(config),
    '',
    '能力',
    capabilityLine('caddy', snapshot.caddy),
    capabilityLine('docker', snapshot.docker),
    capabilityLine('postgres', snapshot.postgres),
    capabilityLine('redis', snapshot.redis),
    capabilityLine('pty', snapshot.pty),
    '',
  ];
  if (config.token.length === 0) {
    lines.push('提示：MPANEL_TOKEN 未配置，serve 会拒绝启动。运行 `mpanel-worker token generate --write`。');
  }
  if (config.transport === 'reverse-ws') {
    if (config.edgeKey !== undefined) {
      lines.push(
        `边缘模式：启用（MPANEL_EDGE_KEY 已配置，已隐藏；身份文件 ${path.join(config.home, 'edge.json')}）`,
      );
    } else {
      if (config.coreUrl === undefined) lines.push('提示：reverse-ws 需要 MPANEL_CORE_URL。');
      if (config.machineSecret === undefined) lines.push('提示：reverse-ws 需要 MPANEL_MACHINE_SECRET。');
    }
  }
  lines.push('说明：能力不可用只影响对应模块的写操作；worker 仍会正常启动。');
  lines.push('');
  writeStdout(`${lines.join('\n')}\n`);
  logger.close?.();
}

interface TokenOptions {
  length: number;
  write: boolean;
  home: string;
}

function parseTokenOptions(argv: readonly string[]): TokenOptions {
  const lengthText = flagValue(argv, 'length');
  const length = lengthText === undefined ? 32 : Number(lengthText);
  if (!Number.isInteger(length) || length < 16 || length > 128) {
    throw new PanelError('BAD_REQUEST', '--length 必须是 16-128 的整数（字节数）');
  }
  return {
    length,
    write: hasFlag(argv, 'write'),
    home: resolveHome(argv),
  };
}

function tokenConfigPath(home: string): string {
  return path.join(home, 'config.json');
}

function readTokenConfig(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    throw new ConfigError([
      `无法读取配置文件 ${file}：${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  if (raw.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new ConfigError([
      `配置文件 ${file} 不是合法 JSON，已拒绝覆盖：${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError([`配置文件 ${file} 必须是 JSON 对象`]);
  }
  return { ...(parsed as Record<string, unknown>) };
}

async function commandToken(argv: readonly string[]): Promise<void> {
  const options = parseTokenOptions(argv);
  const token = randomBytes(options.length).toString('base64url');
  if (!options.write) {
    writeStdout(`${token}\n`);
    writeStderr(
      `提示：把该值设为 MPANEL_TOKEN，或用 --write 写入 ${tokenConfigPath(options.home)}。\n`,
    );
    return;
  }
  const file = tokenConfigPath(options.home);
  const existing = readTokenConfig(file);
  const next = { ...existing, token };
  mkdirSync(options.home, { recursive: true });
  await writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
  writeStdout(`${token}\n`);
  writeStderr(`已写入 ${file}\n`);
}

function createTransport(
  config: WorkerConfig,
  app: Awaited<ReturnType<typeof createWorkerApp>>,
  logger: WorkerLogger,
): WorkerTransport {
  switch (config.transport) {
    case 'stdio':
      return createStdioTransport({ config, app: app.app, logger });
    case 'reverse-ws':
      return createReverseWsTransport({ config, app: app.app, logger });
    case 'http':
    default:
      return createHttpTransport({ config, app: app.app, logger });
  }
}

async function commandServe(argv: readonly string[]): Promise<void> {
  const config = loadWorkerConfig(process.env, argv);
  mkdirSync(path.join(config.home, 'logs'), { recursive: true });
  const logger = createLogger(config.logLevel, {
    stderrOnly: config.transport === 'stdio',
    file: path.join(config.home, 'logs', 'worker.log'),
  });

  // 边缘模式：先用 MPANEL_EDGE_KEY 入网（或复用 edge.json），再校验可服务配置。
  // 失败时 worker 不启动；日志只记录状态/错误，永不打印 key/secret。
  const edgeRuntime = createEdgeRuntime(config, logger);
  if (edgeRuntime !== null) {
    try {
      await edgeRuntime.ensureIdentity();
    } catch (error) {
      logger.error('边缘入网失败，worker 无法启动', {
        error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
      });
      logger.close?.();
      throw error;
    }
  }
  assertServableConfig(config);

  let releaseLock: (() => Promise<void>) | null = null;
  let app: Awaited<ReturnType<typeof createWorkerApp>> | null = null;
  let transport: WorkerTransport | null = null;
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      process.exit(EXIT_FAILURE);
    }
    shuttingDown = true;
    logger.info('收到退出信号，正在优雅关闭', { signal });
    edgeRuntime?.stop();
    try {
      await transport?.stop();
    } catch (error) {
      logger.warn('停止传输失败', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      await app?.close();
    } catch (error) {
      logger.warn('关闭应用失败', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      await releaseLock?.();
    } catch {
      // 锁清理失败不阻塞退出。
    }
    logger.close?.();
  };

  const onSignal = (signal: string): void => {
    void shutdown(signal).catch((error: unknown) => {
      writeStderr(`mpanel-worker 关闭时出错：${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = EXIT_FAILURE;
    });
  };
  const sigint = (): void => onSignal('SIGINT');
  const sigterm = (): void => onSignal('SIGTERM');
  process.once('SIGINT', sigint);
  process.once('SIGTERM', sigterm);

  try {
    releaseLock = await acquireStateLock(config.home, 'worker');
    logger.info('MPanel worker 启动中', {
      version: workerVersion(),
      transport: config.transport,
      home: config.home,
      logLevel: config.logLevel,
    });
    app = await createWorkerApp(config, logger);
    transport = createTransport(config, app, edgeRuntime?.wrapLogger(logger) ?? logger);
    await transport.start();
    logger.info('worker 已就绪', {
      transport: config.transport,
      ...(config.transport === 'http' ? { host: config.host, port: config.port } : {}),
      modules: app.modules.map((module) => module.name),
      wsRoutes: app.wsRoutes(),
    });
    const stopped = transport.waitForStop?.() ?? new Promise<void>(() => undefined);
    await stopped;
    if (!shuttingDown) {
      logger.info('传输已结束，worker 退出');
      await shutdown('transport-ended');
    }
  } catch (error) {
    await shutdown('startup-error');
    throw error;
  } finally {
    process.off('SIGINT', sigint);
    process.off('SIGTERM', sigterm);
  }
}

async function dispatch(argv: readonly string[]): Promise<void> {
  const first = argv[0];
  if (argv.includes('--help') || argv.includes('-h') || first === 'help') {
    printHelp();
    return;
  }
  if (argv.includes('--version') || argv.includes('-v') || first === 'version') {
    printVersion();
    return;
  }
  if (first === 'doctor') {
    await commandDoctor(argv.slice(1));
    return;
  }
  if (first === 'token') {
    // 兼容 `token generate` 与直接 `token` 两种写法。
    const rest = argv[1] === 'generate' ? argv.slice(2) : argv.slice(1);
    await commandToken(rest);
    return;
  }
  if (first === 'serve') {
    await commandServe(argv.slice(1));
    return;
  }
  if (first !== undefined && !first.startsWith('--')) {
    throw new PanelError('BAD_REQUEST', `未知命令：${first}`, {
      hint: '可用命令：serve、doctor、token generate、--version、--help。',
    });
  }
  await commandServe(argv);
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  try {
    await dispatch(argv);
  } catch (error) {
    if (isConfigError(error)) {
      writeStderr(`${error.message}\n`);
      process.exitCode = EXIT_CONFIG;
      return;
    }
    if (error instanceof PanelError) {
      writeStderr(`mpanel-worker 失败：${error.message}\n`);
      process.exitCode = EXIT_FAILURE;
      return;
    }
    writeStderr(`mpanel-worker 失败：${error instanceof Error ? error.message : String(error)}\n`);
    if (error instanceof Error && error.stack !== undefined) {
      writeStderr(`${error.stack}\n`);
    }
    process.exitCode = EXIT_FAILURE;
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void main();
}
