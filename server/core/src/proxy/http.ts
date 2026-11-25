import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  errorEnvelope,
  isPanelError,
  type ApiErrorBody,
  type ErrorCode,
} from '@mpanel/shared';
import type { AuthContext } from '../auth/types.js';
import type { MachineHttpResponse } from '../machines/service.js';
import type { ProxyDeps } from './index.js';

/** 普通 API 超时；图片 pull 与文件/备份下载等允许 620 秒。 */
const DEFAULT_TIMEOUT_MS = 120_000;
const LONG_TIMEOUT_MS = 620_000;

const LONG_LIVED_PATHS: readonly RegExp[] = [
  /^\/images\/pull$/,
  /^\/files\/(?:upload|download|archive|extract)$/,
  /^\/databases\/backups\/[^/]+\/download$/,
];

/** worker 侧 handoff redeem 的 API 路径（core 代理映射后的路径）。 */
const HANDOFF_REDEEM_TARGET = '/api/v1/databases/handoff/redeem';

/**
 * core 代理也必须独立限速 handoff redeem（docs/api-contract.md §8.4）：
 * worker 以自身的 req.ip 分桶，经 core 代理时只会看到 core 的地址，因此若 core
 * 不按真实客户端 IP 限速，所有兑换客户端会共用 worker 的一个桶。这里的 key 使用
 * Fastify `req.ip`（trustProxy 已按部署配置解析 X-Forwarded-For）。
 * 返回 true 表示已被限速并已写出 401 信封。
 */
function enforceRedeemRateLimit(
  deps: ProxyDeps,
  req: FastifyRequest,
  reply: FastifyReply,
): boolean {
  const key = typeof req.ip === 'string' && req.ip.length > 0 ? req.ip : 'unknown';
  const decision = deps.rateLimit.hit(key);
  if (decision.allowed) return false;
  const retryAfterSec = decision.retryAfterSec ?? 60;
  reply.header('retry-after', String(retryAfterSec));
  reply.header('cache-control', 'no-store');
  reply.header('pragma', 'no-cache');
  sendEnvelope(reply, 401, 'UNAUTHORIZED', 'handoff redeem 请求过于频繁', {
    retryAfterSec,
  });
  return true;
}

/**
 * 客户端到 core 的路径 → worker 收到路径（保留原始 query 字符串）。
 * 兼容两种写法：`/proxy/system/info`（契约 §2.5）与
 * `/proxy/api/v1/system/info`（脚本/旧客户端直接复用 worker 路径）。
 */
export function mapProxyHttpRequest(rawUrl: string): string {
  const match = /^\/api\/v1\/machines\/[^/?#]+\/proxy(?=\/|\?|#|$)/.exec(rawUrl);
  if (match === null) return rawUrl;
  const suffix = rawUrl.slice(match[0].length);
  // 已经带 worker 的 /api/v1 前缀时不再重复拼接，否则会得到 /api/v1/api/v1/...
  if (suffix === '/api/v1' || suffix.startsWith('/api/v1/') || suffix.startsWith('/api/v1?')) {
    return suffix;
  }
  return `/api/v1${suffix}`;
}

/**
 * 流式转发：请求体来自 `req.raw`，响应体直接 pipe 回客户端；剥离 core 凭据，
 * 注入 `x-mpanel-request-id`，把 worker 的 401/403 转为 UPSTREAM_ERROR。
 */
export function proxyHttpHandler(
  deps: ProxyDeps,
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (req, reply) => {
    const params = req.params as { machineId?: string };
    const machineId = params.machineId;
    const rawUrl = req.raw.url ?? req.url ?? '';
    const target = mapProxyHttpRequest(rawUrl);
    const targetPath = target.split('?', 1)[0] ?? '';

    if (machineId === undefined || machineId.length === 0) {
      sendEnvelope(reply, 404, 'NOT_FOUND', '机器不存在');
      return;
    }
    if (targetPath.startsWith('/ws/')) {
      // WS 必须使用 /proxy/ws/* 且 websocket:true；HTTP 通配不得吞掉它。
      sendEnvelope(reply, 404, 'NOT_FOUND', 'WS 端点必须使用 /proxy/ws/*', {
        hint: '浏览器应以 /api/v1/machines/:id/proxy/ws/... 建立 WebSocket',
      });
      return;
    }

    const method = req.method.toUpperCase();

    // 精确路径的 handoff redeem 是唯一免 session 的代理端点，必须在转发前按
    // 真实客户端 IP 限速（worker 自己也会限速，但其看到的源 IP 是 core）。
    if (method === 'POST' && targetPath === HANDOFF_REDEEM_TARGET) {
      if (enforceRedeemRateLimit(deps, req, reply)) return;
    }

    const headers: Record<string, string | string[] | undefined> = { ...req.headers };
    headers['x-mpanel-request-id'] = String(req.id);
    const actor = actorOf(req);
    if (actor !== undefined && headers['x-mpanel-user'] === undefined) {
      headers['x-mpanel-user'] = actor;
    }

    const hasBody =
      method !== 'GET' &&
      method !== 'HEAD' &&
      (req.headers['content-length'] !== undefined ||
        req.headers['transfer-encoding'] !== undefined);

    const timeoutMs = LONG_LIVED_PATHS.some((pattern) => pattern.test(targetPath))
      ? LONG_TIMEOUT_MS
      : DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error('proxy timeout'));
    }, timeoutMs);
    timer.unref?.();

    const onClientGone = (): void => {
      if (!controller.signal.aborted) controller.abort(new Error('client disconnected'));
    };
    req.raw.once('aborted', onClientGone);
    reply.raw.once('close', () => {
      if (!reply.raw.writableEnded) onClientGone();
    });

    let upstream: MachineHttpResponse;
    try {
      upstream = await deps.machines.request(machineId, {
        method,
        path: target,
        headers,
        body: hasBody ? req.raw : null,
        requestId: String(req.id),
        ...(actor === undefined ? {} : { userId: actor }),
        ...(typeof req.ip === 'string' ? { remoteAddress: req.ip } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      req.raw.removeListener('aborted', onClientGone);
      if (!reply.sent) sendProxyError(reply, error);
      void writeProxyAudit(deps, req, machineId, method, targetPath, 'error', error);
      return;
    }

    const finish = (): void => {
      clearTimeout(timer);
      req.raw.removeListener('aborted', onClientGone);
    };

    const status = upstream.status;
    const upstreamHeaders = upstream.headers;
    const contentType = headerText(upstreamHeaders['content-type']);
    const isJson = contentType !== undefined && contentType.toLowerCase().includes('application/json');

    if (status === 401 || status === 403) {
      destroyQuietly(upstream.body);
      finish();
      sendEnvelope(
        reply,
        502,
        'UPSTREAM_ERROR',
        'worker 拒绝了机器凭据',
        { stage: 'auth', upstreamStatus: status, machineId },
      );
      void writeProxyAudit(deps, req, machineId, method, targetPath, 'error', undefined, status);
      return;
    }

    if (status === 413 || status === 415) {
      destroyQuietly(upstream.body);
      finish();
      sendEnvelope(reply, 400, 'BAD_REQUEST', '上传大小或 content-type 不受 worker 支持', {
        hint: '检查文件大小（worker 默认 100 MiB）与请求头后重试',
        upstreamStatus: status,
      });
      void writeProxyAudit(deps, req, machineId, method, targetPath, 'error', undefined, status);
      return;
    }

    if (status >= 500 && !isJson) {
      destroyQuietly(upstream.body);
      finish();
      sendEnvelope(reply, 502, 'UPSTREAM_ERROR', 'worker 返回了非信封 5xx 响应', {
        upstreamStatus: status,
        machineId,
      });
      void writeProxyAudit(deps, req, machineId, method, targetPath, 'error', undefined, status);
      return;
    }

    const headersOut: Record<string, string | string[]> = { ...upstreamHeaders };
    delete headersOut['set-cookie'];

    if (status === 204 || status === 304 || method === 'HEAD') {
      destroyQuietly(upstream.body);
      for (const [name, value] of Object.entries(headersOut)) {
        if (name === 'content-length' || name === 'content-type') continue;
        reply.header(name, value);
      }
      reply.code(status);
      finish();
      writeProxyAuditSync(deps, req, machineId, method, targetPath, 'ok', status);
      await reply.send();
      return;
    }

    upstream.body.once('end', finish);
    upstream.body.once('close', finish);
    upstream.body.once('error', finish);

    for (const [name, value] of Object.entries(headersOut)) {
      reply.header(name, value);
    }
    reply.code(status);
    // 必须返回 reply（而不是只调用 send）：async handler 立即 resolve 会让
    // Fastify 在流开始 pipe 前结束响应，产生 content-length:0 的空响应。
    await reply.send(upstream.body);
    void writeProxyAudit(deps, req, machineId, method, targetPath, status >= 400 ? 'error' : 'ok', undefined, status);
  };
}

/* -------------------------------------------------------------------- */
/* 辅助                                                                 */
/* -------------------------------------------------------------------- */

function sendEnvelope(
  reply: FastifyReply,
  status: number,
  code: ErrorCode,
  message: string,
  details?: unknown,
): void {
  if (reply.sent || reply.raw.headersSent) {
    if (!reply.raw.writableEnded) reply.raw.destroy();
    return;
  }
  const body: ApiErrorBody = { code, message, ...(details === undefined ? {} : { details }) };
  reply.code(status).send({ ok: false, error: body });
}

function sendProxyError(reply: FastifyReply, error: unknown): void {
  if (isPanelError(error)) {
    sendEnvelope(reply, error.status, error.code, error.message, error.details);
    return;
  }
  sendEnvelope(reply, 502, 'UPSTREAM_ERROR', '转发到 worker 失败', {
    reason: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
  });
}

function destroyQuietly(stream: { destroy: (error?: Error) => void }): void {
  try {
    stream.destroy();
  } catch {
    // 忽略。
  }
}

function headerText(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function actorOf(req: FastifyRequest): string | undefined {
  const injected = (
    req as FastifyRequest & { mpanelAuth?: AuthContext; auth?: AuthContext }
  ).mpanelAuth ?? (req as FastifyRequest & { auth?: AuthContext }).auth;
  return injected?.user?.username;
}

async function writeProxyAudit(
  deps: ProxyDeps,
  req: FastifyRequest,
  machineId: string,
  method: string,
  targetPath: string,
  result: 'ok' | 'error',
  error?: unknown,
  status?: number,
): Promise<void> {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  try {
    await deps.audit.write({
      at: new Date().toISOString(),
      action: 'proxy.request',
      actor: actorOf(req) ?? 'unknown',
      ...(typeof req.ip === 'string' ? { ip: req.ip } : {}),
      target: `machine:${machineId}`,
      result,
      details: {
        method,
        path: targetPath,
        ...(status === undefined ? {} : { status }),
        ...(error === undefined
          ? {}
          : { error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) }),
      },
    });
  } catch {
    // 审计失败不影响代理。
  }
}

function writeProxyAuditSync(
  deps: ProxyDeps,
  req: FastifyRequest,
  machineId: string,
  method: string,
  targetPath: string,
  result: 'ok' | 'error',
  status: number,
): void {
  void writeProxyAudit(deps, req, machineId, method, targetPath, result, undefined, status);
}
