import { Readable } from 'node:stream';
import WebSocket from 'ws';
import { PanelError, type MachineStatus } from '@mpanel/shared';
import type {
  DriverStatus,
  MachineHttpRequest,
  MachineHttpResponse,
  MachineRecord,
  MachineWsConnection,
  MachineWsOpenRequest,
} from '../machines/types.js';
import { sanitizeForwardHeaders, sanitizeResponseHeaders } from './types.js';
import type { TransportDriver, TransportDriverDeps } from './types.js';

const WS_OPEN_TIMEOUT_MS = 15_000;
const AUTH_STATUSES = new Set([401, 403]);

interface HttpState {
  machine: MachineRecord;
  status: MachineStatus;
  lastSeenAt: string | null;
  latencyMs?: number;
  consecutiveFailures: number;
  lastError?: string;
  sawSuccess: boolean;
}

/**
 * http 直连传输：core 以真实 HTTP/WS 反向代理 worker，注入 worker token。
 * 没有隧道、没有帧；路径与帧由 worker 原生协议处理。
 */
export function createHttpTransportDriver(deps: TransportDriverDeps): TransportDriver {
  const states = new Map<string, HttpState>();

  const requireState = (machineId: string): HttpState => {
    const state = states.get(machineId);
    if (state === undefined) {
      throw new PanelError('UNAVAILABLE', '机器传输尚未启动', {
        hint: '重新创建或 connect 该机器以初始化 http 传输',
        machineId,
      });
    }
    return state;
  };

  const noteSuccess = (state: HttpState, status: number, latencyMs: number): void => {
    state.latencyMs = latencyMs;
    if (AUTH_STATUSES.has(status)) {
      state.status = 'error';
      state.lastError = `worker 拒绝了机器令牌（HTTP ${status}）`;
      state.consecutiveFailures += 1;
      return;
    }
    if (status >= 500) {
      state.consecutiveFailures += 1;
      state.status = state.consecutiveFailures >= 3 ? 'offline' : 'degraded';
      state.lastError = `worker 返回 HTTP ${status}`;
      return;
    }
    state.sawSuccess = true;
    state.status = 'online';
    state.lastSeenAt = new Date().toISOString();
    state.consecutiveFailures = 0;
    state.lastError = undefined;
  };

  const noteFailure = (state: HttpState, error: unknown): void => {
    state.consecutiveFailures += 1;
    state.lastError = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
    state.status = state.consecutiveFailures >= 3 ? 'offline' : 'degraded';
  };

  const buildHttpUrl = (machine: MachineRecord, requestPath: string): string => {
    const endpoint = machine.endpoint;
    if (endpoint === null || endpoint.length === 0) {
      throw new PanelError('BAD_REQUEST', 'http 机器缺少 endpoint', {
        hint: '通过 PATCH /api/v1/machines/:id 设置 url',
        machineId: machine.id,
      });
    }
    return `${endpoint.replace(/\/+$/, '')}${requestPath}`;
  };

  const driver: TransportDriver = {
    kind: 'http',

    async start(machine: MachineRecord): Promise<void> {
      const state: HttpState = {
        machine,
        status: 'starting',
        lastSeenAt: null,
        consecutiveFailures: 0,
        sawSuccess: false,
      };
      states.set(machine.id, state);
      deps.events?.onStarting?.(machine.id);
    },

    async stop(machineId: string): Promise<void> {
      states.delete(machineId);
      deps.events?.onOffline?.(machineId, '机器已停止', 'offline');
    },

    async request(machineId: string, req: MachineHttpRequest): Promise<MachineHttpResponse> {
      const state = requireState(machineId);
      const startedAt = Date.now();
      const url = buildHttpUrl(state.machine, req.path);
      const token = await deps.credentials.getToken(state.machine);

      const headers = new Headers();
      for (const [name, value] of Object.entries(sanitizeForwardHeaders(req.headers))) {
        if (Array.isArray(value)) {
          for (const item of value) headers.append(name, item);
        } else {
          headers.set(name, value);
        }
      }
      headers.set('authorization', `Bearer ${token}`);
      headers.set('x-mpanel-request-id', req.requestId);
      if (req.userId !== undefined) headers.set('x-mpanel-user', req.userId);
      headers.set('accept-encoding', 'identity');

      const method = req.method.toUpperCase();
      const init: RequestInit & { duplex?: 'half' } = {
        method,
        headers,
        redirect: 'manual',
        signal: req.signal,
      };
      if (req.body !== null && method !== 'GET' && method !== 'HEAD') {
        init.body = Readable.toWeb(req.body) as unknown as ReadableStream<Uint8Array>;
        init.duplex = 'half';
      }

      let response: Response;
      try {
        response = await fetch(url, init);
      } catch (error) {
        noteFailure(state, error);
        if (req.signal?.aborted === true) {
          throw new PanelError('UPSTREAM_ERROR', '上游请求已取消或超时', { machineId });
        }
        throw new PanelError('UPSTREAM_ERROR', '无法连接 worker', {
          hint: '确认 worker 进程在运行且 url 可达',
          machineId,
          reason: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
        });
      }

      noteSuccess(state, response.status, Date.now() - startedAt);
      const headersOut = sanitizeResponseHeaders(response.headers);
      let body: Readable;
      if (response.body === null) {
        body = Readable.from([]);
      } else {
        body = Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream);
      }
      if (req.signal !== undefined) {
        req.signal.addEventListener(
          'abort',
          () => {
            body.destroy(new PanelError('UPSTREAM_ERROR', '上游请求已取消'));
          },
          { once: true },
        );
      }
      return { status: response.status, headers: headersOut, body };
    },

    async openWs(machineId: string, req: MachineWsOpenRequest): Promise<MachineWsConnection> {
      const state = requireState(machineId);
      if (!req.path.startsWith('/ws/')) {
        throw new PanelError('BAD_REQUEST', 'WS 路径必须以 /ws/ 开头', { path: req.path });
      }
      const endpoint = state.machine.endpoint;
      if (endpoint === null || endpoint.length === 0) {
        throw new PanelError('BAD_REQUEST', 'http 机器缺少 endpoint', {
          hint: '通过 PATCH /api/v1/machines/:id 设置 url',
          machineId,
        });
      }
      const token = await deps.credentials.getToken(state.machine);
      const wsUrl = toWsUrl(`${endpoint.replace(/\/+$/, '')}${req.path}`);

      const socket = new WebSocket(wsUrl, req.protocols ?? [], {
        headers: {
          authorization: `Bearer ${token}`,
          ...buildRequestIdHeader(req.headers),
        },
        handshakeTimeout: WS_OPEN_TIMEOUT_MS,
        perMessageDeflate: false,
        followRedirects: false,
      });

      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            cleanup();
            try {
              socket.terminate();
            } catch {
              // 忽略。
            }
            reject(
              new PanelError('UPSTREAM_ERROR', '连接 worker WS 超时', {
                hint: '确认 worker 的 /ws 路由与反向代理 Upgrade 配置',
                machineId,
              }),
            );
          }, WS_OPEN_TIMEOUT_MS);
          const cleanup = (): void => {
            clearTimeout(timer);
            socket.removeListener('open', onOpen);
            socket.removeListener('error', onError);
            socket.removeListener('unexpected-response', onUnexpected);
          };
          const onOpen = (): void => {
            cleanup();
            resolve();
          };
          const onError = (error: Error): void => {
            cleanup();
            reject(
              new PanelError('UPSTREAM_ERROR', '连接 worker WS 失败', {
                machineId,
                reason: error.message.slice(0, 300),
              }),
            );
          };
          const onUnexpected = (
            _request: import('node:http').ClientRequest,
            response: import('node:http').IncomingMessage,
          ): void => {
            cleanup();
            const status = response.statusCode ?? 0;
            try {
              socket.terminate();
            } catch {
              // 忽略。
            }
            if (status === 401 || status === 403) {
              state.status = 'error';
              state.lastError = `worker 拒绝了 WS 凭据（HTTP ${status}）`;
              state.consecutiveFailures += 1;
            }
            reject(
              status === 401 || status === 403
                ? new PanelError('UPSTREAM_ERROR', 'worker 拒绝了 WS 凭据', {
                    hint: '检查机器 token 与 worker 的 MPANEL_TOKEN 是否一致',
                    machineId,
                    stage: 'auth',
                    upstreamStatus: status,
                  })
                : new PanelError('UPSTREAM_ERROR', `worker WS 握手返回 ${status}`, {
                    machineId,
                    upstreamStatus: status,
                  }),
            );
          };
          socket.once('open', onOpen);
          socket.once('error', onError);
          socket.once('unexpected-response', onUnexpected);
        });
      } catch (error) {
        noteFailure(state, error);
        throw error;
      }

      noteSuccess(state, 101, 0);
      return new HttpWsConnection(socket);
    },

    status(machineId: string): DriverStatus {
      const state = states.get(machineId);
      if (state === undefined) {
        return { status: 'offline', lastSeenAt: null, consecutiveFailures: 0 };
      }
      return {
        status: state.status,
        lastSeenAt: state.lastSeenAt,
        ...(state.latencyMs === undefined ? {} : { latencyMs: state.latencyMs }),
        consecutiveFailures: state.consecutiveFailures,
        ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
      };
    },
  };

  return driver;
}

/** ws 连接包装：统一 send/close/onMessage/onClose，并缓冲早到的消息。 */
class HttpWsConnection implements MachineWsConnection {
  private readonly messageCbs: Array<(data: string | Uint8Array, binary: boolean) => void> = [];
  private readonly closeCbs: Array<(code: number, reason: string) => void> = [];
  private readonly queued: Array<{ data: string | Uint8Array; binary: boolean }> = [];
  private closed = false;
  private closeCode = 1000;
  private closeReason = '';

  constructor(private readonly socket: WebSocket) {
    socket.on('message', (data: import('ws').RawData, isBinary: boolean) => {
      const payload: string | Uint8Array = isBinary ? toBuffer(data) : toBuffer(data).toString('utf8');
      if (this.messageCbs.length === 0) {
        if (this.queued.length < 256) this.queued.push({ data: payload, binary: isBinary });
        return;
      }
      for (const cb of this.messageCbs) {
        try {
          cb(payload, isBinary);
        } catch {
          // 忽略单个回调异常。
        }
      }
    });
    socket.on('close', (code: number, reason: Buffer) => {
      this.closed = true;
      this.closeCode = code;
      this.closeReason = reason.toString('utf8');
      for (const cb of this.closeCbs) {
        try {
          cb(code, this.closeReason);
        } catch {
          // 忽略。
        }
      }
    });
    socket.on('error', (error: Error) => {
      if (this.closed) return;
      this.closed = true;
      this.closeCode = 1011;
      this.closeReason = error.message.slice(0, 123);
      for (const cb of this.closeCbs) {
        try {
          cb(1011, this.closeReason);
        } catch {
          // 忽略。
        }
      }
    });
  }

  send(data: string | Uint8Array, binary: boolean): void {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(data, { binary });
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code ?? 1000;
    this.closeReason = reason ?? '';
    const sendable =
      code === 1000 || code === 1001 || code === 1002 || code === 1003 || (code !== undefined && code >= 1007 && code <= 4999)
        ? code
        : 1011;
    try {
      this.socket.close(sendable, truncateUtf8(reason ?? '', 123));
    } catch {
      this.socket.terminate();
    }
  }

  onMessage(cb: (data: string | Uint8Array, binary: boolean) => void): void {
    this.messageCbs.push(cb);
    if (this.queued.length > 0) {
      const pending = this.queued.splice(0);
      for (const item of pending) {
        try {
          cb(item.data, item.binary);
        } catch {
          // 忽略。
        }
      }
    }
  }

  onClose(cb: (code: number, reason: string) => void): void {
    this.closeCbs.push(cb);
    if (this.closed) {
      const code = this.closeCode;
      const reason = this.closeReason;
      queueMicrotask(() => cb(code, reason));
    }
  }
}

function toBuffer(data: import('ws').RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

function toWsUrl(httpUrl: string): string {
  return httpUrl.replace(/^http(s)?:/i, (_match, secure: string | undefined) =>
    secure === undefined ? 'ws:' : 'wss:',
  );
}

function buildRequestIdHeader(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const value = headers['x-mpanel-request-id'];
  if (typeof value === 'string' && value.length > 0) return { 'x-mpanel-request-id': value };
  return {};
}

/** ws 关闭原因限制 123 字节（按 UTF-8 字节截断）。 */
function truncateUtf8(value: string, maxBytes: number): string {
  let result = '';
  let bytes = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    result += char;
  }
  return result;
}
