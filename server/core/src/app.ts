import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type {
  FastifyBaseLogger,
  FastifyError,
  FastifyInstance,
  FastifyRequest,
} from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import {
  PanelError,
  errorEnvelope,
  isPanelError,
} from '@mpanel/shared';
import type { CoreConfig } from './config.js';
import type { AuthContext, AuthService } from './auth/types.js';
import type { MachineService, MachineServiceFull } from './machines/service.js';
import type { AuditLog } from './audit.js';
import type { RateLimiter } from './auth/rate-limit.js';
import { isMutatingMethod, splitRequestUrl } from './auth/types.js';
import { CORE_VERSION } from './system.js';
import { registerSystemRoutes } from './system.js';
import { registerMachineRoutes } from './machines/routes.js';
import { registerProxyRoutes } from './proxy/index.js';
import { createEdgeService } from './edge/service.js';
import { registerEdgeRoutes } from './edge/routes.js';
import { registerStatic } from './static.js';

export interface CoreAppDeps {
  config: CoreConfig;
  auth: AuthService;
  machines: MachineService;
  audit: AuditLog;
  rateLimit: RateLimiter;
  logger?: FastifyBaseLogger;
}

const REDEEM_PATH = /^\/api\/v1\/machines\/[^/]+\/proxy\/databases\/handoff\/redeem$/;
const PROXY_PATH = /^\/api\/v1\/machines\/([^/]+)\/proxy\//;
const PROXY_WS_PATH = /^\/api\/v1\/machines\/[^/]+\/proxy\/ws\//;
const MACHINE_PATH = /^\/api\/v1\/machines(?:\/|$)/;
/** docs/api-contract.md §5.4: enrollment authenticates with the edge key, not a session. */
const EDGE_ENROLL_PATH = '/api/v1/edge/enroll';

/** 设计上留出的授权钩子；MachineService 冻结签名未包含它，存在时才调用。 */
interface MachineAuthorizer {
  authorizeMachine?: (machineId: string, auth: AuthContext) => Promise<void>;
}

/** 请求头按 RFC 9110 逗号分隔 token 匹配（Connection: keep-alive, Upgrade）。 */
function headerHasToken(value: string | string[] | undefined, token: string): boolean {
  if (Array.isArray(value)) return value.some((item) => headerHasToken(item, token));
  if (typeof value !== 'string') return false;
  return value
    .split(',')
    .some((part) => part.trim().toLowerCase() === token.toLowerCase());
}

/**
 * 只有「真正的 Node upgrade 请求 + 代理 WS 路径」才跳过 REST 鉴权。
 *
 * 普通 HTTP 请求也可以携带 `Upgrade: websocket` 头；仅凭该头跳过鉴权会造成
 * 未认证访问（历史缺陷）。`req.ws` 由 @fastify/websocket 的 onRequest 依据
 * Node 'upgrade' 事件（必须同时带 Connection: Upgrade）设置，普通 request
 * 事件下恒为 false，因此这里以它为第一判据，再校验头与路径。
 */
function isProxyWebsocketUpgrade(req: FastifyRequest): boolean {
  if (req.ws !== true) return false;
  if (!headerHasToken(req.headers.connection, 'upgrade')) return false;
  const upgrade = req.headers.upgrade;
  if (typeof upgrade !== 'string' || upgrade.toLowerCase() !== 'websocket') return false;
  return PROXY_WS_PATH.test(splitRequestUrl(req.url).path);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Builds the public routes (healthz/login/static), the protected /api/v1 group,
 * the /ws/worker preValidation (machine secret) and the proxy WS ticket scope.
 */
export async function buildCoreApp(deps: CoreAppDeps): Promise<FastifyInstance> {
  const { config } = deps;

  const app = Fastify({
    ...(deps.logger === undefined ? {} : { loggerInstance: deps.logger }),
    trustProxy: config.trustProxy,
    bodyLimit: 8 * 1024 * 1024,
    // 自定义 stderr logger 不实现 pino 的请求序列化；请求级日志由审计/错误处理覆盖。
    disableRequestLogging: true,
    genReqId: (raw) => {
      const header = raw.headers['x-mpanel-request-id'];
      const value = Array.isArray(header) ? header[0] : header;
      if (typeof value === 'string' && value.length > 0 && value.length <= 128) return value;
      return `req_${randomUUID()}`;
    },
  });

  // 不在启动时 decorateRequest：请求对象按需挂载 mpanelAuth（见 auth/types.ts）。

  /* ----------------------------- 错误信封 ----------------------------- */
  app.setErrorHandler((error: FastifyError, req, reply) => {
    if (isPanelError(error)) {
      reply.code(error.status).send(errorEnvelope(error.code, error.message, error.details));
      return;
    }

    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500;
    const code = typeof error.code === 'string' ? error.code : '';
    const validation = Array.isArray(error.validation) ? error.validation : undefined;

    if (code === 'FST_ERR_CTP_BODY_TOO_LARGE' || statusCode === 413) {
      reply.code(400).send(
        errorEnvelope('BAD_REQUEST', '请求体过大', {
          hint: 'JSON 请求体上限 8 MiB；代理上传请使用 /api/v1/machines/:id/proxy/files/upload。',
        }),
      );
      return;
    }

    if (code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || statusCode === 415) {
      reply.code(400).send(
        errorEnvelope('BAD_REQUEST', '不支持的 Content-Type', {
          hint: 'JSON 接口请使用 application/json；上传请使用 multipart/form-data。',
        }),
      );
      return;
    }

    if (validation !== undefined) {
      reply.code(400).send(
        errorEnvelope('BAD_REQUEST', '请求参数校验失败', {
          issues: validation.map((item) => ({
            path: typeof item.instancePath === 'string'
              ? item.instancePath.replace(/^\//, '').replace(/\//g, '.')
              : '',
            code: 'invalid',
            message: item.message ?? 'invalid',
          })),
        }),
      );
      return;
    }

    if (statusCode === 401) {
      reply.code(401).send(errorEnvelope('UNAUTHORIZED', '需要登录'));
      return;
    }
    if (statusCode === 403) {
      reply.code(403).send(errorEnvelope('FORBIDDEN', '没有权限执行该操作'));
      return;
    }
    if (statusCode === 404) {
      reply.code(404).send(errorEnvelope('NOT_FOUND', '资源不存在'));
      return;
    }
    if (statusCode >= 400 && statusCode < 500) {
      reply.code(400).send(errorEnvelope('BAD_REQUEST', '请求参数无效'));
      return;
    }

    req.log.error({ err: error }, '未处理的请求错误');
    reply.code(500).send(errorEnvelope('INTERNAL', '服务器内部错误', { requestId: req.id }));
  });

  /* ------------------------------ 通用头 ------------------------------ */
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-mpanel-request-id', req.id);
    reply.header('x-mpanel-api-version', '1');
    if (splitRequestUrl(req.url).path.startsWith('/api/v1')) {
      reply.header('cache-control', 'no-store');
    }
    return payload;
  });

  /* ------------------------------- CORS ------------------------------- */
  await app.register(cors, {
    delegator: async (req: FastifyRequest) => {
      const { path } = splitRequestUrl(req.url);
      const redeem = REDEEM_PATH.test(path);
      const allowed = redeem && config.dbxOrigin !== undefined
        ? [...config.corsOrigins, config.dbxOrigin]
        : config.corsOrigins;
      if (allowed.length === 0) {
        return { origin: false, credentials: false };
      }
      return {
        origin: allowed,
        // dbx handoff 使用一次性 ticket，不需要也不允许携带 cookie。
        credentials: !redeem,
        methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: [
          'authorization',
          'content-type',
          'x-mpanel-request',
          'range',
          'if-none-match',
        ],
        exposedHeaders: [
          'x-mpanel-request-id',
          'x-mpanel-api-version',
          'x-mpanel-machine',
          'content-disposition',
        ],
        maxAge: 600,
      };
    },
  });

  await app.register(websocket);

  /* --------------------------- 鉴权中间件 ---------------------------- */
  app.addHook('onRequest', async (req, reply) => {
    const { path } = splitRequestUrl(req.url);
    if (!path.startsWith('/api/v1')) return;
    // 只有真正的代理 WS upgrade 在升级阶段由一次性 ticket/Bearer 认证（proxy/ws.ts）；
    // 普通 HTTP 请求（即使伪造 Upgrade 头）仍必须走下面的 REST 鉴权。
    if (isProxyWebsocketUpgrade(req)) return;
    if (req.method === 'OPTIONS') return;
    if (req.method === 'POST' && (path === '/api/v1/auth/login' || path === '/api/v1/auth/setup')) {
      return;
    }
    // 边缘入网：凭 URL 无关的 key（body）认证，并按 IP 限流；见 EdgeService。
    if (req.method === 'POST' && path === EDGE_ENROLL_PATH) return;
    // handoff redeem 以 JSON body 中的一次性 ticket 为凭据（精确路径例外）。
    if (req.method === 'POST' && REDEEM_PATH.test(path)) return;

    const context = await deps.auth.authenticate(req);
    req.mpanelAuth = context;
    if (context.cookieHeader !== undefined) {
      // 滑动续期：把服务端新的过期时间同步回浏览器。
      reply.header('set-cookie', context.cookieHeader);
    }

    const mutating = isMutatingMethod(req.method);
    const onMachines = MACHINE_PATH.test(path);
    if (context.kind === 'token' && context.scope !== 'write' && (mutating || onMachines)) {
      throw new PanelError('FORBIDDEN', '该 API token 只有只读权限', {
        required: 'write',
        hint: '使用 scope=write 的 API token，或改用登录会话。',
      });
    }

    const proxyMatch = PROXY_PATH.exec(path);
    if (proxyMatch !== null) {
      const machineId = decodeSegment(proxyMatch[1] ?? '');
      const authorizer = (deps.machines as unknown as MachineAuthorizer).authorizeMachine;
      if (typeof authorizer === 'function') {
        await authorizer.call(deps.machines, machineId, context);
      }
    }
  });

  /* ------------------------------ 健康检查 ---------------------------- */
  app.get('/healthz', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return { ok: true, status: 'ok', version: CORE_VERSION, role: 'core' };
  });

  /* --------------------------- 反向 WS 注册通道 ----------------------- */
  app.get(
    '/ws/worker',
    {
      websocket: true,
      preValidation: async (req, reply) => {
        try {
          const machine = await deps.machines.authenticateReverseWs(req.raw);
          req.reverseWsMachine = machine;
        } catch (error) {
          const panel = isPanelError(error)
            ? error
            : new PanelError('UNAUTHORIZED', '机器认证失败', { reason: 'machine_auth_failed' });
          reply.code(panel.status).send(errorEnvelope(panel.code, panel.message, panel.details));
        }
      },
    },
    (socket, req) => {
      const machine = req.reverseWsMachine;
      if (machine === undefined) {
        socket.close(4401, 'unauthorized');
        return;
      }
      void deps.machines.handleReverseWs(machine.id, socket, req.raw).catch((error: unknown) => {
        req.log.warn({ err: error, machineId: machine.id }, 'reverse-ws 处理失败');
        socket.close(1011, 'machine handler failed');
      });
    },
  );

  /* ------------------------------ 认证路由 ---------------------------- */
  await deps.auth.registerRoutes(app, deps.machines);

  /*
   * 边缘节点：作业调度与快照刷新由 core 自己驱动（docs/api-contract.md §5.4）。
   * createMachineService 始终返回 MachineServiceFull；这里以窄端口方式使用。
   */
  const edge = createEdgeService({
    config,
    machines: deps.machines as MachineServiceFull,
    audit: deps.audit,
    logger: deps.logger ?? app.log,
  });
  app.addHook('onReady', async () => {
    edge.startDispatcher();
  });

  /* --------------------------- 受保护的 /api/v1 ---------------------- */
  await app.register(
    async (api) => {
      await registerSystemRoutes(api, { config, machines: deps.machines });
      await registerMachineRoutes(api, {
        machines: deps.machines,
        auth: deps.auth,
        config,
        audit: deps.audit,
        rateLimit: deps.rateLimit,
      });
      await registerEdgeRoutes(api, { edge });
      await registerProxyRoutes(api, {
        machines: deps.machines,
        auth: deps.auth,
        config,
        audit: deps.audit,
        rateLimit: deps.rateLimit,
      });
    },
    { prefix: '/api/v1' },
  );

  /* ------------------------------ 静态托管 ---------------------------- */
  await registerStatic(app, config);

  /* ------------------------------ 优雅退出 ---------------------------- */
  app.addHook('onClose', async () => {
    // 先停边缘调度器，避免它继续向正在关闭的机器发请求，再关闭传输。
    try {
      await edge.stopDispatcher();
    } catch (error) {
      app.log.warn({ err: error }, '关闭边缘调度器失败');
    }
    try {
      await deps.auth.close?.();
    } catch (error) {
      app.log.warn({ err: error }, '关闭认证服务失败');
    }
    try {
      await deps.machines.shutdown();
    } catch (error) {
      app.log.warn({ err: error }, '关闭机器服务失败');
    }
    try {
      await deps.audit.flush?.();
    } catch (error) {
      app.log.warn({ err: error }, '刷新审计日志失败');
    }
  });

  return app;
}
