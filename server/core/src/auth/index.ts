import { chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import { PanelError } from '@mpanel/shared';
import type { AuthUser } from '@mpanel/shared';
import type { CoreConfig } from '../config.js';
import { createAuditLog } from '../audit.js';
import type { AuditLog } from '../audit.js';
import { newId } from '../store.js';
import type { AuthContext, AuthService } from './types.js';
import {
  createApiTokenStore,
  createSessionStore,
  createUserStore,
} from './store.js';
import type { SessionStore, UserRecord, UserStore } from './store.js';
import { createSessionService } from './sessions.js';
import type { SessionService } from './sessions.js';
import { createTicketStore } from './tickets.js';
import { createRateLimiter } from './rate-limit.js';
import { registerAuthRoutes } from './routes.js';
import type { BootstrapController } from './routes.js';
import { hashPassword, verifyPassword } from './scrypt.js';
import {
  isMutatingMethod,
  randomToken,
  readCookie,
  safeEqualString,
  sha256Hex,
} from './types.js';

const STATIC_TOKEN_USER: AuthUser = {
  id: 'system',
  username: 'system',
  displayName: '静态 Core Token',
  role: 'admin',
};

const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

function toAuthUser(record: UserRecord): AuthUser {
  return {
    id: record.id,
    username: record.username,
    displayName: record.displayName,
    role: record.role,
  };
}

async function readFileIfExists(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function removeIfExists(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * 会话/API token 的 HMAC 密钥：优先 MPANEL_SESSION_SECRET；否则读取或
 * 原子创建 $HOME/session.secret（0600）。创建使用 wx，避免多进程竞态。
 */
async function ensureSessionSecret(config: CoreConfig, logger: FastifyBaseLogger): Promise<string> {
  if (config.sessionSecret !== '') return config.sessionSecret;
  const file = join(config.home, 'session.secret');
  const existing = (await readFileIfExists(file))?.trim();
  if (existing !== undefined && existing.length >= 16) {
    await chmod(file, 0o600).catch(() => undefined);
    return existing;
  }
  const generated = randomToken(32);
  try {
    await writeFile(file, `${generated}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    logger.warn({ file }, '已生成 MPANEL_SESSION_SECRET 并写入 0600 文件，请备份');
    return generated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const raced = (await readFileIfExists(file))?.trim();
    if (raced === undefined || raced.length < 16) {
      throw new Error(`会话密钥文件不可用: ${file}`);
    }
    return raced;
  }
}

interface MutableBootstrap extends BootstrapController {
  readonly active: boolean;
  verify(token: string): boolean;
  consume(): Promise<void>;
}

/**
 * 首启动引导：
 * - users.json 为空且未配置 MPANEL_ADMIN_USER/PASSWORD：读取或生成一次性
 *   bootstrap token，写入 0600 文件并打印到控制台；
 * - 已配置管理员种子或已有用户：删除遗留 bootstrap 文件，setup 永久 403。
 */
async function prepareBootstrap(
  config: CoreConfig,
  users: UserStore,
  logger: FastifyBaseLogger,
  stateDir: string,
): Promise<MutableBootstrap> {
  const file = join(stateDir, 'bootstrap-token');
  const existingUsers = await users.list();

  if (existingUsers.length > 0) {
    if (config.adminUser !== undefined) {
      logger.warn(
        { username: config.adminUser },
        'users.json 已存在，忽略 MPANEL_ADMIN_USER/MPANEL_ADMIN_PASSWORD 种子配置',
      );
    }
    await removeIfExists(file).catch(() => undefined);
    return inactiveBootstrap();
  }

  if (config.adminUser !== undefined && config.adminPassword !== undefined) {
    const now = new Date().toISOString();
    const record: UserRecord = {
      id: newId('usr'),
      username: config.adminUser,
      displayName: null,
      role: 'admin',
      password: await hashPassword(config.adminPassword),
      createdAt: now,
      updatedAt: now,
    };
    await users.create(record);
    await removeIfExists(file).catch(() => undefined);
    logger.warn(
      { username: record.username },
      '已根据 MPANEL_ADMIN_USER/MPANEL_ADMIN_PASSWORD 创建首个管理员；后续启动将忽略该配置',
    );
    return inactiveBootstrap();
  }

  let token = (await readFileIfExists(file))?.trim();
  if (token === undefined || token.length < 32) {
    token = randomToken(32);
    try {
      await writeFile(file, `${token}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const raced = (await readFileIfExists(file))?.trim();
      if (raced === undefined || raced.length < 32) {
        throw new Error(`Bootstrap token 文件不可用: ${file}`);
      }
      token = raced;
    }
  }
  await chmod(file, 0o600).catch(() => undefined);

  let active = true;
  const tokenHash = sha256Hex(token);
  logger.warn({ file }, 'MPanel 尚未设置管理员密码，已生成一次性 bootstrap token');
  process.stderr.write(
    [
      '',
      '============================================================',
      ' MPanel 首次启动：请使用以下一次性 bootstrap token 完成初始化',
      `   POST /api/v1/auth/setup  { "token": "...", "username": "...", "password": "..." }`,
      `   Token: ${token}`,
      `   文件: ${file} (0600)`,
      ' 初始化成功后 token 立即失效；也可以通过 MPANEL_ADMIN_USER/',
      ' MPANEL_ADMIN_PASSWORD 或 `mpanel-core user add` 管理账号。',
      '============================================================',
      '',
    ].join('\n'),
  );

  return {
    get active() {
      return active;
    },
    verify(value) {
      if (!active) return false;
      return safeEqualString(sha256Hex(value), tokenHash);
    },
    async consume() {
      active = false;
      await removeIfExists(file).catch(() => undefined);
    },
  };
}

function inactiveBootstrap(): MutableBootstrap {
  return {
    active: false,
    verify() {
      return false;
    },
    async consume() {
      // 无引导状态。
    },
  };
}

function originMatches(origin: string, req: FastifyRequest, config: CoreConfig): boolean {
  if (config.corsOrigins.includes(origin)) return true;
  if (config.publicUrl !== undefined) {
    try {
      if (new URL(config.publicUrl).origin === origin) return true;
    } catch {
      // publicUrl 已在配置加载时校验；忽略。
    }
  }
  const host = req.headers.host;
  if (typeof host === 'string' && host.length > 0) {
    if (`${req.protocol}://${host}` === origin) return true;
  }
  return false;
}

/**
 * Cookie 认证的写请求 CSRF 防护：SameSite=Lax 之外，要求同源 Origin
 * 或显式 X-MPanel-Request 头（跨站表单无法设置自定义头）。
 * 非浏览器客户端通常不发送 Origin，此时放行（Bearer 请求不受影响）。
 */
function enforceCsrf(req: FastifyRequest, config: CoreConfig): void {
  if (!isMutatingMethod(req.method)) return;
  const marker = req.headers['x-mpanel-request'];
  if (typeof marker === 'string' && marker !== '') return;
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === '') return;
  if (originMatches(origin, req, config)) return;
  throw new PanelError('FORBIDDEN', '跨站请求被拒绝', {
    reason: 'csrf_origin_mismatch',
    hint: '同源前端可省略；跨域部署请配置 MPANEL_CORS_ORIGINS 或发送 X-MPanel-Request: 1。',
  });
}

export async function createAuthService(
  config: CoreConfig,
  logger: FastifyBaseLogger,
  sharedAudit?: AuditLog,
): Promise<AuthService> {
  await mkdir(config.home, { recursive: true, mode: 0o700 });
  const stateDir = join(config.home, 'state');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });

  config.sessionSecret = await ensureSessionSecret(config, logger);

  const users = createUserStore(join(stateDir, 'users.json'));
  const sessionStore: SessionStore = createSessionStore(join(stateDir, 'sessions.json'));
  const sessions: SessionService = createSessionService(config, sessionStore, {
    findUser: (id) => users.get(id),
  });
  const tickets = createTicketStore();
  const tokens = createApiTokenStore(join(stateDir, 'api-tokens.json'), config.sessionSecret);
  const loginLimiter = createRateLimiter({ windowSec: 60, max: 5 });
  const audit = sharedAudit ?? createAuditLog(join(config.home, 'audit.jsonl'));

  const bootstrap = await prepareBootstrap(config, users, logger, stateDir);

  const sweepTimer = setInterval(() => {
    sessionStore.sweep();
    tickets.sweep();
  }, 60_000);
  sweepTimer.unref();

  async function authenticate(req: FastifyRequest): Promise<AuthContext> {
    const header = req.headers.authorization;
    if (typeof header === 'string' && header.trim() !== '') {
      const match = /^Bearer\s+(.+)$/i.exec(header.trim());
      if (match === null) {
        throw new PanelError('UNAUTHORIZED', 'Authorization 头格式无效', {
          reason: 'invalid_authorization_header',
        });
      }
      const token = (match[1] ?? '').trim();
      if (config.coreToken !== undefined && safeEqualString(token, config.coreToken)) {
        return { kind: 'token', user: STATIC_TOKEN_USER, scope: 'write' };
      }
      const found = await tokens.findByToken(token);
      if (found !== null) {
        const record = await users.get(found.userId);
        if (record === undefined) {
          throw new PanelError('UNAUTHORIZED', 'API token 所属用户已被删除', {
            reason: 'token_user_missing',
          });
        }
        return {
          kind: 'token',
          user: toAuthUser(record),
          scope: found.scope,
          tokenId: found.id,
        };
      }
      throw new PanelError('UNAUTHORIZED', '令牌无效', { reason: 'invalid_token' });
    }

    const cookieToken = readCookie(req, config.cookieName);
    if (cookieToken === undefined || cookieToken === '') {
      throw new PanelError('UNAUTHORIZED', '需要登录', { reason: 'missing_credentials' });
    }
    const context = await sessions.resolve(cookieToken);
    if (context === null) {
      throw new PanelError('UNAUTHORIZED', '会话已过期，请重新登录', { reason: 'session_invalid' });
    }
    enforceCsrf(req, config);
    return context;
  }

  logger.info(
    {
      home: config.home,
      cookieName: config.cookieName,
      sessionTtlSec: config.sessionTtlSec,
      tokenTtlSec: config.tokenTtlSec,
      cookieSecure: config.cookieSecure,
      corsOrigins: config.corsOrigins,
    },
    '认证服务已初始化',
  );

  return {
    authenticate,

    async authenticateOrNull(req) {
      try {
        return await authenticate(req);
      } catch {
        return null;
      }
    },

    issueWsTicket(auth, path, machineId) {
      return tickets.issue({
        auth,
        path,
        ...(machineId === undefined ? {} : { machineId }),
      });
    },

    consumeWsTicket(ticket, path) {
      return tickets.consume(ticket, path);
    },

    async registerRoutes(app, machines) {
      await registerAuthRoutes(app, {
        config,
        sessions,
        users,
        tickets,
        audit,
        loginLimiter,
        tokens,
        bootstrap,
        machines,
      });
    },

    async close() {
      clearInterval(sweepTimer);
      tickets.sweep();
      await audit.flush?.().catch(() => undefined);
    },
  };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

type Role = 'admin' | 'operator';

interface ParsedUserArgs {
  command: string;
  username?: string;
  password?: string;
  passwordStdin: boolean;
  role?: Role;
}

function parseUserArgs(argv: readonly string[]): ParsedUserArgs {
  const parsed: ParsedUserArgs = { command: '', passwordStdin: false };
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--password-stdin') {
      parsed.passwordStdin = true;
    } else if (arg === '--password') {
      parsed.password = argv[index + 1];
      index += 1;
    } else if (arg.startsWith('--password=')) {
      parsed.password = arg.slice('--password='.length);
    } else if (arg === '--role') {
      const value = argv[index + 1];
      if (value === 'admin' || value === 'operator') parsed.role = value;
      index += 1;
    } else if (arg.startsWith('--role=')) {
      const value = arg.slice('--role='.length);
      if (value === 'admin' || value === 'operator') parsed.role = value;
    } else {
      positional.push(arg);
    }
  }
  parsed.command = positional[0] ?? '';
  parsed.username = positional[1];
  return parsed;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function resolvePassword(parsed: ParsedUserArgs): Promise<string | undefined> {
  if (parsed.password !== undefined) return parsed.password;
  if (parsed.passwordStdin) {
    const value = await readStdin();
    return value === '' ? undefined : value;
  }
  return undefined;
}

function validatePassword(password: string | undefined): password is string {
  return password !== undefined && password.length >= 10 && password.length <= 1024;
}

function validateUsername(username: string | undefined): username is string {
  return (
    username !== undefined &&
    username.length >= 1 &&
    username.length <= 64 &&
    !CONTROL_CHAR_PATTERN.test(username)
  );
}

function userHelp(): string {
  return [
    '用法: mpanel-core user <add|passwd|list|delete> [username] [选项]',
    '',
    '  add <username>     --password-stdin | --password <pw> [--role admin|operator]',
    '  passwd <username>  --password-stdin | --password <pw>',
    '  list',
    '  delete <username>',
    '',
    '密码至少 10 个字符。--password-stdin 从标准输入读取，适合脚本。',
  ].join('\n');
}

/** `user add|passwd|list|delete`; returns the process exit code. */
export async function runUserCli(argv: readonly string[], config: CoreConfig): Promise<number> {
  const parsed = parseUserArgs(argv);
  if (parsed.command === '' || parsed.command === 'help' || parsed.command === '--help') {
    process.stdout.write(`${userHelp()}\n`);
    return parsed.command === '' ? 1 : 0;
  }

  const stateDir = join(config.home, 'state');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const users = createUserStore(join(stateDir, 'users.json'));

  try {
    if (parsed.command === 'list') {
      const items = await users.list();
      if (items.length === 0) {
        process.stdout.write('（无用户）\n');
        return 0;
      }
      process.stdout.write('用户名\t角色\tID\t创建时间\n');
      for (const item of items) {
        process.stdout.write(`${item.username}\t${item.role}\t${item.id}\t${item.createdAt}\n`);
      }
      return 0;
    }

    if (parsed.command === 'add') {
      if (!validateUsername(parsed.username)) {
        process.stderr.write('错误: 缺少用户名，或用户名超过 64 字符 / 含控制字符\n');
        return 1;
      }
      const existing = await users.findByUsername(parsed.username);
      if (existing !== undefined) {
        process.stderr.write(`错误: 用户已存在: ${parsed.username}\n`);
        return 1;
      }
      const password = await resolvePassword(parsed);
      if (!validatePassword(password)) {
        process.stderr.write('错误: 请通过 --password-stdin 或 --password 提供至少 10 字符的密码\n');
        return 1;
      }
      const now = new Date().toISOString();
      const record: UserRecord = {
        id: newId('usr'),
        username: parsed.username,
        displayName: null,
        role: parsed.role ?? 'admin',
        password: await hashPassword(password),
        createdAt: now,
        updatedAt: now,
      };
      await users.create(record);
      process.stdout.write(`已创建用户 ${record.username} (${record.role}) ${record.id}\n`);
      return 0;
    }

    if (parsed.command === 'passwd') {
      if (!validateUsername(parsed.username)) {
        process.stderr.write('错误: 缺少用户名\n');
        return 1;
      }
      const record = await users.findByUsername(parsed.username);
      if (record === undefined) {
        process.stderr.write(`错误: 用户不存在: ${parsed.username}\n`);
        return 1;
      }
      const password = await resolvePassword(parsed);
      if (!validatePassword(password)) {
        process.stderr.write('错误: 请通过 --password-stdin 或 --password 提供至少 10 字符的新密码\n');
        return 1;
      }
      await users.update(record.id, { password: await hashPassword(password) });
      // 跨进程吊销该用户全部会话；core 每次解析会话都以磁盘为准。
      const sessionStore = createSessionStore(join(stateDir, 'sessions.json'));
      await sessionStore.deleteForUser(record.id);
      process.stdout.write(`已更新 ${record.username} 的密码，并吊销其全部会话\n`);
      return 0;
    }

    if (parsed.command === 'delete') {
      if (!validateUsername(parsed.username)) {
        process.stderr.write('错误: 缺少用户名\n');
        return 1;
      }
      const record = await users.findByUsername(parsed.username);
      if (record === undefined) {
        process.stderr.write(`错误: 用户不存在: ${parsed.username}\n`);
        return 1;
      }
      const items = await users.list();
      const admins = items.filter((item) => item.role === 'admin');
      if (record.role === 'admin' && admins.length <= 1) {
        process.stderr.write('错误: 不能删除最后一个管理员\n');
        return 1;
      }
      await users.remove(record.id);
      const sessionStore = createSessionStore(join(stateDir, 'sessions.json'));
      await sessionStore.deleteForUser(record.id);
      process.stdout.write(`已删除用户 ${record.username}\n`);
      return 0;
    }

    process.stderr.write(`未知 user 子命令: ${parsed.command}\n${userHelp()}\n`);
    return 1;
  } catch (error) {
    process.stderr.write(`错误: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/** 供测试/诊断：验证密码与存储记录。 */
export async function checkUserPassword(
  config: CoreConfig,
  username: string,
  password: string,
): Promise<boolean> {
  const users = createUserStore(join(config.home, 'state', 'users.json'));
  const record = await users.findByUsername(username);
  if (record === undefined) return false;
  return verifyPassword(password, record.password);
}
