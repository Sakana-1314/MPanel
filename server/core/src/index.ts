import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FastifyBaseLogger } from 'fastify';
import { loadCoreConfig, CoreConfigError } from './config.js';
import { createAuditLog } from './audit.js';
import { createAuthService, runUserCli } from './auth/index.js';
import { createRateLimiter } from './auth/rate-limit.js';
import { buildCoreApp } from './app.js';
import { createMachineService } from './machines/service.js';
import { acquireStateLock } from './store.js';
import { CORE_VERSION } from './system.js';

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;

function formatArg(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value, (_key, item: unknown) =>
      item instanceof Error ? `${item.name}: ${item.message}` : item);
  } catch {
    return String(value);
  }
}

/**
 * 轻量 stderr logger：不引入 pino 依赖，满足 Fastify loggerInstance 的
 * 运行时接口（info/warn/error/child）。stdout 仅用于 port=0 的发现事件。
 */
export function createCoreLogger(level: string): FastifyBaseLogger {
  const configured = LEVELS.indexOf(level as (typeof LEVELS)[number]);
  const effective = configured < 0 ? LEVELS.indexOf('info') : configured;

  const write = (name: (typeof LEVELS)[number]) => (...args: unknown[]): void => {
    if (name === 'silent') return;
    if (LEVELS.indexOf(name) < effective) return;
    const message = args.map(formatArg).join(' ');
    process.stderr.write(`${new Date().toISOString()} ${name.toUpperCase()} ${message}\n`);
  };

  const logger: Record<string, unknown> = { level };
  for (const name of LEVELS) {
    logger[name] = name === 'silent' ? () => undefined : write(name);
  }
  logger.child = () => logger;
  logger.bindings = () => ({});
  logger.flush = () => undefined;
  return logger as unknown as FastifyBaseLogger;
}

function printHelp(): void {
  process.stdout.write(
    [
      '用法: mpanel-core <命令> [选项]',
      '',
      '命令:',
      '  serve                         启动 HTTP 网关（默认）',
      '  user add <username>           创建用户（--password-stdin | --password <pw> [--role admin|operator]）',
      '  user passwd <username>        修改密码（--password-stdin | --password <pw>）',
      '  user list                     列出用户',
      '  user delete <username>        删除用户',
      '  --version                     打印版本',
      '  --help                        打印帮助',
      '',
      '主要环境变量:',
      '  MPANEL_CORE_HOME              状态目录，默认 ~/.mpanel-core',
      '  MPANEL_LISTEN                 监听地址，默认 127.0.0.1:8788（0 表示随机端口）',
      '  MPANEL_ADMIN_USER/MPANEL_ADMIN_PASSWORD  首次启动种子管理员',
      '  MPANEL_SESSION_SECRET         会话/API token 密钥（未设置时自动生成并持久化）',
      '  MPANEL_CORS_ORIGINS           允许的跨域来源，逗号分隔',
      '  MPANEL_WEB_DIST               前端 dist 目录（默认 web/dist）',
      '  MPANEL_TOKEN_TTL              会话/API token 默认 TTL，默认 12h',
      '  MPANEL_TRUST_PROXY            是否信任反向代理头',
      '',
    ].join('\n'),
  );
}

async function serve(): Promise<void> {
  const config = loadCoreConfig();
  await mkdir(config.home, { recursive: true, mode: 0o700 });
  await mkdir(join(config.home, 'state'), { recursive: true, mode: 0o700 });

  const logger = createCoreLogger(config.logLevel);
  const releaseLock = await acquireStateLock(config.home);

  const audit = createAuditLog(join(config.home, 'audit.jsonl'));
  let auth: Awaited<ReturnType<typeof createAuthService>> | undefined;
  let app: Awaited<ReturnType<typeof buildCoreApp>> | undefined;
  let machines: Awaited<ReturnType<typeof createMachineService>> | undefined;

  try {
    auth = await createAuthService(config, logger, audit);
    machines = await createMachineService(config, logger);
    app = await buildCoreApp({
      config,
      auth,
      machines,
      audit,
      rateLimit: createRateLimiter(config.redeemRateLimit),
      logger,
    });

    await app.listen({ host: config.host, port: config.port });
    const address = app.server.address();
    const actualPort =
      typeof address === 'object' && address !== null ? address.port : config.port;
    if (config.port === 0) {
      process.stdout.write(
        `${JSON.stringify({ event: 'listening', host: config.host, port: actualPort })}\n`,
      );
    }
    logger.info(
      {
        listen: `${config.host}:${actualPort}`,
        home: config.home,
        webDir: config.webDir,
        version: CORE_VERSION,
      },
      'MPanel core 已启动',
    );
  } catch (error) {
    await releaseLock().catch(() => undefined);
    throw error;
  }

  let closing = false;
  const shutdown = async (reason: string, exitCode = 0): Promise<void> => {
    if (closing) return;
    closing = true;
    logger.info({ reason }, '正在关闭 MPanel core');
    try {
      if (app !== undefined) await app.close();
    } catch (error) {
      logger.warn({ error: formatArg(error) }, '关闭 HTTP 服务失败');
    }
    try {
      await auth?.close?.();
    } catch (error) {
      logger.warn({ error: formatArg(error) }, '关闭认证服务失败');
    }
    try {
      await machines?.shutdown();
    } catch (error) {
      logger.warn({ error: formatArg(error) }, '关闭机器传输失败');
    }
    try {
      await audit.flush?.();
    } catch (error) {
      logger.warn({ error: formatArg(error) }, '刷新审计日志失败');
    }
    try {
      await releaseLock();
    } catch (error) {
      logger.warn({ error: formatArg(error) }, '释放状态锁失败');
    }
    process.exitCode = exitCode;
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.once('uncaughtException', (error) => {
    process.exitCode = 1;
    logger.error({ error: formatArg(error) }, '未捕获异常，正在关闭');
    void shutdown('uncaughtException', 1);
  });
  process.once('unhandledRejection', (reason) => {
    process.exitCode = 1;
    logger.error({ error: formatArg(reason) }, '未处理的 Promise 拒绝，正在关闭');
    void shutdown('unhandledRejection', 1);
  });
}

/**
 * Core CLI entrypoint.
 *
 * Commands: serve (default), `user add|passwd|list|delete`, --version, --help.
 * Prints `{"event":"listening",...}` on stdout when port=0 (smoke discovery).
 */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const args = [...argv];
  const command = args[0] ?? 'serve';

  if (command === '--version' || command === '-v' || command === 'version') {
    process.stdout.write(`mpanel-core ${CORE_VERSION}\n`);
    return;
  }
  if (command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    return;
  }
  if (command === 'user') {
    const config = loadCoreConfig();
    process.exitCode = await runUserCli(args.slice(1), config);
    return;
  }
  if (command === 'serve') {
    await serve();
    return;
  }

  process.stderr.write(`未知命令: ${command}\n\n`);
  printHelp();
  process.exitCode = 1;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    if (error instanceof CoreConfigError) {
      process.stderr.write(`mpanel-core 配置错误: ${error.message}\n`);
    } else {
      process.stderr.write(`mpanel-core failed: ${String(error)}\n`);
    }
    process.exitCode = 1;
  });
}
