import { errorEnvelope, matchWsPath, PanelError, wsCloseCodeForError } from '@mpanel/shared';
import type {
  WsBridge,
  WsConnection,
  WsHandler,
  WsOpenRequest,
  WsSink,
} from '@mpanel/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type WebSocket from 'ws';
import type { RawData } from 'ws';
import type { WorkerAuth } from './auth.js';
import type { WorkerLogger } from './logger.js';

/**
 * 传输无关的 WS 网关。模块向 WsBridge 注册 `/ws/*` 路由；直连 HTTP 传输
 * 由本文件把 @fastify/websocket 适配到 WsBridge，隧道模式则通过 loopback
 * WS 复用同一个 gateway（因此 ticket/token 鉴权始终生效）。
 */

const WS_BACKPRESSURE_LOW = 1024 * 1024;
const WS_DRAIN_TIMEOUT_MS = 30_000;
const PENDING_MESSAGE_MAX_BYTES = 8 * 1024 * 1024;

interface ParsedUrl {
  pathname: string;
  rawQuery: string;
  query: Record<string, string>;
}

function parseRawUrl(rawUrl: string): ParsedUrl {
  const withoutHash = rawUrl.split('#', 1)[0] ?? '';
  const question = withoutHash.indexOf('?');
  const pathname = question >= 0 ? withoutHash.slice(0, question) : withoutHash;
  const rawQuery = question >= 0 ? withoutHash.slice(question + 1) : '';
  const query: Record<string, string> = {};
  if (rawQuery.length > 0) {
    const params = new URLSearchParams(rawQuery);
    params.forEach((value, key) => {
      query[key] = value;
    });
  }
  return { pathname, rawQuery: rawQuery.length > 0 ? `?${rawQuery}` : '', query };
}

/** 模块不应看到 ticket/token；core 隧道同样在转发前剔除。 */
function sanitizeForModule(parsed: ParsedUrl): { query: Record<string, string>; rawQuery: string } {
  const params = new URLSearchParams(parsed.rawQuery.startsWith('?') ? parsed.rawQuery.slice(1) : '');
  params.delete('ticket');
  params.delete('token');
  const query: Record<string, string> = {};
  params.forEach((value, key) => {
    query[key] = value;
  });
  const raw = params.toString();
  return { query, rawQuery: raw.length > 0 ? `?${raw}` : '' };
}

function normalizedHeaders(
  headers: FastifyRequest['headers'],
): Record<string, string | string[] | undefined> {
  const output = { ...headers } as Record<string, string | string[] | undefined>;
  // 模块不需要凭据与逐跳头；与 core 隧道转发时的剥离规则保持一致。
  for (const name of [
    'authorization',
    'cookie',
    'host',
    'connection',
    'upgrade',
    'x-mpanel-token',
    'sec-websocket-key',
    'sec-websocket-version',
    'sec-websocket-extensions',
    'sec-websocket-accept',
    'sec-websocket-protocol',
  ]) {
    delete output[name];
  }
  return output;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function protocolsFrom(headers: FastifyRequest['headers']): string[] {
  const raw = headerValue(headers['sec-websocket-protocol']);
  if (raw === undefined) return [];
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function toCloseReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined;
  const buffer = Buffer.from(reason, 'utf8');
  if (buffer.length <= 123) return reason;
  // 按字节截断；末尾可能出现替换字符，ws 会按 UTF-8 发送。
  return buffer.subarray(0, 123).toString('utf8');
}

function normalizeCloseCode(code: number | undefined): number {
  if (code === undefined) return 1000;
  if (code === 1005 || code === 1006 || code === 1015) return 1011;
  if (code < 1000) return 1011;
  if (code > 4999) return 4999;
  return code;
}

function rawDataToPayload(data: RawData, binary: boolean): { data: string | Uint8Array; binary: boolean } {
  if (binary) {
    if (Buffer.isBuffer(data)) return { data: new Uint8Array(data), binary: true };
    if (Array.isArray(data)) return { data: new Uint8Array(Buffer.concat(data)), binary: true };
    return { data: new Uint8Array(Buffer.from(data)), binary: true };
  }
  if (Buffer.isBuffer(data)) return { data: data.toString('utf8'), binary: false };
  if (Array.isArray(data)) return { data: Buffer.concat(data).toString('utf8'), binary: false };
  return { data: Buffer.from(data).toString('utf8'), binary: false };
}

function rawDataBytes(data: RawData): number {
  if (Buffer.isBuffer(data)) return data.length;
  if (Array.isArray(data)) return data.reduce((total, chunk) => total + chunk.length, 0);
  return Buffer.byteLength(data);
}

/** 进程内 WS 路由表；三种传输共用，`listRoutes()` 即路由清单。 */
export function createWsBridge(logger: WorkerLogger): WsBridge {
  const routes: Array<{ pattern: string; handler: WsHandler }> = [];

  const find = (pathname: string): { pattern: string; handler: WsHandler; params: Record<string, string> } | null => {
    for (const route of routes) {
      const params = matchWsPath(route.pattern, pathname);
      if (params !== null) return { ...route, params };
    }
    return null;
  };

  return {
    register(pattern: string, handler: WsHandler): void {
      if (typeof pattern !== 'string' || !pattern.startsWith('/ws/')) {
        throw new PanelError('INTERNAL', `WS 路由必须以 /ws/ 开头：${String(pattern)}`);
      }
      if (typeof handler !== 'function') {
        throw new PanelError('INTERNAL', `WS 路由处理器必须是函数：${pattern}`);
      }
      if (routes.some((route) => route.pattern === pattern)) {
        throw new PanelError('INTERNAL', `WS 路由重复注册：${pattern}`, { pattern });
      }
      routes.push({ pattern, handler });
      logger.debug('WS 路由已注册', { pattern });
    },

    async open(request: WsOpenRequest, sink: WsSink): Promise<WsConnection> {
      const matched = find(request.path);
      if (matched === null) {
        throw new PanelError('NOT_FOUND', 'WS 路由不存在', { path: request.path });
      }
      const fullRequest: WsOpenRequest = {
        ...request,
        params: matched.params,
      };
      return matched.handler(fullRequest, sink);
    },

    hasRoute(pathname: string): boolean {
      return find(pathname) !== null;
    },

    listRoutes(): string[] {
      return routes.map((route) => route.pattern);
    },
  };
}

interface SocketState {
  closed: boolean;
  closedBySink: boolean;
  connection: WsConnection | null;
  pending: Array<{ data: string | Uint8Array; binary: boolean }>;
  pendingBytes: number;
  drainWaiters: Array<() => void>;
}

function createSink(socket: WebSocket, state: SocketState, logger: WorkerLogger): WsSink {
  return {
    sendText(data: string): void {
      if (state.closed || socket.readyState !== socket.OPEN) return;
      try {
        socket.send(data, { binary: false });
      } catch (error) {
        logger.warn('WS 发送文本帧失败', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    sendBinary(data: Uint8Array): void {
      if (state.closed || socket.readyState !== socket.OPEN) return;
      try {
        socket.send(Buffer.from(data), { binary: true });
      } catch (error) {
        logger.warn('WS 发送二进制帧失败', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    close(code?: number, reason?: string): void {
      if (state.closed || state.closedBySink) return;
      state.closedBySink = true;
      for (const resolve of state.drainWaiters.splice(0)) resolve();
      try {
        socket.close(normalizeCloseCode(code), toCloseReason(reason));
      } catch {
        socket.terminate();
      }
      const timer = setTimeout(() => {
        if (socket.readyState !== socket.CLOSED) socket.terminate();
      }, 5_000);
      timer.unref?.();
    },
    get bufferedBytes(): number {
      return socket.bufferedAmount;
    },
    waitForDrain(): Promise<void> {
      if (state.closed) return Promise.resolve();
      if (socket.bufferedAmount <= WS_BACKPRESSURE_LOW) return Promise.resolve();
      return new Promise<void>((resolve) => {
        let settled = false;
        const poller = setInterval(() => {
          if (state.closed || socket.bufferedAmount <= WS_BACKPRESSURE_LOW) finish();
        }, 25);
        poller.unref?.();
        const deadline = setTimeout(() => finish(), WS_DRAIN_TIMEOUT_MS);
        deadline.unref?.();
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearInterval(poller);
          clearTimeout(deadline);
          const index = state.drainWaiters.indexOf(finish);
          if (index >= 0) state.drainWaiters.splice(index, 1);
          resolve();
        };
        state.drainWaiters.push(finish);
      });
    },
  };
}

async function authorizeWs(
  request: FastifyRequest,
  rawUrl: string,
  auth: WorkerAuth,
  parsed: ParsedUrl,
): Promise<boolean> {
  // 优先 Authorization: Bearer <MPANEL_TOKEN>（core http 传输/服务端直连）。
  const bearer = headerValue(request.headers.authorization);
  if (bearer !== undefined && bearer.trim().length > 0) {
    try {
      await auth.authenticate(request);
      return true;
    } catch {
      // 继续尝试 query 凭据（可能是浏览器在 header 中带了无关值）。
    }
  }
  if (auth.verifyToken(parsed.query.token ?? '')) return true;
  const ticket = parsed.query.ticket;
  if (ticket !== undefined && ticket.length > 0) {
    if (auth.consumeWsTicket(ticket, rawUrl)) return true;
  }
  return false;
}

async function handleSocket(
  socket: WebSocket,
  request: FastifyRequest,
  rawUrl: string,
  bridge: WsBridge,
  logger: WorkerLogger,
): Promise<void> {
  const parsed = parseRawUrl(rawUrl);
  const state: SocketState = {
    closed: false,
    closedBySink: false,
    connection: null,
    pending: [],
    pendingBytes: 0,
    drainWaiters: [],
  };
  const sink = createSink(socket, state, logger);

  const deliver = (payload: { data: string | Uint8Array; binary: boolean }): void => {
    if (state.connection === null) return;
    try {
      state.connection.receive(payload.data, payload.binary);
    } catch (error) {
      logger.warn('WS 模块处理消息失败，关闭连接 1011', {
        path: parsed.pathname,
        error: error instanceof Error ? error.message : String(error),
      });
      sink.close(1011, 'internal error');
    }
  };

  socket.on('message', (data: RawData, isBinary: boolean) => {
    if (state.closed) return;
    const payload = rawDataToPayload(data, isBinary);
    if (state.connection === null) {
      state.pendingBytes += rawDataBytes(data);
      if (state.pendingBytes > PENDING_MESSAGE_MAX_BYTES) {
        sink.close(1013, 'backpressure');
        return;
      }
      state.pending.push(payload);
      return;
    }
    deliver(payload);
  });

  socket.on('close', (code: number, reason: Buffer) => {
    state.closed = true;
    const connection = state.connection;
    state.connection = null;
    state.pending = [];
    if (connection !== null && !state.closedBySink) {
      try {
        connection.close(code === 1005 || code === 1006 ? 1001 : code, reason.toString('utf8'));
      } catch {
        // 模块可能已经主动关闭。
      }
    }
    for (const resolve of state.drainWaiters.splice(0)) resolve();
    logger.debug('WS 连接已关闭', { path: parsed.pathname, code });
  });

  socket.on('error', (error: Error) => {
    logger.debug('WS 连接错误', { path: parsed.pathname, error: error.message });
  });

  const sanitized = sanitizeForModule(parsed);
  const openRequest: WsOpenRequest = {
    path: parsed.pathname,
    rawQuery: sanitized.rawQuery,
    query: sanitized.query,
    params: {},
    headers: normalizedHeaders(request.headers),
    protocols: protocolsFrom(request.headers),
  };

  try {
    const connection = await bridge.open(openRequest, sink);
    if (state.closed) {
      try {
        connection.close(1001, 'socket closed');
      } catch {
        // 已关闭。
      }
      return;
    }
    state.connection = connection;
    for (const payload of state.pending.splice(0)) {
      deliver(payload);
    }
    state.pendingBytes = 0;
  } catch (error) {
    const code = wsCloseCodeForError(error);
    const message = error instanceof Error ? error.message : 'WS 打开失败';
    logger.warn('WS 路由打开失败', { path: parsed.pathname, code, error: message });
    sink.close(code, message);
  }
}

/**
 * 注册 `/ws/*` 网关。REST 鉴权 hook 不覆盖本路由；认证在升级前完成，
 * 失败直接 401，不建立 socket。
 */
export async function registerWsGateway(
  app: FastifyInstance,
  bridge: WsBridge,
  auth: WorkerAuth,
  logger: WorkerLogger,
): Promise<void> {
  app.route({
    method: 'GET',
    url: '/ws/*',
    websocket: true,
    preValidation: async (request, reply) => {
      const rawUrl = request.raw.url ?? request.url;
      const parsed = parseRawUrl(rawUrl);
      const allowed = await authorizeWs(request, rawUrl, auth, parsed);
      if (!allowed) {
        reply
          .code(401)
          .type('application/json; charset=utf-8')
          .send(
            errorEnvelope('UNAUTHORIZED', 'WebSocket 连接需要有效的 ticket 或 token', {
              hint: '先调用 POST /api/v1/auth/ws-ticket 换票，或使用 ?token=<MPANEL_TOKEN>。',
            }),
          );
      }
    },
    handler: (socket, request) => {
      const rawUrl = request.raw.url ?? request.url;
      const parsed = parseRawUrl(rawUrl);
      logger.debug('WS 连接进入网关', { path: parsed.pathname });
      void handleSocket(socket, request, rawUrl, bridge, logger);
    },
  });
}
