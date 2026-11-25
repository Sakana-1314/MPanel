import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  PanelError,
  changePasswordRequestSchema,
  loginRequestSchema,
  okEnvelope,
  wsTicketRequestSchema,
} from '@mpanel/shared';
import type { AuthUser } from '@mpanel/shared';
import type { CoreConfig } from '../config.js';
import type { AuditEvent, AuditLog } from '../audit.js';
import type { MachineService } from '../machines/service.js';
import { newId } from '../store.js';
import { hashPassword, verifyAgainstDummy, verifyPassword } from './scrypt.js';
import type { SessionService } from './sessions.js';
import type { UserRecord, UserStore } from './store.js';
import type { ApiTokenStore } from './store.js';
import type { TicketStore } from './tickets.js';
import type { RateLimiter } from './rate-limit.js';
import type { AuthContext } from './types.js';
import { asRecord, asString, clientIp, normalizeTicketPath, parseInput, readCookie } from './types.js';

/** 首启动引导状态；由 auth/index.ts 的 createAuthService 提供。 */
export interface BootstrapController {
  readonly active: boolean;
  verify(token: string): boolean;
  consume(): Promise<void>;
}

export interface AuthRouteDeps {
  config: CoreConfig;
  sessions: SessionService;
  users: UserStore;
  tickets: TicketStore;
  audit: AuditLog;
  loginLimiter: RateLimiter;
  tokens: ApiTokenStore;
  bootstrap: BootstrapController;
  /** 校验代理 WS 票中的 machineId 是否存在（缺失时跳过存在性检查）。 */
  machines?: MachineService;
}

function requireAuth(req: FastifyRequest): AuthContext {
  const auth = req.mpanelAuth;
  if (auth === undefined) {
    throw new PanelError('UNAUTHORIZED', '需要登录', { reason: 'missing_credentials' });
  }
  return auth;
}

function toAuthUser(record: UserRecord): AuthUser {
  return {
    id: record.id,
    username: record.username,
    displayName: record.displayName,
    role: record.role,
  };
}

async function audit(deps: AuthRouteDeps, event: Omit<AuditEvent, 'at'>): Promise<void> {
  try {
    await deps.audit.write({ at: new Date().toISOString(), ...event });
  } catch {
    // 审计失败不改变请求结果；createAuditLog 内部已按队列吞掉错误。
  }
}

interface SetupBody {
  token: string;
  username: string;
  password: string;
}

const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

function parseSetupBody(body: unknown): SetupBody {
  const record = asRecord(body);
  if (record === undefined) {
    throw new PanelError('BAD_REQUEST', '初始化请求必须是 JSON 对象', { issues: [] });
  }
  const token = asString(record.token)?.trim() ?? '';
  const username = asString(record.username)?.trim() ?? '';
  const password = asString(record.password) ?? '';
  const issues: Array<{ path: string; code: string; message: string }> = [];
  if (token.length < 16) issues.push({ path: 'token', code: 'too_small', message: 'Bootstrap token 无效' });
  if (username.length < 1 || username.length > 64 || CONTROL_CHAR_PATTERN.test(username)) {
    issues.push({ path: 'username', code: 'invalid_string', message: '用户名需为 1-64 个字符且不含控制字符' });
  }
  if (password.length < 10 || password.length > 1024) {
    issues.push({ path: 'password', code: 'too_small', message: '密码至少 10 个字符' });
  }
  if (issues.length > 0) {
    throw new PanelError('BAD_REQUEST', '初始化请求校验失败', { issues });
  }
  return { token, username, password };
}

interface CreateTokenBody {
  name: string;
  scope: 'read' | 'write';
  expiresAt?: string;
}

function parseCreateTokenBody(body: unknown): CreateTokenBody {
  const record = asRecord(body) ?? {};
  const issues: Array<{ path: string; code: string; message: string }> = [];
  const nameRaw = asString(record.name)?.trim();
  const name = nameRaw === undefined || nameRaw === '' ? 'API token' : nameRaw;
  if (name.length > 120 || CONTROL_CHAR_PATTERN.test(name)) {
    issues.push({ path: 'name', code: 'invalid_string', message: '名称最多 120 个字符且不含控制字符' });
  }
  const scopeRaw = asString(record.scope) ?? 'read';
  if (scopeRaw !== 'read' && scopeRaw !== 'write') {
    issues.push({ path: 'scope', code: 'invalid_enum_value', message: 'scope 必须是 read 或 write' });
  }
  const expiresAtRaw = asString(record.expiresAt);
  let expiresAt: string | undefined;
  if (expiresAtRaw !== undefined) {
    const timestamp = Date.parse(expiresAtRaw);
    if (!Number.isFinite(timestamp)) {
      issues.push({ path: 'expiresAt', code: 'invalid_date', message: 'expiresAt 必须是 ISO 8601 时间' });
    } else if (timestamp <= Date.now()) {
      issues.push({ path: 'expiresAt', code: 'custom', message: 'expiresAt 必须晚于当前时间' });
    } else {
      expiresAt = new Date(timestamp).toISOString();
    }
  }
  if (issues.length > 0) {
    throw new PanelError('BAD_REQUEST', 'API token 请求校验失败', { issues });
  }
  return {
    name,
    scope: scopeRaw as 'read' | 'write',
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

const PROXY_WS_PATH = /^\/api\/v1\/machines\/([^/]+)\/proxy\/ws\/.+/;

/** login/logout/me/ws-ticket/password/tokens/setup; login is rate limited. */
export async function registerAuthRoutes(
  app: FastifyInstance,
  deps: AuthRouteDeps,
): Promise<void> {
  const { config, sessions, users, tickets, loginLimiter, tokens, bootstrap } = deps;

  app.post('/api/v1/auth/login', async (req, reply) => {
    const ip = clientIp(req) ?? 'unknown';
    const limitKey = `login:${ip}`;
    const limited = loginLimiter.hit(limitKey);
    if (!limited.allowed) {
      await audit(deps, {
        action: 'auth.login',
        actor: 'anonymous',
        ip: clientIp(req),
        result: 'denied',
        details: { reason: 'rate_limited', retryAfterSec: limited.retryAfterSec },
      });
      throw new PanelError('UNAUTHORIZED', '登录尝试过于频繁，请稍后再试', {
        retryAfterSec: limited.retryAfterSec,
      });
    }

    const body = parseInput(loginRequestSchema, req.body, '登录请求');
    const record = await users.findByUsername(body.username);
    let valid = false;
    if (record !== undefined) {
      valid = await verifyPassword(body.password, record.password);
    } else {
      await verifyAgainstDummy(body.password);
    }

    if (record === undefined || !valid) {
      await audit(deps, {
        action: 'auth.login',
        actor: body.username,
        ip: clientIp(req),
        result: 'denied',
        details: { reason: 'invalid_credentials' },
      });
      throw new PanelError('UNAUTHORIZED', '用户名或密码错误');
    }

    loginLimiter.reset(limitKey);
    const issued = await sessions.issue(toAuthUser(record));
    reply.header('set-cookie', sessions.cookieHeader(issued.token, issued.expiresAt));
    await audit(deps, {
      action: 'auth.login',
      actor: record.username,
      ip: clientIp(req),
      result: 'ok',
      details: { authType: 'session' },
    });
    return okEnvelope({ user: toAuthUser(record), expiresAt: issued.expiresAt });
  });

  app.post('/api/v1/auth/setup', async (req, reply) => {
    const existing = await users.list();
    if (existing.length > 0 || !bootstrap.active) {
      throw new PanelError('FORBIDDEN', '系统已完成初始化', {
        required: 'admin',
        hint: '请使用已有用户名密码登录，或通过 mpanel-core user 命令管理用户。',
      });
    }

    const ip = clientIp(req) ?? 'unknown';
    const limited = loginLimiter.hit(`setup:${ip}`);
    if (!limited.allowed) {
      throw new PanelError('UNAUTHORIZED', '初始化尝试过于频繁，请稍后再试', {
        retryAfterSec: limited.retryAfterSec,
      });
    }

    const body = parseSetupBody(req.body);
    if (!bootstrap.verify(body.token)) {
      await audit(deps, {
        action: 'auth.setup',
        actor: 'anonymous',
        ip: clientIp(req),
        result: 'denied',
        details: { reason: 'invalid_bootstrap_token' },
      });
      throw new PanelError('UNAUTHORIZED', 'Bootstrap token 无效', { reason: 'invalid_bootstrap_token' });
    }

    // 二次检查，避免与并发 setup 请求竞争。
    if ((await users.list()).length > 0) {
      throw new PanelError('FORBIDDEN', '系统已完成初始化');
    }

    const now = new Date().toISOString();
    const record: UserRecord = {
      id: newId('usr'),
      username: body.username,
      displayName: null,
      role: 'admin',
      password: await hashPassword(body.password),
      createdAt: now,
      updatedAt: now,
    };
    await users.create(record);
    await bootstrap.consume();
    loginLimiter.reset(`setup:${ip}`);

    const issued = await sessions.issue(toAuthUser(record));
    reply.code(201).header('set-cookie', sessions.cookieHeader(issued.token, issued.expiresAt));
    await audit(deps, {
      action: 'auth.setup',
      actor: record.username,
      ip: clientIp(req),
      result: 'ok',
      details: { userId: record.id },
    });
    return okEnvelope({ user: toAuthUser(record), expiresAt: issued.expiresAt });
  });

  app.post('/api/v1/auth/logout', async (req, reply) => {
    const auth = requireAuth(req);
    const cookieToken = readCookie(req, config.cookieName);
    if (cookieToken !== undefined) await sessions.revoke(cookieToken);
    reply.header('set-cookie', sessions.clearCookieHeader());
    await audit(deps, {
      action: 'auth.logout',
      actor: auth.user.username,
      ip: clientIp(req),
      result: 'ok',
    });
    return okEnvelope({ ok: true });
  });

  app.get('/api/v1/auth/me', async (req) => {
    const auth = requireAuth(req);
    return okEnvelope({
      authenticated: true as const,
      role: 'core' as const,
      authType: auth.kind,
      user: auth.user,
    });
  });

  app.post('/api/v1/auth/ws-ticket', async (req) => {
    const auth = requireAuth(req);
    const body = parseInput(wsTicketRequestSchema, req.body, 'WS 票据请求');
    const path = body.path;

    if (CONTROL_CHAR_PATTERN.test(path) || path.includes('#')) {
      throw new PanelError('BAD_REQUEST', 'WS 路径包含非法字符', { issues: [] });
    }

    const proxyMatch = PROXY_WS_PATH.exec(path);
    if (path.startsWith('/ws/')) {
      if (body.machineId !== undefined) {
        throw new PanelError('BAD_REQUEST', 'core 自身 WS 路径不应携带 machineId', { issues: [] });
      }
    } else if (proxyMatch !== null) {
      const machineId = proxyMatch[1] ?? '';
      if (body.machineId === undefined) {
        throw new PanelError('BAD_REQUEST', '代理 WS 路径必须提供 machineId', { issues: [] });
      }
      let decoded = machineId;
      try {
        decoded = decodeURIComponent(machineId);
      } catch {
        throw new PanelError('BAD_REQUEST', 'WS 路径中的 machineId 编码无效', { issues: [] });
      }
      if (decoded !== body.machineId) {
        throw new PanelError('BAD_REQUEST', 'machineId 与 WS 路径不一致', { issues: [] });
      }
      if (deps.machines !== undefined) {
        // 不存在时抛出 NOT_FOUND；避免为任意 id 签发 WS 票据。
        await deps.machines.get(body.machineId);
      }
    } else {
      throw new PanelError('BAD_REQUEST', 'WS 路径必须指向 /ws/ 或代理 /proxy/ws/ 端点', {
        issues: [],
      });
    }

    const ticket = tickets.issue({ auth, path, ...(body.machineId === undefined ? {} : { machineId: body.machineId }) });
    await audit(deps, {
      action: 'auth.ws_ticket',
      actor: auth.user.username,
      ip: clientIp(req),
      result: 'ok',
      target: body.machineId,
      // 审计只记录剔除 ticket/token 后的业务路径，避免 URL 凭据落盘。
      details: { path: normalizeTicketPath(path).slice(0, 256) },
    });
    return okEnvelope(ticket);
  });

  app.post('/api/v1/auth/password', async (req) => {
    const auth = requireAuth(req);
    if (auth.kind === 'token') {
      throw new PanelError('FORBIDDEN', 'API token 不能修改密码', {
        required: 'session',
        hint: '请使用用户名密码登录后再修改密码。',
      });
    }
    const body = parseInput(changePasswordRequestSchema, req.body, '修改密码请求');
    const record = await users.get(auth.user.id);
    if (record === undefined) {
      throw new PanelError('UNAUTHORIZED', '用户不存在或已被删除');
    }
    if (!(await verifyPassword(body.currentPassword, record.password))) {
      await audit(deps, {
        action: 'auth.password',
        actor: auth.user.username,
        ip: clientIp(req),
        result: 'denied',
        details: { reason: 'invalid_current_password' },
      });
      throw new PanelError('UNAUTHORIZED', '当前密码错误');
    }

    await users.update(record.id, { password: await hashPassword(body.newPassword) });
    const currentToken = readCookie(req, config.cookieName);
    await sessions.revokeUser(record.id, currentToken);
    await audit(deps, {
      action: 'auth.password',
      actor: auth.user.username,
      ip: clientIp(req),
      result: 'ok',
    });
    return okEnvelope({ ok: true });
  });

  app.get('/api/v1/auth/tokens', async (req) => {
    requireAuth(req);
    const items = await tokens.list();
    return okEnvelope({ available: true, items, nextCursor: null });
  });

  app.post('/api/v1/auth/tokens', async (req, reply) => {
    const auth = requireAuth(req);
    if (auth.kind === 'token' && auth.scope !== 'write') {
      throw new PanelError('FORBIDDEN', '创建 API token 需要写权限', { required: 'write' });
    }
    const body = parseCreateTokenBody(req.body);
    const created = await tokens.create({
      name: body.name,
      scope: body.scope,
      userId: auth.user.id,
      ttlSec: config.tokenTtlSec,
      ...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt }),
    });
    await audit(deps, {
      action: 'auth.token.create',
      actor: auth.user.username,
      ip: clientIp(req),
      result: 'ok',
      target: created.info.id,
      details: { name: created.info.name, scope: created.info.scope },
    });
    reply.code(201);
    return okEnvelope({ token: created.token, tokenInfo: created.info });
  });

  app.delete('/api/v1/auth/tokens/:id', async (req) => {
    const auth = requireAuth(req);
    const params = asRecord(req.params) ?? {};
    const id = asString(params.id) ?? '';
    if (id === '') {
      throw new PanelError('BAD_REQUEST', '缺少 token id', { issues: [] });
    }
    const removed = await tokens.remove(id);
    if (!removed) {
      throw new PanelError('NOT_FOUND', 'API token 不存在', { resource: 'token', id });
    }
    await audit(deps, {
      action: 'auth.token.revoke',
      actor: auth.user.username,
      ip: clientIp(req),
      result: 'ok',
      target: id,
    });
    return okEnvelope({ ok: true });
  });
}
