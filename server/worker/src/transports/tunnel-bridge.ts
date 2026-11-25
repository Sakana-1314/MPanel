import { PassThrough, Readable } from 'node:stream';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import {
  PanelError,
  TUNNEL_CHUNK_BYTES,
  TUNNEL_MAX_INFLIGHT_REQUESTS,
  TUNNEL_MAX_WS_STREAMS,
  WS_MAX_MESSAGE_BYTES,
} from '@mpanel/shared';
import type {
  ErrorCode,
  HttpRequestChunkFrame,
  HttpRequestHeadFrame,
  HttpResponseFrame,
  TunnelFrame,
  TunnelHeaders,
  WsCloseFrame,
  WsFrame,
  WsOpenRequestFrame,
} from '@mpanel/shared';
import type { WorkerLogger } from '../logger.js';

/**
 * 隧道桥：把 core 的帧翻译成 worker 自身 loopback 上的 HTTP/WS 请求。
 * 只通过 loopback + worker token 访问，不直接调用 WsBridge，确保鉴权、
 * zod 校验、错误信封与直连 HTTP 传输完全一致；大文件按 512 KiB 流式分块。
 */

export interface TunnelBridgeDeps {
  token: string;
  logger: WorkerLogger;
  host: string;
  port: number;
  /** 已知 WS 路由表；缺失时跳过预检（仅测试用途）。 */
  hasWsRoute?: (pathname: string) => boolean;
}

type SendFrame = (frame: TunnelFrame) => void | Promise<void>;
type RequestBody = NonNullable<RequestInit['body']>;

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const REQUEST_BLOCKED = new Set([
  ...HOP_BY_HOP,
  'host',
  'cookie',
  'authorization',
  'content-length',
  'expect',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-protocol',
  'sec-websocket-accept',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'origin',
]);

const RESPONSE_BLOCKED = new Set([
  ...HOP_BY_HOP,
  'set-cookie',
  'sec-websocket-key',
  'sec-websocket-version',
  'sec-websocket-extensions',
  'sec-websocket-protocol',
  'sec-websocket-accept',
]);

const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const LOOPBACK_REQUEST_TIMEOUT_MS = 620_000;
const WS_BACKPRESSURE_HIGH = 8 * 1024 * 1024;
const WS_BACKPRESSURE_LOW = 2 * 1024 * 1024;
const WS_DRAIN_TIMEOUT_MS = 30_000;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function headerValues(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}

function buildRequestHeaders(headers: TunnelHeaders, token: string, requestId: string): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    const lowered = name.toLowerCase();
    if (REQUEST_BLOCKED.has(lowered)) continue;
    if (/[\u0000-\u001f\u007f]/.test(lowered)) continue;
    for (const item of headerValues(value)) {
      try {
        result.append(lowered, item);
      } catch {
        // Headers 拒绝非法值；丢弃该头，不中断请求。
      }
    }
  }
  result.set('authorization', `Bearer ${token}`);
  result.set('x-mpanel-request-id', requestId);
  return result;
}

function buildResponseHeaders(headers: Headers): Record<string, string | string[]> {
  const output: Record<string, string | string[]> = {};
  headers.forEach((value, name) => {
    const lowered = name.toLowerCase();
    if (RESPONSE_BLOCKED.has(lowered)) return;
    output[lowered] = value;
  });
  return output;
}

function hasDotSegments(pathname: string): boolean {
  return /(?:^|\/)(?:\.{1,2}|%2e{1,2})(?:\/|$)/i.test(pathname);
}

function validateTunnelUrl(url: string): void {
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//')) {
    throw new PanelError('BAD_REQUEST', 'http-request.url 必须是 origin-form 路径');
  }
  if (url.includes('\\') || /[\u0000-\u001f\u007f]/.test(url)) {
    throw new PanelError('BAD_REQUEST', 'http-request.url 包含非法字符');
  }
  const pathname = url.split('?', 1)[0] ?? '';
  if (hasDotSegments(pathname) || /%2f|%5c/i.test(pathname)) {
    throw new PanelError('BAD_REQUEST', 'http-request.url 不允许路径穿越或编码分隔符');
  }
  const normalized = new URL(url, 'http://127.0.0.1').pathname;
  if (normalized !== pathname) {
    throw new PanelError('BAD_REQUEST', 'http-request.url 不允许被 URL 规范化改写');
  }
  if (!pathname.startsWith('/api/v1/') && pathname !== '/api/v1' && pathname !== '/healthz') {
    throw new PanelError('NOT_FOUND', '隧道只允许访问 /api/v1/* 与 /healthz', {
      path: pathname,
    });
  }
}

function decodeBase64(value: string, label: string): Buffer {
  if (!BASE64_RE.test(value)) {
    throw new PanelError('BAD_REQUEST', `${label} 不是合法的 base64`);
  }
  return Buffer.from(value, 'base64');
}

function safeCloseCode(code: number | undefined): number {
  if (code === undefined) return 1000;
  if (code === 1005 || code === 1006 || code === 1015) return 1011;
  if (code < 1000) return 1011;
  if (code > 4999) return 4999;
  return code;
}

function reasonForLog(rawUrl: string): string {
  const question = rawUrl.indexOf('?');
  return question >= 0 ? rawUrl.slice(0, question) : rawUrl;
}

interface HttpSession {
  id: string;
  controller: AbortController;
  bodyStream: PassThrough | null;
  expectedChunkSeq: number;
  bodyFinished: boolean;
  canceled: boolean;
  startedAt: number;
  method: string;
  url: string;
}

interface WsSession {
  id: string;
  socket: WebSocket;
  accepted: boolean;
  closeFromCore: boolean;
  seqOut: number;
  seqIn: number | null;
  path: string;
  /** loopback → tunnel 的发送串行链，保证帧顺序并承载背压。 */
  outChain: Promise<void>;
  /** tunnel → loopback 的发送串行链。 */
  inChain: Promise<void>;
  pendingOutBytes: number;
}

export class TunnelBridge {
  private readonly deps: TunnelBridgeDeps;
  private readonly httpSessions = new Map<string, HttpSession>();
  private readonly wsSessions = new Map<string, WsSession>();
  private readonly recentlyClosedWs = new Set<string>();
  private readonly recentlyFinishedHttp = new Set<string>();

  private rememberClosed(id: string): void {
    this.recentlyClosedWs.add(id);
    if (this.recentlyClosedWs.size > 1024) {
      const first = this.recentlyClosedWs.values().next();
      if (!first.done) this.recentlyClosedWs.delete(first.value);
    }
  }

  private rememberFinishedHttp(id: string): void {
    this.recentlyFinishedHttp.add(id);
    if (this.recentlyFinishedHttp.size > 1024) {
      const first = this.recentlyFinishedHttp.values().next();
      if (!first.done) this.recentlyFinishedHttp.delete(first.value);
    }
  }

  constructor(deps: TunnelBridgeDeps) {
    this.deps = deps;
  }

  async handleFrame(frame: TunnelFrame, send: SendFrame): Promise<void> {
    switch (frame.kind) {
      case 'http-request':
        if (frame.phase === 'chunk') {
          await this.handleHttpChunk(frame);
          return;
        }
        if (frame.phase === 'cancel') {
          this.handleHttpCancel(frame.id, frame.reason);
          return;
        }
        this.handleHttpHead(frame, send);
        return;
      case 'ws-open':
        if ('accepted' in frame) {
          this.deps.logger.warn('收到 core 发来的 ws-open 回复帧，忽略', { id: frame.id });
          return;
        }
        this.handleWsOpen(frame, send);
        return;
      case 'ws-frame':
        await this.handleWsFrame(frame, send);
        return;
      case 'ws-close':
        await this.handleWsClose(frame);
        return;
      default:
        // hello/ping/pong 由传输层处理；到达这里说明调用方顺序错误。
        this.deps.logger.debug('隧道桥忽略非请求帧', { kind: frame.kind });
        return;
    }
  }

  closeAll(): void {
    for (const session of this.httpSessions.values()) {
      session.canceled = true;
      session.controller.abort(new Error('tunnel closed'));
      if (session.bodyStream !== null && !session.bodyStream.destroyed) {
        session.bodyStream.destroy(new Error('tunnel closed'));
      }
    }
    this.httpSessions.clear();
    for (const session of this.wsSessions.values()) {
      session.closeFromCore = true;
      try {
        session.socket.terminate();
      } catch {
        // 已关闭。
      }
    }
    this.wsSessions.clear();
  }

  /* ----------------------------- HTTP ------------------------------ */

  private handleHttpHead(frame: HttpRequestHeadFrame, send: SendFrame): void {
    if (this.httpSessions.has(frame.id)) {
      throw new PanelError('BAD_REQUEST', `重复的 HTTP 请求 id：${frame.id}`);
    }
    if (this.httpSessions.size >= TUNNEL_MAX_INFLIGHT_REQUESTS) {
      void this.sendErrorHead(
        frame.id,
        send,
        503,
        'UNAVAILABLE',
        'worker 隧道请求并发已满',
        { hint: '稍后重试；core 应按 TUNNEL_MAX_INFLIGHT_REQUESTS 控制并发。' },
      );
      return;
    }
    const method = frame.method.toUpperCase();
    if (!ALLOWED_METHODS.has(method)) {
      throw new PanelError('BAD_REQUEST', `不支持的 HTTP 方法：${frame.method}`);
    }
    try {
      validateTunnelUrl(frame.url);
    } catch (error) {
      if (error instanceof PanelError) {
        const status = error.code === 'NOT_FOUND' ? 404 : 400;
        void this.sendErrorHead(frame.id, send, status, error.code, error.message, error.details);
        return;
      }
      throw error;
    }
    if (frame.stream === true && frame.bodyBase64 !== undefined) {
      throw new PanelError('BAD_REQUEST', 'http-request 不能同时携带 bodyBase64 与 stream');
    }

    const controller = new AbortController();
    const session: HttpSession = {
      id: frame.id,
      controller,
      bodyStream: null,
      expectedChunkSeq: 0,
      bodyFinished: false,
      canceled: false,
      startedAt: Date.now(),
      method,
      url: frame.url,
    };
    let body: RequestBody | undefined;
    if (frame.stream === true) {
      const stream = new PassThrough({ highWaterMark: 1024 * 1024 });
      stream.on('error', (error: Error) => {
        this.deps.logger.debug('请求体流错误', { id: frame.id, error: error.message });
      });
      session.bodyStream = stream;
      body = Readable.toWeb(stream) as unknown as RequestBody;
    } else if (frame.bodyBase64 !== undefined) {
      body = decodeBase64(frame.bodyBase64, 'bodyBase64') as unknown as RequestBody;
    }
    this.recentlyFinishedHttp.delete(frame.id);
    this.httpSessions.set(frame.id, session);
    void this.runHttp(session, frame, body, send).finally(() => {
      if (this.httpSessions.get(session.id) === session) {
        this.httpSessions.delete(session.id);
      }
      this.rememberFinishedHttp(session.id);
      if (session.bodyStream !== null && !session.bodyStream.destroyed) {
        session.bodyStream.destroy();
      }
    });
  }

  private async handleHttpChunk(frame: HttpRequestChunkFrame): Promise<void> {
    const session = this.httpSessions.get(frame.id);
    if (session === undefined) {
      if (this.recentlyFinishedHttp.has(frame.id)) {
        this.deps.logger.debug('收到已结束 HTTP 请求的 chunk，丢弃', { id: frame.id });
        return;
      }
      throw new PanelError('BAD_REQUEST', `未知的 HTTP 请求 chunk id：${frame.id}`);
    }
    if (session.canceled || session.bodyFinished) {
      this.deps.logger.debug('收到已结束 HTTP 请求的 chunk，丢弃', { id: frame.id });
      return;
    }
    if (frame.seq !== session.expectedChunkSeq) {
      throw new PanelError('BAD_REQUEST', `HTTP 请求 chunk seq 缺口：期望 ${session.expectedChunkSeq}，收到 ${frame.seq}`);
    }
    session.expectedChunkSeq += 1;
    const chunk = decodeBase64(frame.chunkBase64, 'chunkBase64');
    if (chunk.length > TUNNEL_CHUNK_BYTES) {
      throw new PanelError('BAD_REQUEST', `HTTP chunk 超过 ${TUNNEL_CHUNK_BYTES} 字节上限`);
    }
    const stream = session.bodyStream;
    if (stream === null) {
      throw new PanelError('BAD_REQUEST', `HTTP 请求 ${frame.id} 未声明 stream:true 却收到 chunk`);
    }
    if (chunk.length > 0 && !stream.write(chunk)) {
      await new Promise<void>((resolve) => {
        const onDrain = (): void => {
          stream.off('drain', onDrain);
          stream.off('close', onClose);
          resolve();
        };
        const onClose = (): void => {
          stream.off('drain', onDrain);
          resolve();
        };
        stream.once('drain', onDrain);
        stream.once('close', onClose);
      });
    }
    if (frame.final === true) {
      session.bodyFinished = true;
      stream.end();
    }
  }

  private handleHttpCancel(id: string, reason?: string): void {
    const session = this.httpSessions.get(id);
    if (session === undefined) return;
    session.canceled = true;
    session.controller.abort(new Error(reason ?? 'core canceled'));
    if (session.bodyStream !== null && !session.bodyStream.destroyed) {
      session.bodyStream.destroy(new Error(reason ?? 'core canceled'));
    }
    this.httpSessions.delete(id);
    this.deps.logger.debug('HTTP 请求被 core 取消', { id, reason });
  }

  private async sendErrorHead(
    id: string,
    send: SendFrame,
    status: number,
    code: ErrorCode,
    message: string,
    details?: unknown,
  ): Promise<void> {
    const frame: HttpResponseFrame = {
      kind: 'http-response',
      id,
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      error: { code, message, ...(details === undefined ? {} : { details }) },
    };
    await this.safeSend(send, frame);
  }

  private async runHttp(
    session: HttpSession,
    frame: HttpRequestHeadFrame,
    body: RequestBody | undefined,
    send: SendFrame,
  ): Promise<void> {
    const timeout = setTimeout(() => {
      session.controller.abort(new Error('worker loopback timeout'));
    }, LOOPBACK_REQUEST_TIMEOUT_MS);
    timeout.unref?.();
    let headSent = false;
    let chunkSeq = 0;
    try {
      const headers = buildRequestHeaders(frame.headers, this.deps.token, frame.id);
      const init: RequestInit & { duplex?: 'half' } = {
        method: session.method,
        headers,
        signal: session.controller.signal,
        redirect: 'manual',
        ...(body === undefined ? {} : { body, duplex: 'half' }),
      };
      const response = await fetch(
        `http://${this.deps.host}:${this.deps.port}${frame.url}`,
        init as RequestInit,
      );
      if (session.canceled) {
        await response.body?.cancel().catch(() => undefined);
        return;
      }
      const responseHeaders = buildResponseHeaders(response.headers);
      const hasBody =
        session.method !== 'HEAD' &&
        response.status !== 204 &&
        response.status !== 304 &&
        response.body !== null;
      if (!hasBody) {
        headSent = true;
        await this.safeSend(send, {
          kind: 'http-response',
          id: session.id,
          status: response.status,
          headers: responseHeaders,
        });
        return;
      }
      headSent = true;
      await this.safeSend(send, {
        kind: 'http-response',
        id: session.id,
        status: response.status,
        headers: responseHeaders,
        stream: true,
      });
      const reader = response.body?.getReader();
      if (reader === undefined) {
        await this.safeSend(send, {
          kind: 'http-response',
          phase: 'chunk',
          id: session.id,
          seq: 0,
          chunkBase64: '',
          final: true,
        });
        return;
      }
      let buffer = Buffer.alloc(0);
      const sendChunk = async (chunk: Buffer, final: boolean): Promise<void> => {
        await this.safeSend(send, {
          kind: 'http-response',
          phase: 'chunk',
          id: session.id,
          seq: chunkSeq,
          chunkBase64: chunk.toString('base64'),
          ...(final ? { final: true } : {}),
        });
        chunkSeq += 1;
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        buffer = buffer.length === 0 ? Buffer.from(value) : Buffer.concat([buffer, Buffer.from(value)]);
        while (buffer.length >= TUNNEL_CHUNK_BYTES) {
          await sendChunk(buffer.subarray(0, TUNNEL_CHUNK_BYTES), false);
          buffer = buffer.subarray(TUNNEL_CHUNK_BYTES);
        }
        if (session.canceled) {
          await reader.cancel().catch(() => undefined);
          return;
        }
      }
      await sendChunk(buffer, true);
      this.deps.logger.debug('隧道 HTTP 响应完成', {
        id: session.id,
        method: session.method,
        path: reasonForLog(session.url),
        status: response.status,
        durationMs: Date.now() - session.startedAt,
      });
    } catch (error) {
      if (session.canceled) return;
      const message = error instanceof Error ? error.message : String(error);
      this.deps.logger.warn('隧道 HTTP 请求失败', {
        id: session.id,
        method: session.method,
        path: reasonForLog(session.url),
        error: message,
      });
      if (!headSent) {
        await this.sendErrorHead(
          session.id,
          send,
          502,
          'UPSTREAM_ERROR',
          'worker 内部请求失败',
          { stage: 'loopback' },
        );
      } else {
        // 已发送 head：按协议发送空 final chunk 并关闭该流。
        await this.safeSend(send, {
          kind: 'http-response',
          phase: 'chunk',
          id: session.id,
          seq: chunkSeq,
          chunkBase64: '',
          final: true,
        }).catch(() => undefined);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  /* ------------------------------ WS ------------------------------- */

  private handleWsOpen(frame: WsOpenRequestFrame, send: SendFrame): void {
    if (this.wsSessions.has(frame.id)) {
      throw new PanelError('BAD_REQUEST', `重复的 ws-open id：${frame.id}`);
    }
    if (this.wsSessions.size >= TUNNEL_MAX_WS_STREAMS) {
      void this.safeSend(send, {
        kind: 'ws-open',
        id: frame.id,
        accepted: false,
        status: 503,
        reason: 'too many ws streams',
      });
      return;
    }
    if (!frame.path.startsWith('/ws/') || frame.path.includes('\\') || /[\u0000-\u001f\u007f]/.test(frame.path)) {
      throw new PanelError('BAD_REQUEST', 'ws-open.path 必须是 /ws/ 开头的路径');
    }
    const wsPathname = frame.path.split('?', 1)[0] ?? frame.path;
    if (hasDotSegments(wsPathname) || /%2f|%5c/i.test(wsPathname)) {
      throw new PanelError('BAD_REQUEST', 'ws-open.path 不允许路径穿越或编码分隔符');
    }
    if (this.deps.hasWsRoute !== undefined && !this.deps.hasWsRoute(wsPathname)) {
      void this.safeSend(send, {
        kind: 'ws-open',
        id: frame.id,
        accepted: false,
        status: 404,
        reason: 'ws route not found',
      });
      return;
    }
    const separator = frame.path.includes('?') ? '&' : '?';
    const target = `ws://${this.deps.host}:${this.deps.port}${frame.path}${separator}token=${encodeURIComponent(this.deps.token)}`;
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(frame.headers)) {
      const lowered = name.toLowerCase();
      if (REQUEST_BLOCKED.has(lowered)) continue;
      if (lowered.startsWith('sec-websocket-')) continue;
      const items = headerValues(value);
      const first = items[0];
      if (first !== undefined) headers[lowered] = first;
    }
    let socket: WebSocket;
    try {
      socket = new WebSocket(target, frame.protocols ?? [], {
        headers,
        handshakeTimeout: 10_000,
        perMessageDeflate: false,
        maxPayload: WS_MAX_MESSAGE_BYTES,
        followRedirects: false,
      });
    } catch (error) {
      void this.safeSend(send, {
        kind: 'ws-open',
        id: frame.id,
        accepted: false,
        status: 502,
        reason: error instanceof Error ? error.message.slice(0, 200) : 'ws connect failed',
      });
      return;
    }
    const session: WsSession = {
      id: frame.id,
      socket,
      accepted: false,
      closeFromCore: false,
      seqOut: 0,
      seqIn: null,
      path: frame.path,
      outChain: Promise.resolve(),
      inChain: Promise.resolve(),
      pendingOutBytes: 0,
    };
    this.wsSessions.set(frame.id, session);

    let settled = false;
    const finishRejected = (status: number, reason: string): void => {
      if (settled) return;
      settled = true;
      this.wsSessions.delete(frame.id);
      this.rememberClosed(frame.id);
      void this.safeSend(send, {
        kind: 'ws-open',
        id: frame.id,
        accepted: false,
        status,
        reason: reason.slice(0, 200),
      });
      try {
        socket.terminate();
      } catch {
        // 已关闭。
      }
    };

    socket.on('unexpected-response', (_request, response) => {
      response.resume();
      finishRejected(response.statusCode ?? 502, `loopback ws status ${String(response.statusCode)}`);
    });

    socket.on('open', () => {
      if (settled) return;
      settled = true;
      session.accepted = true;
      void this.safeSend(send, { kind: 'ws-open', id: frame.id, accepted: true });
      socket.on('message', (data: RawData, isBinary: boolean) => {
        const bytes = rawBytes(data);
        if (bytes > WS_MAX_MESSAGE_BYTES) {
          void this.closeWsSession(session, send, 1013, 'message too big');
          return;
        }
        const payload: WsFrame = isBinary
          ? {
              kind: 'ws-frame',
              id: frame.id,
              data: toBuffer(data).toString('base64'),
              dataEncoding: 'base64',
              seq: session.seqOut,
            }
          : {
              kind: 'ws-frame',
              id: frame.id,
              data: toBuffer(data).toString('utf8'),
              dataEncoding: 'utf8',
              seq: session.seqOut,
            };
        session.seqOut += 1;
        const payloadBytes = typeof payload.data === 'string'
          ? Buffer.byteLength(payload.data, 'utf8')
          : Buffer.byteLength(payload.data);
        session.pendingOutBytes += payloadBytes;
        const task = session.outChain.then(() => this.safeSend(send, payload));
        session.outChain = task.catch(() => undefined);
        if (session.pendingOutBytes >= WS_BACKPRESSURE_HIGH && !socket.isPaused) {
          socket.pause();
        }
        void task.finally(() => {
          session.pendingOutBytes = Math.max(0, session.pendingOutBytes - payloadBytes);
          if (session.pendingOutBytes <= WS_BACKPRESSURE_LOW && socket.isPaused) {
            socket.resume();
          }
        });
      });
      socket.on('close', (code: number, reason: Buffer) => {
        this.wsSessions.delete(frame.id);
        this.rememberClosed(frame.id);
        if (!session.closeFromCore) {
          void this.safeSend(send, {
            kind: 'ws-close',
            id: frame.id,
            code: safeCloseCode(code),
            ...(reason.length === 0 ? {} : { reason: reason.toString('utf8').slice(0, 123) }),
            initiator: 'worker',
          });
        }
      });
      socket.on('error', (error: Error) => {
        this.deps.logger.debug('loopback WS 错误', { id: frame.id, error: error.message });
      });
    });

    socket.on('error', (error: Error) => {
      if (!settled) finishRejected(502, error.message);
      else this.deps.logger.debug('loopback WS 错误', { id: frame.id, error: error.message });
    });

    socket.on('close', (code: number) => {
      if (!settled) {
        this.wsSessions.delete(frame.id);
        this.rememberClosed(frame.id);
        finishRejected(502, `loopback ws closed before open (${String(code)})`);
      }
    });
  }

  private async handleWsFrame(frame: WsFrame, send: SendFrame): Promise<void> {
    const session = this.wsSessions.get(frame.id);
    if (session === undefined) {
      if (this.recentlyClosedWs.has(frame.id)) {
        this.deps.logger.debug('收到已关闭 WS 流的帧，丢弃', { id: frame.id });
        return;
      }
      throw new PanelError('BAD_REQUEST', `未知的 WS 流 id：${frame.id}`);
    }
    if (frame.seq !== undefined) {
      if (session.seqIn !== null && frame.seq !== session.seqIn + 1) {
        await this.closeWsSession(session, send, 1011, 'ws frame seq gap');
        return;
      }
      session.seqIn = frame.seq;
    }
    let payload: Buffer | string;
    if (frame.dataEncoding === 'base64') {
      payload = decodeBase64(frame.data, 'ws-frame.data');
    } else {
      payload = frame.data;
    }
    if (session.socket.readyState !== WebSocket.OPEN) return;
    const task = session.inChain.then(async () => {
      await this.waitLoopbackCapacity(session, send);
      if (session.socket.readyState !== WebSocket.OPEN) return;
      try {
        if (typeof payload === 'string') {
          session.socket.send(payload, { binary: false });
        } else {
          session.socket.send(payload, { binary: true });
        }
      } catch (error) {
        this.deps.logger.debug('写入 loopback WS 失败', {
          id: frame.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
    session.inChain = task.catch(() => undefined);
    await task.catch(() => undefined);
  }

  private async waitLoopbackCapacity(session: WsSession, send: SendFrame): Promise<void> {
    if (session.socket.bufferedAmount <= WS_BACKPRESSURE_HIGH) return;
    const deadline = Date.now() + WS_DRAIN_TIMEOUT_MS;
    while (
      session.socket.bufferedAmount > WS_BACKPRESSURE_LOW &&
      session.socket.readyState === WebSocket.OPEN
    ) {
      if (Date.now() > deadline) {
        await this.closeWsSession(session, send, 1013, 'loopback backpressure');
        return;
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 25);
        timer.unref?.();
      });
    }
  }

  private async handleWsClose(frame: WsCloseFrame): Promise<void> {
    const session = this.wsSessions.get(frame.id);
    if (session === undefined) {
      this.deps.logger.debug('收到未知 WS 流的 close，忽略', { id: frame.id });
      return;
    }
    session.closeFromCore = true;
    try {
      session.socket.close(
        safeCloseCode(frame.code),
        frame.reason === undefined ? undefined : frame.reason.slice(0, 123),
      );
    } catch {
      session.socket.terminate();
    }
  }

  private async closeWsSession(
    session: WsSession,
    send: SendFrame,
    code: number,
    reason: string,
  ): Promise<void> {
    this.wsSessions.delete(session.id);
    this.rememberClosed(session.id);
    session.closeFromCore = true;
    await this.safeSend(send, {
      kind: 'ws-close',
      id: session.id,
      code,
      reason: reason.slice(0, 123),
      initiator: 'worker',
    });
    try {
      session.socket.close(code, reason.slice(0, 123));
    } catch {
      session.socket.terminate();
    }
  }

  private async safeSend(send: SendFrame, frame: TunnelFrame): Promise<void> {
    try {
      await send(frame);
    } catch (error) {
      this.deps.logger.debug('隧道帧发送失败', {
        kind: frame.kind,
        id: 'id' in frame ? frame.id : undefined,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function rawBytes(data: RawData): number {
  return toBuffer(data).length;
}
