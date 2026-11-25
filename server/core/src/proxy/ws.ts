import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import { PanelError, isPanelError } from '@mpanel/shared';
import { constantTimeEqual } from '../machines/credentials.js';
import type { AuthContext } from '../auth/types.js';
import type { ProxyDeps } from './index.js';

const MAX_CLIENT_BUFFERED_BYTES = 8 * 1024 * 1024;

/** 兼容 @fastify/websocket 传入的 FastifyRequest 与裸 IncomingMessage。 */
interface WsRequestLike {
  url?: string;
  headers?: IncomingHttpHeaders;
  params?: unknown;
  ip?: string;
  auth?: AuthContext;
  /** app.ts 鉴权 hook 注入的上下文（代理 WS 通常为空，由本模块自行校验）。 */
  mpanelAuth?: AuthContext;
  raw?: IncomingMessage;
}

type WsHandler = (socket: WebSocket, request: WsRequestLike) => Promise<void>;

/**
 * 代理 WS 路径 → worker WS 路径：从 `/proxy/ws/...` 截取 `/ws/...`，
 * 保留业务原始 query（重复参数/编码），仅剔除用户的 ticket/token。
 */
export function mapProxyWsRequest(rawUrl: string): string {
  const match = /^\/api\/v1\/machines\/[^/?#]+\/proxy(\/ws\/[^?#]*)(?:\?([^#]*))?/.exec(rawUrl);
  if (match === null) return rawUrl;
  const path = match[1] ?? '/ws/';
  const rawQuery = match[2];
  if (rawQuery === undefined || rawQuery.length === 0) return path;
  const kept: string[] = [];
  for (const pair of rawQuery.split('&')) {
    if (pair.length === 0) continue;
    const rawKey = pair.includes('=') ? pair.slice(0, pair.indexOf('=')) : pair;
    if (isAuthQueryKey(rawKey)) continue;
    kept.push(pair);
  }
  return kept.length === 0 ? path : `${path}?${kept.join('&')}`;
}

/**
 * 双向转发：core 代理 WS 自行校验 ticket/Bearer（不挂 REST hook），
 * 业务消息与关闭码透传；离线/未知机器用 WS close 码表达。
 */
export function proxyWsHandler(deps: ProxyDeps): WsHandler {
  return async (socket, rawRequest) => {
    const request = normalizeRequest(rawRequest);
    const rawUrl = request.url;
    let closed = false;
    let clientGone = false;
    let upstream: import('../machines/service.js').MachineWsConnection | undefined;
    /** 客户端可能在 core 建立上游 WS 前就发送消息，先缓冲再冲刷。 */
    const pendingFromClient: Array<{ data: string | Uint8Array; binary: boolean }> = [];

    const closeWith = (code: number, reason: string): void => {
      if (closed) return;
      closed = true;
      try {
        if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
          socket.close(sanitizeCloseCode(code), truncateReason(reason));
        }
      } catch {
        try {
          socket.terminate();
        } catch {
          // 忽略。
        }
      }
    };

    const closeUpstream = (code: number, reason: string): void => {
      try {
        upstream?.close(sanitizeCloseCode(code), truncateReason(reason));
      } catch {
        // 忽略。
      }
    };

    // 先挂客户端监听，避免 upgrade 完成到上游建立之间的消息丢失。
    socket.on('message', (data, isBinary) => {
      const payload = isBinary ? toBuffer(data) : toBuffer(data).toString('utf8');
      if (upstream === undefined) {
        if (pendingFromClient.length < 256) pendingFromClient.push({ data: payload, binary: isBinary });
        return;
      }
      try {
        upstream.send(payload, isBinary);
      } catch {
        closeUpstream(1011, 'tunnel send failed');
        closeWith(1011, 'tunnel send failed');
      }
    });

    socket.on('close', (code: number, reason: Buffer) => {
      closed = true;
      clientGone = true;
      closeUpstream(sanitizeCloseCode(code), reason?.toString('utf8') ?? '');
    });

    socket.on('error', () => {
      closed = true;
      clientGone = true;
      closeUpstream(1011, 'client socket error');
    });

    const machineId = machineIdOf(request);
    if (machineId === undefined) {
      closeWith(4404, 'machine not found');
      return;
    }

    const target = mapProxyWsRequest(rawUrl);
    if (!target.startsWith('/ws/')) {
      closeWith(4404, 'invalid proxy ws path');
      return;
    }

    const authResult = authenticateProxyWs(deps, request, rawUrl);
    if (!authResult.ok) {
      closeWith(authResult.code, authResult.reason);
      return;
    }

    const connection = await deps.machines
      .openWs(machineId, {
        path: target,
        headers: request.headers,
        protocols: parseProtocols(request.headers['sec-websocket-protocol']),
      })
      .catch((error: unknown) => {
        if (isPanelError(error)) {
          closeWith(closeCodeForPanelError(error), error.message);
        } else {
          closeWith(1011, 'proxy ws failed');
        }
        return undefined;
      });
    if (connection === undefined) return;

    if (socket.readyState !== socket.OPEN) {
      connection.close(1001, 'client closed');
      return;
    }

    upstream = connection;

    connection.onMessage((data, binary) => {
      if (socket.readyState !== socket.OPEN) return;
      if (socket.bufferedAmount > MAX_CLIENT_BUFFERED_BYTES) {
        closeUpstream(1013, 'backpressure');
        closeWith(1013, 'backpressure');
        return;
      }
      socket.send(data, { binary }, (error?: Error) => {
        if (error !== undefined && error !== null) {
          closeUpstream(1011, 'client send failed');
          closeWith(1011, 'client send failed');
        }
      });
    });

    connection.onClose((code, reason) => {
      closeWith(sanitizeCloseCode(code), reason);
    });

    const queued = pendingFromClient.splice(0);
    for (const item of queued) {
      try {
        connection.send(item.data, item.binary);
      } catch {
        connection.close(1011, 'tunnel send failed');
        closeWith(1011, 'tunnel send failed');
        return;
      }
    }
    if (clientGone) connection.close(1001, 'client closed');
  };
}

/* -------------------------------------------------------------------- */
/* 鉴权                                                                 */
/* -------------------------------------------------------------------- */

type AuthDecision = { ok: true } | { ok: false; code: number; reason: string };

/**
 * core 代理 WS 的独立鉴权：
 * 1) 网关 preValidation 已注入 req.auth 时直接放行；
 * 2) 一次性 ticket（绑定身份/机器/规范化 path+业务 query，60s，单次）；
 * 3) `?token=` 或 `Authorization: Bearer` 的 MPANEL_CORE_TOKEN（脚本使用）。
 * 裸连一律 4401。
 */
function authenticateProxyWs(deps: ProxyDeps, request: WsRequestLike, rawUrl: string): AuthDecision {
  if (request.auth !== undefined || request.mpanelAuth !== undefined) return { ok: true };

  const query = parseRawQuery(rawUrl);
  const ticket = query.get('ticket');
  if (ticket !== undefined && ticket.length > 0) {
    const ticketPath = stripAuthQuery(rawUrl);
    try {
      deps.auth.consumeWsTicket(ticket, ticketPath);
      return { ok: true };
    } catch {
      return { ok: false, code: 4401, reason: 'invalid or expired ws ticket' };
    }
  }

  const token = query.get('token') ?? extractBearer(request.headers?.authorization);
  const expected = deps.config.coreToken;
  if (token !== undefined && token.length > 0 && expected !== undefined && expected.length > 0) {
    if (constantTimeEqual(token, expected)) return { ok: true };
    return { ok: false, code: 4401, reason: 'invalid core token' };
  }

  return { ok: false, code: 4401, reason: 'ws ticket required' };
}

/* -------------------------------------------------------------------- */
/* 工具                                                                 */
/* -------------------------------------------------------------------- */

function normalizeRequest(request: WsRequestLike): {
  url: string;
  headers: IncomingHttpHeaders;
  params: unknown;
  auth?: AuthContext;
} {
  const fromFastify = request as WsRequestLike & { raw?: IncomingMessage };
  const base: IncomingMessage | undefined = fromFastify.raw;
  const auth = request.mpanelAuth ?? request.auth;
  return {
    url: request.url ?? base?.url ?? '',
    headers: request.headers ?? base?.headers ?? {},
    params: request.params,
    ...(auth === undefined ? {} : { auth }),
  };
}

function machineIdOf(request: { url: string; params: unknown }): string | undefined {
  const params = request.params as { machineId?: unknown } | undefined;
  if (params !== undefined && typeof params.machineId === 'string' && params.machineId.length > 0) {
    return params.machineId;
  }
  const match = /^\/api\/v1\/machines\/([^/?#]+)\/proxy\/ws\//.exec(request.url);
  if (match === null) return undefined;
  const encoded = match[1];
  if (encoded === undefined) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function parseProtocols(header: string | string[] | undefined): string[] | undefined {
  if (header === undefined) return undefined;
  const raw = Array.isArray(header) ? header.join(',') : header;
  const protocols = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .slice(0, 16);
  return protocols.length === 0 ? undefined : protocols;
}

function parseRawQuery(rawUrl: string): Map<string, string> {
  const map = new Map<string, string>();
  const index = rawUrl.indexOf('?');
  if (index < 0) return map;
  const query = rawUrl.slice(index + 1).split('#', 1)[0] ?? '';
  for (const pair of query.split('&')) {
    if (pair.length === 0) continue;
    const equals = pair.indexOf('=');
    const key = decodeURIComponent(equals < 0 ? pair : pair.slice(0, equals));
    if (map.has(key)) continue;
    map.set(key, decodeURIComponent(equals < 0 ? '' : pair.slice(equals + 1)));
  }
  return map;
}

/** 取完整 path + 业务 query（保留原始编码与顺序，剔除 ticket/token）。 */
function stripAuthQuery(rawUrl: string): string {
  const hashIndex = rawUrl.indexOf('#');
  const withoutHash = hashIndex >= 0 ? rawUrl.slice(0, hashIndex) : rawUrl;
  const queryIndex = withoutHash.indexOf('?');
  if (queryIndex < 0) return withoutHash;
  const path = withoutHash.slice(0, queryIndex);
  const rawQuery = withoutHash.slice(queryIndex + 1);
  const kept: string[] = [];
  for (const pair of rawQuery.split('&')) {
    if (pair.length === 0) continue;
    const rawKey = pair.includes('=') ? pair.slice(0, pair.indexOf('=')) : pair;
    if (isAuthQueryKey(rawKey)) continue;
    kept.push(pair);
  }
  return kept.length === 0 ? path : `${path}?${kept.join('&')}`;
}

function isAuthQueryKey(rawKey: string): boolean {
  let key = rawKey;
  try {
    key = decodeURIComponent(rawKey);
  } catch {
    // 保留原值比较。
  }
  return key === 'ticket' || key === 'token';
}

function extractBearer(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1]?.trim();
}

function closeCodeForPanelError(error: PanelError): number {
  switch (error.code) {
    case 'UNAUTHORIZED':
      return 4401;
    case 'FORBIDDEN':
      return 4403;
    case 'NOT_FOUND':
      return 4404;
    case 'UNAVAILABLE':
    case 'UPSTREAM_ERROR':
      return 4502;
    default:
      return 1011;
  }
}

function sanitizeCloseCode(code?: number): number {
  if (code === undefined) return 1000;
  if (code === 1000 || code === 1001 || code === 1002 || code === 1003) return code;
  if (code >= 1007 && code <= 1014) return code;
  if (code >= 3000 && code <= 4999) return code;
  return 1011;
}

function truncateReason(reason: string): string {
  if (reason.length === 0) return reason;
  let result = '';
  let bytes = 0;
  for (const char of reason) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > 123) break;
    bytes += size;
    result += char;
  }
  return result;
}

function toBuffer(data: import('ws').RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}
