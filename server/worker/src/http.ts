import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import {
  ERROR_HTTP_STATUS,
  PanelError,
  errorEnvelope,
  isPanelError,
  systemInfoSchema,
  WS_MAX_MESSAGE_BYTES,
} from '@mpanel/shared';
import type { ApiErrorBody, Capabilities, ErrorCode, WsBridge } from '@mpanel/shared';
import type { WorkerConfig } from './config.js';
import type { WorkerLogger } from './logger.js';
import { redactText } from './logger.js';
import { TicketStore, createWorkerAuth } from './auth.js';
import type { WorkerAuth } from './auth.js';
import { createCapabilityService } from './capabilities.js';
import type { CapabilityService } from './capabilities.js';
import { createCommandRunner } from './exec.js';
import { createPathSandbox } from './paths.js';
import type { PathSandbox } from './paths.js';
import { createStoreFactory } from './store.js';
import type { StoreFactory } from './store.js';
import { createModuleRegistry, describeWorker, moduleCatalog, workerVersion } from './registry.js';
import type { WorkerModule } from './registry.js';
import { createWsBridge, registerWsGateway } from './ws.js';
import { createWorkerModules } from './modules/index.js';
import { createSystemModule } from './modules/system/index.js';
import { isTruthyQuery } from './util.js';

/**
 * 构建唯一的 Fastify 应用：CORS、multipart、WS、统一信封/错误映射、
 * 仅 /api/v1 的鉴权作用域（精确放行 handoff redeem）、模块与 /ws/* 网关。
 */

export interface WorkerApp {
  app: FastifyInstance;
  wsBridge: WsBridge;
  auth: WorkerAuth;
  capabilities: CapabilityService;
  modules: WorkerModule[];
  close(): Promise<void>;
  /** 暴露 WS 路由清单，便于诊断与三种传输共享。 */
  wsRoutes(): string[];
}

const JSON_BODY_LIMIT = 8 * 1024 * 1024;
const API_PREFIX = '/api/v1';
const HANDOFF_REDEEM_PATH = '/api/v1/databases/handoff/redeem';
const REQUEST_TIMEOUT_MS = 620_000;

interface AppOptions {
  /** 测试/诊断可注入模块列表；默认使用 createWorkerModules()。 */
  modules?: WorkerModule[];
}

function safePathForLog(rawUrl: string | undefined): string {
  if (rawUrl === undefined) return '/';
  const withoutHash = rawUrl.split('#', 1)[0] ?? '';
  const safe = redactText(withoutHash);
  return safe.length > 512 ? `${safe.slice(0, 512)}…` : safe;
}

function pathnameOnly(rawUrl: string | undefined): string {
  if (rawUrl === undefined) return '/';
  const withoutHash = rawUrl.split('#', 1)[0] ?? '';
  const question = withoutHash.indexOf('?');
  return question >= 0 ? withoutHash.slice(0, question) : withoutHash;
}

interface ZodLikeIssue {
  path?: ReadonlyArray<string | number | symbol>;
  code?: string;
  message?: string;
}

function asZodError(value: unknown): { issues: ZodLikeIssue[] } | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as { name?: unknown; issues?: unknown };
  if (record.name !== 'ZodError' || !Array.isArray(record.issues)) return null;
  return { issues: record.issues as ZodLikeIssue[] };
}

interface FastifyValidationItem {
  instancePath?: string;
  dataPath?: string;
  message?: string;
  keyword?: string;
  params?: Record<string, unknown>;
}

function asFastifyValidation(value: unknown): FastifyValidationItem[] | null {
  if (typeof value !== 'object' || value === null) return null;
  const validation = (value as { validation?: unknown }).validation;
  if (!Array.isArray(validation) || validation.length === 0) return null;
  return validation as FastifyValidationItem[];
}

function validationDetails(items: FastifyValidationItem[]): unknown {
  return {
    issues: items.map((item) => {
      const raw = item.instancePath ?? item.dataPath ?? '';
      const normalized = raw.replace(/^\//, '').replace(/\//g, '.');
      return {
        path: normalized.length > 0 ? normalized : 'body',
        code: item.keyword ?? 'validation',
        message: item.message ?? '参数不合法',
      };
    }),
  };
}

function zodDetails(issues: ZodLikeIssue[]): unknown {
  return {
    issues: issues.map((issue) => ({
      path: (issue.path ?? []).map(String).join('.'),
      code: issue.code ?? 'custom',
      message: issue.message ?? '参数不合法',
    })),
  };
}

function statusToCode(status: number): ErrorCode {
  if (status === 400 || status === 413 || status === 415 || status === 422) return 'BAD_REQUEST';
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 502) return 'UPSTREAM_ERROR';
  if (status === 503) return 'UNAVAILABLE';
  return 'INTERNAL';
}

function codeMessage(code: ErrorCode): string {
  switch (code) {
    case 'BAD_REQUEST':
      return '请求参数不合法';
    case 'UNAUTHORIZED':
      return '未认证或凭据无效';
    case 'FORBIDDEN':
      return '没有权限执行该操作';
    case 'NOT_FOUND':
      return '资源不存在';
    case 'CONFLICT':
      return '资源状态冲突';
    case 'UNAVAILABLE':
      return '服务暂时不可用';
    case 'UPSTREAM_ERROR':
      return '上游服务返回错误';
    default:
      return '服务器内部错误';
  }
}

function frameworkErrorDetails(error: unknown, config: WorkerConfig): { code: ErrorCode; message: string; details?: unknown } | null {
  const record = typeof error === 'object' && error !== null ? (error as {
    code?: unknown;
    statusCode?: unknown;
    message?: unknown;
  }) : {};
  const code = typeof record.code === 'string' ? record.code : '';
  switch (code) {
    case 'FST_ERR_CTP_BODY_TOO_LARGE':
    case 'FST_ERR_CTP_INVALID_CONTENT_LENGTH':
      return {
        code: 'BAD_REQUEST',
        message: '请求体超过限制',
        details: {
          limitBytes: JSON_BODY_LIMIT,
          hint: '压缩请求体；文件上传请使用 multipart，并遵守 MPANEL_MAX_UPLOAD_BYTES 限制。',
        },
      };
    case 'FST_REQ_FILE_TOO_LARGE':
      return {
        code: 'BAD_REQUEST',
        message: '上传文件超过大小限制',
        details: {
          limitBytes: config.files.maxUploadBytes,
          hint: '压缩或拆分文件后重试，或调大 MPANEL_MAX_UPLOAD_BYTES。',
        },
      };
    case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
      return {
        code: 'BAD_REQUEST',
        message: '不支持的 Content-Type',
        details: {
          hint: 'JSON 接口使用 application/json；文件上传使用 multipart/form-data。',
        },
      };
    case 'FST_ERR_CTP_INVALID_JSON_BODY':
    case 'FST_ERR_CTP_EMPTY_JSON_BODY':
    case 'FST_ERR_CTP_EMPTY_TYPE':
      return {
        code: 'BAD_REQUEST',
        message: 'JSON 请求体解析失败',
        details: { hint: '确认 Content-Type 为 application/json 且 body 是合法 JSON。' },
      };
    case 'FST_ERR_VALIDATION':
      return { code: 'BAD_REQUEST', message: '请求参数校验失败' };
    default:
      break;
  }
  const status = typeof record.statusCode === 'number' ? record.statusCode : undefined;
  if (status !== undefined && status >= 400) {
    const mapped = statusToCode(status);
    return { code: mapped, message: codeMessage(mapped) };
  }
  return null;
}

async function ensureDirectories(config: WorkerConfig): Promise<void> {
  const directories = [
    config.home,
    path.join(config.home, 'state'),
    path.join(config.home, 'logs'),
    path.join(config.home, 'stacks'),
    path.join(config.home, 'sites'),
    path.join(config.home, 'backups'),
    config.caddy.configDir,
    config.caddy.stagingDir,
    config.caddy.backupDir,
    config.caddy.dataDir,
    config.files.trashDir,
    config.databases.backupDir,
  ];
  for (const directory of directories) {
    await fs.mkdir(directory, { recursive: true }).catch(() => undefined);
  }
}

function isHandoffRedeem(request: FastifyRequest): boolean {
  if (request.method !== 'POST') return false;
  return pathnameOnly(request.raw.url ?? request.url) === HANDOFF_REDEEM_PATH;
}

interface SystemInfoBuildInput {
  config: WorkerConfig;
  capabilities: Capabilities;
  modules: readonly WorkerModule[];
  startedAt: string;
}

function buildSystemInfo(input: SystemInfoBuildInput): Record<string, unknown> {
  const { config, capabilities, modules } = input;
  const started = Date.parse(input.startedAt);
  const uptimeSec = Number.isFinite(started)
    ? Math.max(0, Math.round((Date.now() - started) / 100) / 10)
    : Math.max(0, Math.round(process.uptime() * 10) / 10);
  const info: Record<string, unknown> = {
    role: 'worker',
    name: 'mpanel-worker',
    version: workerVersion(),
    apiVersion: 1,
    protocolVersion: 1,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    startedAt: input.startedAt,
    uptimeSec,
    capabilities,
    worker: describeWorker(capabilities),
    features: {
      dbxHandoff: true,
      websocket: true,
      pty: capabilities.pty.available,
    },
    paths: {
      home: config.home,
      caddyConfig: path.join(config.caddy.configDir, 'Caddyfile'),
      caddyData: config.caddy.dataDir,
      filesRoots: config.files.roots.map((root) => root.path),
      backups: path.join(config.home, 'backups'),
      stacks: path.join(config.home, 'stacks'),
    },
    // 契约允许加法字段：模块目录便于前端/诊断展示注册结果。
    modules: moduleCatalog(modules),
  };
  const validated = systemInfoSchema.safeParse(info);
  if (!validated.success) {
    // 不影响响应：仅记录本端 schema 漂移，便于集成时发现。
    void validated.error.issues.length;
  }
  return info;
}

export async function createWorkerApp(
  config: WorkerConfig,
  logger: WorkerLogger,
  options: AppOptions = {},
): Promise<WorkerApp> {
  await ensureDirectories(config);

  const app = Fastify({
    logger: false,
    bodyLimit: JSON_BODY_LIMIT,
    trustProxy: false,
    return503OnClosing: false,
    requestTimeout: REQUEST_TIMEOUT_MS,
    genReqId: () => randomBytes(8).toString('hex'),
  });

  // `modules/index.ts` 是冻结的注册顺序；system 遥测作为核心附加模块追加，
  // 避免修改既有模块清单（docs/api-contract.md §5.5）。
  const modules = options.modules ?? [...createWorkerModules(), createSystemModule()];
  const runner = createCommandRunner(logger.child({ component: 'exec' }), {
    defaultTimeoutMs: 120_000,
    maxBufferBytes: 8 * 1024 * 1024,
  });
  const store = createStoreFactory(config.home);
  const paths = await createPathSandbox(config, logger.child({ component: 'paths' }));
  const capabilities = createCapabilityService(config, runner, logger.child({ component: 'capabilities' }));
  const tickets = new TicketStore();
  const auth = createWorkerAuth(config, tickets);
  const wsBridge = createWsBridge(logger.child({ component: 'ws-bridge' }));
  const registry = createModuleRegistry(modules);
  const startedAt = new Date().toISOString();

  await app.register(cors, {
    origin:
      config.corsOrigins.length === 0
        ? false
        : config.corsOrigins.includes('*')
          ? true
          : config.corsOrigins,
    credentials: false,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'authorization',
      'content-type',
      'x-mpanel-request',
      'x-mpanel-token',
      'x-mpanel-request-id',
      'range',
      'if-none-match',
      'if-modified-since',
    ],
    exposedHeaders: [
      'x-mpanel-request-id',
      'x-mpanel-api-version',
      'content-disposition',
      'content-length',
      'x-mpanel-machine',
    ],
    maxAge: 600,
    strictPreflight: false,
  });

  await app.register(multipart, {
    limits: {
      fileSize: config.files.maxUploadBytes,
      files: 10,
      fields: 50,
      parts: 100,
      headerPairs: 2000,
    },
    throwFileSizeLimit: true,
    attachFieldsToBody: false,
  });

  await app.register(websocket, {
    options: {
      maxPayload: WS_MAX_MESSAGE_BYTES,
      perMessageDeflate: false,
      clientTracking: true,
    },
    errorHandler: (_error, socket) => {
      try {
        socket.close(1011, 'internal error');
      } catch {
        socket.terminate();
      }
    },
  });

  app.decorate('mpanel', {
    config,
    capabilities,
    auth,
    wsBridge,
    modules,
    startedAt,
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('X-MPanel-Request-Id', String(request.id));
    const pathname = pathnameOnly(request.raw.url ?? request.url);
    const isApiPath = pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`);
    if (!isApiPath) return;
    if (request.method === 'OPTIONS') return;
    // 唯一无认证例外：handoff redeem 的 body ticket 本身就是凭据。
    if (isHandoffRedeem(request)) return;
    await auth.authenticate(request);
  });

  app.addHook('onSend', async (request, reply, payload) => {
    if (reply.getHeader('X-MPanel-Request-Id') === undefined) {
      reply.header('X-MPanel-Request-Id', String(request.id));
    }
    reply.header('X-MPanel-Api-Version', '1');
    if (reply.getHeader('Cache-Control') === undefined) {
      reply.header('Cache-Control', 'no-store');
    }
    return payload;
  });

  app.addHook('onResponse', async (request, reply) => {
    const status = reply.statusCode;
    const details = {
      requestId: String(request.id),
      method: request.method,
      path: safePathForLog(request.raw.url ?? request.url),
      status,
      durationMs: Math.round(reply.elapsedTime),
      ip: request.ip,
    };
    if (status >= 500 && status !== 503) logger.error('HTTP 请求完成', details);
    else if (status >= 400) logger.warn('HTTP 请求完成', details);
    else logger.debug('HTTP 请求完成', details);
  });

  app.setNotFoundHandler(async (request, reply) => {
    reply
      .code(404)
      .type('application/json; charset=utf-8')
      .send(
        errorEnvelope('NOT_FOUND', '接口不存在', {
          resource: 'route',
          path: pathnameOnly(request.raw.url ?? request.url),
        }),
      );
  });

  app.setErrorHandler(async (error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    if (reply.raw.headersSent) {
      logger.error('响应已开始后发生错误，终止连接', {
        requestId: String(request.id),
        path: safePathForLog(request.raw.url ?? request.url),
        error,
      });
      reply.raw.destroy();
      return;
    }
    let body: ApiErrorBody;
    if (isPanelError(error)) {
      body = {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      };
      if (error.code === 'INTERNAL') {
        logger.error('请求处理失败', {
          requestId: String(request.id),
          code: error.code,
          path: safePathForLog(request.raw.url ?? request.url),
          error,
        });
      } else {
        logger.warn('请求被拒绝', {
          requestId: String(request.id),
          code: error.code,
          path: safePathForLog(request.raw.url ?? request.url),
        });
      }
      reply.code(ERROR_HTTP_STATUS[error.code]);
    } else {
      const zod = asZodError(error);
      const fastifyValidation = asFastifyValidation(error);
      const framework = frameworkErrorDetails(error, config);
      if (zod !== null) {
        body = {
          code: 'BAD_REQUEST',
          message: '请求参数校验失败',
          details: zodDetails(zod.issues),
        };
        logger.warn('请求参数校验失败', {
          requestId: String(request.id),
          path: safePathForLog(request.raw.url ?? request.url),
        });
        reply.code(400);
      } else if (fastifyValidation !== null) {
        body = {
          code: 'BAD_REQUEST',
          message: '请求参数校验失败',
          details: validationDetails(fastifyValidation),
        };
        logger.warn('请求参数校验失败', {
          requestId: String(request.id),
          path: safePathForLog(request.raw.url ?? request.url),
        });
        reply.code(400);
      } else if (framework !== null) {
        body = {
          code: framework.code,
          message: framework.message,
          ...(framework.details === undefined ? {} : { details: framework.details }),
        };
        logger.warn('请求被框架层拒绝', {
          requestId: String(request.id),
          code: framework.code,
          path: safePathForLog(request.raw.url ?? request.url),
        });
        reply.code(ERROR_HTTP_STATUS[framework.code]);
      } else {
        body = {
          code: 'INTERNAL',
          message: '服务器内部错误',
          details: { requestId: String(request.id) },
        };
        logger.error('未处理的内部异常', {
          requestId: String(request.id),
          path: safePathForLog(request.raw.url ?? request.url),
          error,
        });
        reply.code(500);
      }
    }
    reply
      .type('application/json; charset=utf-8')
      .send(errorEnvelope(body.code, body.message, body.details));
  });

  app.get('/healthz', async () => ({
    ok: true,
    status: 'ok',
    version: workerVersion(),
    role: 'worker',
  }));

  await app.register(
    async (api: FastifyInstance) => {
      await auth.registerRoutes(api);

      api.get('/system/info', async (request) => {
        const query = request.query as { refresh?: unknown } | undefined;
        const refresh = isTruthyQuery(query?.refresh);
        const caps = await capabilities.get(refresh);
        return {
          ok: true as const,
          data: buildSystemInfo({ config, capabilities: caps, modules, startedAt }),
        };
      });

      const context: Parameters<typeof registry.registerAll>[0] = {
        app: api,
        capabilities,
        homeDir: config.home,
        logger: logger.child({ component: 'modules' }),
        config,
        store,
        paths,
        runner,
        wsBridge,
        auth,
      };
      await registry.registerAll(context);
    },
    { prefix: API_PREFIX },
  );

  await registerWsGateway(app, wsBridge, auth, logger.child({ component: 'ws-gateway' }));

  // 启动即预热能力探测，hello 帧与首个 system/info 不必等 5s。
  void capabilities.get().catch((error: unknown) => {
    logger.debug('启动时能力探测失败（将在请求时重试）', {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      await app.close();
    } catch (error) {
      logger.warn('关闭 Fastify 应用时出错', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    logger.close?.();
  };

  return {
    app,
    wsBridge,
    auth,
    capabilities,
    modules,
    close,
    wsRoutes: () => wsBridge.listRoutes(),
  };
}

/** 供测试/诊断的类型辅助。 */
export type { PathSandbox, StoreFactory };
