import type { IncomingMessage, ClientRequest } from 'node:http';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import {
  PanelError,
  TUNNEL_HEARTBEAT_INTERVAL_MS,
  TUNNEL_HEARTBEAT_TIMEOUT_MS,
  TUNNEL_MAX_FRAME_BYTES,
  TUNNEL_PROTOCOL_VERSION,
  TUNNEL_SUBPROTOCOL,
  WS_CLOSE_CODES,
  decodeTunnelFrame,
  encodeTunnelFrame,
} from '@mpanel/shared';
import type {
  HelloFrame,
  PingFrame,
  PongFrame,
  ProtocolLimits,
  TunnelFrame,
} from '@mpanel/shared';
import type { WorkerTransport, WorkerTransportDeps } from './types.js';
import { TRANSPORT_LOOPBACK_HOST } from './types.js';
import { TunnelBridge } from './tunnel-bridge.js';
import { describeWorker } from '../registry.js';
import type { WorkerLogger } from '../logger.js';

/**
 * reverse-ws 传输：worker 主动拨号 core 的 `/ws/worker`。loopback 只绑定
 * 127.0.0.1:0；隧道身份用 machine secret（Authorization: Bearer），与
 * MPANEL_TOKEN 是两个独立凭据。指数退避 1s→30s（±20%），心跳 10s/30s。
 */

export interface ReverseWsChannel {
  send(frame: TunnelFrame): Promise<void>;
  close(code?: number, reason?: string): void;
  onFrame(cb: (frame: TunnelFrame) => void): void;
  onClose(cb: (code?: number, reason?: string) => void): void;
}

export interface ReverseWsChannelOptions {
  logger?: WorkerLogger;
  maxFrameBytes?: number;
  onProtocolError?: (error: Error) => void;
}

const HANDSHAKE_TIMEOUT_MS = 5_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const BACKOFF_JITTER = 0.2;
const SEND_BACKPRESSURE_LOW = 1024 * 1024;
const SEND_DRAIN_TIMEOUT_MS = 30_000;

const DEFAULT_PROTOCOL: ProtocolLimits = {
  maxFrameBytes: TUNNEL_MAX_FRAME_BYTES,
  chunkBytes: 512 * 1024,
  maxInflightRequests: 128,
  maxWsStreams: 64,
};

function rawBytes(data: RawData): number {
  if (Buffer.isBuffer(data)) return data.length;
  if (Array.isArray(data)) return data.reduce((total, chunk) => total + chunk.length, 0);
  return Buffer.byteLength(data);
}

function safeCloseCode(code: number | undefined): number {
  if (code === undefined) return 1000;
  if (code === 1005 || code === 1006 || code === 1015) return 1011;
  if (code < 1000) return 1011;
  if (code > 4999) return 4999;
  return code;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function waitForSendCapacity(socket: WebSocket, logger?: WorkerLogger): Promise<void> {
  if (socket.bufferedAmount <= SEND_BACKPRESSURE_LOW) return;
  const deadline = Date.now() + SEND_DRAIN_TIMEOUT_MS;
  while (socket.bufferedAmount > SEND_BACKPRESSURE_LOW) {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (Date.now() > deadline) {
      logger?.warn('reverse-ws 写背压超时，关闭隧道', {
        bufferedAmount: socket.bufferedAmount,
      });
      socket.close(WS_CLOSE_CODES.BACKPRESSURE, 'backpressure');
      return;
    }
    await delay(25);
  }
}

/** 把 MPANEL_CORE_URL 规范化为 `/ws/worker` 的 ws(s) 地址。 */
export function normalizeCoreWsUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PanelError('BAD_REQUEST', `MPANEL_CORE_URL 不是合法 URL：${raw}`);
  }
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new PanelError('BAD_REQUEST', `MPANEL_CORE_URL 只支持 http/https/ws/wss：${raw}`);
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = pathname.endsWith('/ws/worker') || pathname === '/ws/worker'
    ? pathname
    : `${pathname}/ws/worker`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

/**
 * 把一条已建立的 WebSocket 包装成隧道通道。消息必须是一条完整 JSON 帧；
 * 二进制消息直接按协议关闭。
 */
export function createReverseWsChannel(
  socket: WebSocket,
  options: ReverseWsChannelOptions = {},
): ReverseWsChannel {
  const maxFrameBytes = options.maxFrameBytes ?? TUNNEL_MAX_FRAME_BYTES;
  let frameHandler: ((frame: TunnelFrame) => void) | null = null;
  let closeHandler: ((code?: number, reason?: string) => void) | null = null;
  let closed = false;
  let sendChain: Promise<void> = Promise.resolve();

  const fail = (error: Error, code = 1002, reason = 'protocol error'): void => {
    options.onProtocolError?.(error);
    try {
      socket.close(safeCloseCode(code), reason.slice(0, 123));
    } catch {
      socket.terminate();
    }
  };

  socket.on('message', (data: RawData, isBinary: boolean) => {
    if (closed) return;
    if (isBinary) {
      options.logger?.warn('reverse-ws 收到二进制消息，按协议关闭 1003');
      fail(new PanelError('BAD_REQUEST', 'reverse-ws 不接受二进制消息'), 1003, 'unsupported data');
      return;
    }
    const bytes = rawBytes(data);
    if (bytes > maxFrameBytes) {
      fail(new PanelError('BAD_REQUEST', '隧道帧超过 16 MiB 上限'), 1013, 'frame too large');
      return;
    }
    const text = Buffer.isBuffer(data)
      ? data.toString('utf8')
      : Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : Buffer.from(data).toString('utf8');
    let frame: TunnelFrame;
    try {
      frame = decodeTunnelFrame(text);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    frameHandler?.(frame);
  });

  socket.on('close', (code: number, reason: Buffer) => {
    if (closed) return;
    closed = true;
    closeHandler?.(safeCloseCode(code), reason.toString('utf8'));
  });

  socket.on('error', (error: Error) => {
    options.logger?.debug('reverse-ws 连接错误', { error: error.message });
  });

  return {
    send(frame: TunnelFrame): Promise<void> {
      const task = sendChain.then(async () => {
        if (closed || socket.readyState !== WebSocket.OPEN) {
          throw new PanelError('UNAVAILABLE', 'reverse-ws 隧道未连接', {
            hint: 'core 不在线；worker 会按指数退避自动重连。',
          });
        }
        const encoded = encodeTunnelFrame(frame);
        if (Buffer.byteLength(encoded, 'utf8') > maxFrameBytes) {
          throw new PanelError('BAD_REQUEST', '待发送的隧道帧超过 16 MiB 上限', {
            frameKind: frame.kind,
          });
        }
        await waitForSendCapacity(socket, options.logger);
        if (closed || socket.readyState !== WebSocket.OPEN) {
          throw new PanelError('UNAVAILABLE', 'reverse-ws 隧道在发送前断开');
        }
        await new Promise<void>((resolve, reject) => {
          socket.send(encoded, { binary: false }, (error?: Error | null) => {
            if (error === null || error === undefined) resolve();
            else reject(error);
          });
        });
      });
      sendChain = task.catch(() => undefined);
      return task;
    },
    close(code?: number, reason?: string): void {
      if (closed) return;
      try {
        socket.close(safeCloseCode(code), reason === undefined ? undefined : reason.slice(0, 123));
      } catch {
        socket.terminate();
      }
    },
    onFrame(cb: (frame: TunnelFrame) => void): void {
      frameHandler = cb;
    },
    onClose(cb: (code?: number, reason?: string) => void): void {
      closeHandler = cb;
      if (closed) cb(1000, 'closed');
    },
  };
}

function backoffDelay(attempt: number): number {
  const exponential = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
  const jitter = 1 + (Math.random() * 2 - 1) * BACKOFF_JITTER;
  return Math.max(500, Math.min(BACKOFF_MAX_MS, Math.round(exponential * jitter)));
}

/** reverse-ws 传输实现。start 只保证 loopback 已监听；连接由后台循环维护。 */
export function createReverseWsTransport(deps: WorkerTransportDeps): WorkerTransport {
  const { app, config, logger } = deps;
  let bridge: TunnelBridge | null = null;
  let socket: WebSocket | null = null;
  let channel: ReverseWsChannel | null = null;
  let stopped = false;
  let stopResolve: (() => void) | null = null;
  const stoppedPromise = new Promise<void>((resolve) => {
    stopResolve = resolve;
  });
  let reconnectTimer: NodeJS.Timeout | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let handshakeTimer: NodeJS.Timeout | null = null;
  let attempt = 0;
  let lastInbound = Date.now();
  let pingCounter = 0;
  let generation = 0;

  const clearTimers = (): void => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (handshakeTimer !== null) {
      clearTimeout(handshakeTimer);
      handshakeTimer = null;
    }
  };

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    generation += 1;
    clearTimers();
    channel?.close(WS_CLOSE_CODES.NORMAL, 'worker stopping');
    channel = null;
    bridge?.closeAll();
    bridge = null;
    try {
      socket?.terminate();
    } catch {
      // 已关闭。
    }
    socket = null;
    try {
      await app.close();
    } catch (error) {
      logger.debug('reverse-ws 关闭 Fastify 失败', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    stopResolve?.();
  };

  const scheduleReconnect = (reason: string): void => {
    if (stopped) return;
    clearTimers();
    attempt += 1;
    const delayMs = backoffDelay(attempt);
    logger.warn('reverse-ws 断线，稍后重连', {
      attempt,
      delayMs,
      reason,
    });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delayMs);
  };

  const startHeartbeat = (): void => {
    if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
    lastInbound = Date.now();
    heartbeatTimer = setInterval(() => {
      if (stopped) return;
      const current = socket;
      if (current === null || current.readyState !== WebSocket.OPEN) return;
      if (Date.now() - lastInbound > TUNNEL_HEARTBEAT_TIMEOUT_MS) {
        logger.warn('reverse-ws 心跳超时，关闭并重连', {
          timeoutMs: TUNNEL_HEARTBEAT_TIMEOUT_MS,
        });
        try {
          current.close(WS_CLOSE_CODES.BACKPRESSURE, 'heartbeat timeout');
        } catch {
          current.terminate();
        }
        return;
      }
      pingCounter += 1;
      const ping: PingFrame = {
        kind: 'ping',
        id: `w-hb-${pingCounter}`,
        ts: Date.now(),
      };
      void channel?.send(ping).catch((error: unknown) => {
        logger.debug('reverse-ws 心跳发送失败', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, TUNNEL_HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref?.();
  };

  const connect = async (): Promise<void> => {
    if (stopped) return;
    const coreUrl = config.coreUrl;
    const secret = config.machineSecret;
    if (coreUrl === undefined || secret === undefined) {
      logger.error('reverse-ws 缺少 coreUrl 或 machineSecret');
      scheduleReconnect('configuration');
      return;
    }
    let wsUrl: string;
    try {
      wsUrl = normalizeCoreWsUrl(coreUrl);
    } catch (error) {
      logger.error('reverse-ws core URL 非法', {
        error: error instanceof Error ? error.message : String(error),
      });
      void stop();
      return;
    }
    const currentGeneration = generation;
    logger.info('reverse-ws 正在拨号 core', { url: wsUrl.replace(/\/\/[^/]+/, '//…') });
    let current: WebSocket;
    try {
      current = new WebSocket(wsUrl, [TUNNEL_SUBPROTOCOL], {
        headers: { authorization: `Bearer ${secret}` },
        handshakeTimeout: 15_000,
        perMessageDeflate: false,
        maxPayload: TUNNEL_MAX_FRAME_BYTES,
        followRedirects: false,
        rejectUnauthorized: !config.insecureCoreTls,
      });
    } catch (error) {
      scheduleReconnect(error instanceof Error ? error.message : String(error));
      return;
    }
    socket = current;
    let accepted = false;
    let settled = false;
    let reconnectScheduled = false;

    const closeWithReconnect = (reason: string): void => {
      if (stopped || generation !== currentGeneration || reconnectScheduled) return;
      reconnectScheduled = true;
      scheduleReconnect(reason);
    };

    current.on('unexpected-response', (_request: ClientRequest, response: IncomingMessage) => {
      response.resume();
      const status = response.statusCode ?? 0;
      const hint =
        status === 401 || status === 403
          ? '机器 secret 被拒绝：确认 core 上的机器记录仍启用且 secret 未轮换。'
          : 'core 拒绝 WebSocket 升级；检查 URL 路径与反向代理 Upgrade 头。';
      logger.error('reverse-ws 注册被 core 拒绝', { status, hint });
      try {
        current.terminate();
      } catch {
        // 已关闭。
      }
      closeWithReconnect(`http ${String(status)}`);
    });

    current.on('open', () => {
      if (stopped || generation !== currentGeneration) {
        current.close(WS_CLOSE_CODES.GOING_AWAY, 'stale connection');
        return;
      }
      if (current.protocol !== TUNNEL_SUBPROTOCOL) {
        logger.error('core 未选择 mpanel.tunnel.v1 子协议，关闭连接 4002', {
          negotiated: current.protocol,
        });
        current.close(WS_CLOSE_CODES.VERSION_MISMATCH, 'subprotocol mismatch');
        closeWithReconnect('subprotocol mismatch');
        return;
      }
      const capabilities = app.mpanel.capabilities.snapshot();
      const hello: HelloFrame = {
        kind: 'hello',
        v: TUNNEL_PROTOCOL_VERSION,
        role: 'worker',
        ...(config.machineId === undefined ? {} : { machineId: config.machineId }),
        worker: describeWorker(capabilities),
        protocol: DEFAULT_PROTOCOL,
        sentAt: new Date().toISOString(),
      };
      const wsChannel = createReverseWsChannel(current, {
        logger: logger.child({ component: 'reverse-ws-channel' }),
        maxFrameBytes: TUNNEL_MAX_FRAME_BYTES,
        onProtocolError: (error: Error) => {
          logger.error('reverse-ws 协议错误', { error: error.message });
        },
      });
      channel = wsChannel;
      wsChannel.onFrame((frame: TunnelFrame) => {
        lastInbound = Date.now();
        if (!accepted) {
          if (frame.kind !== 'hello') {
            logger.error('reverse-ws 在 hello 之前收到其他帧，关闭连接', {
              kind: frame.kind,
            });
            wsChannel.close(WS_CLOSE_CODES.PROTOCOL_ERROR, 'expected hello');
            return;
          }
          if (frame.v !== TUNNEL_PROTOCOL_VERSION) {
            logger.error('core 协议版本不匹配，关闭 4002', {
              version: frame.v,
              expected: TUNNEL_PROTOCOL_VERSION,
            });
            wsChannel.close(WS_CLOSE_CODES.VERSION_MISMATCH, 'version mismatch');
            return;
          }
          if (frame.accepted !== true) {
            logger.error('core 拒绝 worker hello', {
              ...(frame.reason === undefined ? {} : { reason: frame.reason }),
            });
            wsChannel.close(WS_CLOSE_CODES.FORBIDDEN, 'hello rejected');
            return;
          }
          accepted = true;
          settled = true;
          attempt = 0;
          if (handshakeTimer !== null) {
            clearTimeout(handshakeTimer);
            handshakeTimer = null;
          }
          lastInbound = Date.now();
          startHeartbeat();
          logger.info('reverse-ws 隧道握手成功', {
            ...(frame.machineId === undefined ? {} : { machineId: frame.machineId }),
            ...(frame.core === undefined
              ? {}
              : { coreName: frame.core.name, coreVersion: frame.core.version }),
          });
          return;
        }
        if (frame.kind === 'ping') {
          const pong: PongFrame = { kind: 'pong', id: frame.id, ts: frame.ts };
          void wsChannel.send(pong).catch((error: unknown) => {
            logger.debug('reverse-ws pong 发送失败', {
              error: error instanceof Error ? error.message : String(error),
            });
          });
          return;
        }
        if (frame.kind === 'pong' || frame.kind === 'hello') return;
        const task = bridge?.handleFrame(frame, (out: TunnelFrame) => wsChannel.send(out));
        if (task === undefined) return;
        void task.catch((error: unknown) => {
          logger.error('reverse-ws 隧道协议错误，关闭连接', {
            kind: frame.kind,
            error: error instanceof Error ? error.message : String(error),
          });
          wsChannel.close(WS_CLOSE_CODES.PROTOCOL_ERROR, 'protocol error');
        });
      });
      wsChannel.onClose((code?: number, reason?: string) => {
        if (stopped || generation !== currentGeneration) return;
        if (heartbeatTimer !== null) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        bridge?.closeAll();
        if (channel === wsChannel) channel = null;
        if (socket === current) socket = null;
        logger.warn('reverse-ws 连接关闭', { code, reason, accepted });
        closeWithReconnect('connection closed');
      });
      handshakeTimer = setTimeout(() => {
        if (accepted || stopped || generation !== currentGeneration) return;
        logger.error('reverse-ws 等待 core hello 超时，关闭 4002');
        wsChannel.close(WS_CLOSE_CODES.VERSION_MISMATCH, 'hello timeout');
      }, HANDSHAKE_TIMEOUT_MS);
      handshakeTimer.unref?.();
      void wsChannel.send(hello).catch((error: unknown) => {
        logger.error('reverse-ws hello 发送失败', {
          error: error instanceof Error ? error.message : String(error),
        });
        wsChannel.close(WS_CLOSE_CODES.INTERNAL, 'hello send failed');
      });
    });

    current.on('error', (error: Error) => {
      logger.debug('reverse-ws 连接错误', { error: error.message });
      if (!settled && !accepted) {
        settled = true;
        bridge?.closeAll();
        if (socket === current) socket = null;
        closeWithReconnect(error.message);
      }
    });

    current.on('close', (code: number) => {
      if (stopped || generation !== currentGeneration) return;
      bridge?.closeAll();
      if (socket === current) socket = null;
      if (handshakeTimer !== null) {
        clearTimeout(handshakeTimer);
        handshakeTimer = null;
      }
      if (!accepted) {
        closeWithReconnect(`closed before hello (${String(code)})`);
      }
    });
  };

  const start = async (): Promise<void> => {
    if (stopped) throw new PanelError('CONFLICT', 'reverse-ws 传输已停止');
    if (config.coreUrl === undefined) {
      throw new PanelError('CONFLICT', 'reverse-ws 传输需要 MPANEL_CORE_URL');
    }
    if (config.machineSecret === undefined) {
      throw new PanelError('CONFLICT', 'reverse-ws 传输需要 MPANEL_MACHINE_SECRET');
    }
    await app.listen({ host: TRANSPORT_LOOPBACK_HOST, port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') {
      await app.close().catch(() => undefined);
      throw new PanelError('INTERNAL', '无法获取 loopback 端口');
    }
    bridge = new TunnelBridge({
      token: config.token,
      logger: logger.child({ component: 'tunnel-bridge' }),
      host: TRANSPORT_LOOPBACK_HOST,
      port: address.port,
      hasWsRoute: (pathname: string) => app.mpanel.wsBridge.hasRoute(pathname),
    });
    logger.debug('reverse-ws loopback 已监听', {
      host: TRANSPORT_LOOPBACK_HOST,
      port: address.port,
    });
    void connect();
  };

  return {
    kind: 'reverse-ws',
    start,
    stop,
    waitForStop: () => stoppedPromise,
  };
}
