import { randomBytes } from 'node:crypto';
import { PassThrough, type Readable } from 'node:stream';
import {
  TUNNEL_CHUNK_BYTES,
  TUNNEL_HEARTBEAT_INTERVAL_MS,
  TUNNEL_HEARTBEAT_TIMEOUT_MS,
  TUNNEL_MAX_FRAME_BYTES,
  TUNNEL_MAX_INFLIGHT_REQUESTS,
  TUNNEL_MAX_WS_STREAMS,
  TUNNEL_PROTOCOL_VERSION,
  TUNNEL_REQUEST_TIMEOUT_MS,
  WS_CLOSE_CODES,
  WS_MAX_MESSAGE_BYTES,
  capabilitiesSchema,
  errorEnvelope,
  isPanelError,
  PanelError,
  type Capabilities,
  type HelloFrame,
  type HttpRequestChunkFrame,
  type HttpRequestHeadFrame,
  type HttpResponseChunkFrame,
  type HttpResponseHeadFrame,
  type MachineStatus,
  type MachineTransport,
  type TunnelFrame,
  type WorkerDescriptor,
  type WsCloseFrame,
  type WsFrame,
  type WsOpenReplyFrame,
  type WsOpenRequestFrame,
} from '@mpanel/shared';
import { constantTimeEqual } from '../machines/credentials.js';
import { CORE_VERSION } from '../system.js';
import type {
  DriverStatus,
  MachineHttpRequest,
  MachineHttpResponse,
  MachineRecord,
  MachineWsConnection,
  MachineWsOpenRequest,
} from '../machines/types.js';
import { sanitizeForwardHeaders, toTransportLogger } from './types.js';
import type { TransportDriver, TransportDriverDeps, TransportLogger } from './types.js';

/** core 自身在 hello/隧道里的名称；版本使用 system.ts 的单一来源。 */
const CORE_NAME = 'mpanel-core';

/** 单条 HTTP 流允许的最大未消费响应体缓冲（客户端过慢时保护内存）。 */
const MAX_BUFFERED_RESPONSE_BYTES = 32 * 1024 * 1024;
/** 请求排队上限（在 128 inflight 之外）。 */
const MAX_QUEUED_REQUESTS = 256;
/** hello 握手超时（协议：5 秒）。 */
const HELLO_TIMEOUT_MS = 5_000;

export interface TunnelChannel {
  /** Resolves after drain/backpressure. */
  send(frame: TunnelFrame): Promise<void>;
  close(code?: number, reason?: string): void;
  onFrame(cb: (frame: TunnelFrame) => void): void;
  onClose(cb: (code?: number, reason?: string) => void): void;
}

export type TunnelChannelFactory = () => Promise<TunnelChannel>;

export interface TunnelDriverOptions {
  /** 建立通道（stdio spawn）；reverse-ws 不提供，由 attachChannel() 注入。 */
  connect?: (machine: MachineRecord) => Promise<TunnelChannel>;
  /** 通道断开后是否自动重连（stdio 为 true）。 */
  autoRestart?: boolean;
  helloTimeoutMs?: number;
  requestTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  maxInflightRequests?: number;
  maxWsStreams?: number;
}

interface HelloWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

interface HttpWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

interface HttpFlow {
  id: string;
  method: string;
  url: string;
  body: PassThrough | null;
  resolve: (response: MachineHttpResponse) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  abortHandler?: () => void;
  headSeen: boolean;
  expectedSeq: number;
  timer?: NodeJS.Timeout;
  done: boolean;
  release: () => void;
}

interface WsFlow {
  id: string;
  state: 'opening' | 'open' | 'closed';
  openTimer?: NodeJS.Timeout;
  resolveOpen?: (connection: MachineWsConnection) => void;
  rejectOpen?: (error: Error) => void;
  messageCbs: Array<(data: string | Uint8Array, binary: boolean) => void>;
  closeCbs: Array<(code: number, reason: string) => void>;
  queued: Array<{ data: string | Uint8Array; binary: boolean }>;
  queuedBytes: number;
  inboundSeq?: number;
  closeFired: boolean;
}

interface TunnelState {
  machineId: string;
  machine?: MachineRecord;
  channel?: TunnelChannel;
  ready: boolean;
  status: MachineStatus;
  lastSeenAt: string | null;
  latencyMs?: number;
  consecutiveFailures: number;
  lastError?: string;
  worker?: WorkerDescriptor;
  capabilities?: Capabilities | null;
  helloWaiter?: HelloWaiter;
  helloTimer?: NodeJS.Timeout;
  heartbeat?: NodeJS.Timeout;
  lastInboundAt: number;
  manualStop: boolean;
  connecting?: Promise<void>;
  reconnectTimer?: NodeJS.Timeout;
  reconnectAttempts: number;
  protocolError?: string;
  pendingHttp: Map<string, HttpFlow>;
  waiters: HttpWaiter[];
  wsFlows: Map<string, WsFlow>;
  wsSeq: Map<string, number>;
}

/**
 * stdio 与 reverse-ws 共用的隧道驱动：帧编解码、HTTP 请求多路复用、
 * WS 流多路复用、hello 握手、心跳与断线处理都在这里实现。
 * 具体字节通道由 connect()（stdio）或 attachChannel()（reverse-ws）提供。
 */
export class TunnelTransportDriver implements TransportDriver {
  readonly kind: MachineTransport;

  private readonly states = new Map<string, TunnelState>();
  private counter = 0;

  private readonly helloTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly maxInflight: number;
  private readonly maxWsStreams: number;
  private readonly autoRestart: boolean;
  private readonly logger: TransportLogger;

  constructor(
    kind: MachineTransport,
    private readonly deps: TransportDriverDeps,
    private readonly options: TunnelDriverOptions = {},
  ) {
    this.kind = kind;
    this.logger = toTransportLogger(deps.logger);
    this.helloTimeoutMs = options.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? TUNNEL_REQUEST_TIMEOUT_MS;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? TUNNEL_HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? TUNNEL_HEARTBEAT_TIMEOUT_MS;
    this.maxInflight = options.maxInflightRequests ?? TUNNEL_MAX_INFLIGHT_REQUESTS;
    this.maxWsStreams = options.maxWsStreams ?? TUNNEL_MAX_WS_STREAMS;
    this.autoRestart = options.autoRestart ?? false;
  }

  /** 当前已就绪的隧道机器（reverse-ws 用于 agentSockets 概览）。 */
  connectedMachineIds(): string[] {
    const ids: string[] = [];
    for (const [machineId, state] of this.states) {
      if (state.ready && state.channel !== undefined) ids.push(machineId);
    }
    return ids;
  }

  async start(machine: MachineRecord): Promise<void> {
    const state = this.ensureState(machine.id);
    state.machine = machine;
    state.manualStop = false;
    if (state.ready) return;
    if (this.options.connect === undefined) {
      // reverse-ws：core 不主动拨号，等待 worker attach。
      if (state.status === 'offline' || state.status === 'error') state.status = 'starting';
      return;
    }
    await this.connectMachine(state, true);
  }

  async stop(machineId: string): Promise<void> {
    const state = this.states.get(machineId);
    if (state === undefined) return;
    state.manualStop = true;
    this.clearReconnect(state);
    this.stopHeartbeat(state);
    state.status = 'offline';
    state.ready = false;
    const channel = state.channel;
    state.channel = undefined;
    if (channel !== undefined) {
      channel.close(WS_CLOSE_CODES.GOING_AWAY, 'machine stopped');
    }
    this.failAllPending(state, WS_CLOSE_CODES.GOING_AWAY, '机器已停止');
    state.lastError = undefined;
    this.deps.events?.onOffline?.(machineId, '机器已停止', 'offline');
  }

  /** reverse-ws：app.ts 认证升级后，把 socket 交给对应机器。 */
  async attachChannel(machineId: string, channel: TunnelChannel): Promise<void> {
    const state = this.ensureState(machineId);
    state.manualStop = false;
    const previous = state.channel;
    state.channel = undefined;
    state.ready = false;
    if (previous !== undefined) {
      previous.close(WS_CLOSE_CODES.REPLACED, 'replaced by a new agent connection');
    }
    this.stopHeartbeat(state);
    await this.handshake(state, channel);
  }

  async request(machineId: string, req: MachineHttpRequest): Promise<MachineHttpResponse> {
    const state = this.requireReady(machineId);
    await this.acquireSlot(state, req.signal);

    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.releaseSlot(state);
    };

    const id = `h-${++this.counter}-${randomBytes(4).toString('hex')}`;
    return new Promise<MachineHttpResponse>((resolve, reject) => {
      const flow: HttpFlow = {
        id,
        method: req.method.toUpperCase(),
        url: req.path,
        body: null,
        resolve,
        reject,
        headSeen: false,
        expectedSeq: 0,
        done: false,
        release,
      };
      if (req.signal !== undefined) flow.signal = req.signal;
      state.pendingHttp.set(id, flow);

      if (req.signal !== undefined) {
        const onAbort = (): void => {
          this.cancelHttpFlow(state, flow, '客户端已取消请求');
        };
        flow.abortHandler = onAbort;
        req.signal.addEventListener('abort', onAbort, { once: true });
        if (req.signal.aborted) {
          onAbort();
          return;
        }
      } else {
        const timer = setTimeout(() => {
          this.cancelHttpFlow(state, flow, '上游请求超时');
        }, this.requestTimeoutMs);
        timer.unref?.();
        flow.timer = timer;
      }

      void this.sendRequestHead(state, flow, req).catch((error: unknown) => {
        this.failHttpFlow(state, flow, this.toPanelError(error, '发送隧道请求失败'));
      });
    });
  }

  async openWs(machineId: string, req: MachineWsOpenRequest): Promise<MachineWsConnection> {
    const state = this.requireReady(machineId);
    if (!req.path.startsWith('/ws/')) {
      throw new PanelError('BAD_REQUEST', 'WS 路径必须以 /ws/ 开头', { path: req.path });
    }
    if (state.wsFlows.size >= this.maxWsStreams) {
      throw new PanelError('UNAVAILABLE', '隧道 WS 流已达上限', {
        hint: '关闭部分终端/日志页面后重试，或等待空闲会话释放',
        machineId,
        limit: this.maxWsStreams,
      });
    }
    const channel = state.channel;
    if (channel === undefined) throw this.offlineError(machineId, 'offline');

    const id = `w-${++this.counter}-${randomBytes(4).toString('hex')}`;
    return new Promise<MachineWsConnection>((resolve, reject) => {
      const flow: WsFlow = {
        id,
        state: 'opening',
        messageCbs: [],
        closeCbs: [],
        queued: [],
        queuedBytes: 0,
        closeFired: false,
      };
      flow.resolveOpen = resolve;
      flow.rejectOpen = reject;
      state.wsFlows.set(id, flow);

      const timer = setTimeout(() => {
        this.rejectWsOpen(state, flow, new PanelError('UPSTREAM_ERROR', '上游 WS 握手超时', { machineId }));
      }, 15_000);
      timer.unref?.();
      flow.openTimer = timer;

      const frame: WsOpenRequestFrame = {
        kind: 'ws-open',
        id,
        path: req.path,
        headers: sanitizeForwardHeaders(req.headers, { forWs: true }),
      };
      if (req.protocols !== undefined && req.protocols.length > 0) {
        frame.protocols = req.protocols.slice(0, 16);
      }
      void channel.send(frame).catch((error: unknown) => {
        this.rejectWsOpen(state, flow, this.toPanelError(error, '发送 WS 打开请求失败'));
      });
    });
  }

  status(machineId: string): DriverStatus {
    const state = this.states.get(machineId);
    if (state === undefined) {
      return {
        status: 'offline',
        lastSeenAt: null,
        consecutiveFailures: 0,
      };
    }
    return {
      status: state.status,
      lastSeenAt: state.lastSeenAt,
      ...(state.latencyMs === undefined ? {} : { latencyMs: state.latencyMs }),
      consecutiveFailures: state.consecutiveFailures,
      ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
    };
  }

  /* ------------------------------------------------------------------ */
  /* 连接管理                                                            */
  /* ------------------------------------------------------------------ */

  private ensureState(machineId: string): TunnelState {
    const existing = this.states.get(machineId);
    if (existing !== undefined) return existing;
    const state: TunnelState = {
      machineId,
      ready: false,
      status: 'offline',
      lastSeenAt: null,
      consecutiveFailures: 0,
      lastInboundAt: 0,
      manualStop: false,
      reconnectAttempts: 0,
      pendingHttp: new Map(),
      waiters: [],
      wsFlows: new Map(),
      wsSeq: new Map(),
    };
    this.states.set(machineId, state);
    return state;
  }

  private async connectMachine(state: TunnelState, throwOnError: boolean): Promise<void> {
    if (state.connecting !== undefined) {
      return state.connecting;
    }
    const connect = this.options.connect;
    if (connect === undefined) return;

    const task = (async (): Promise<void> => {
      const machine = state.machine;
      if (machine === undefined) {
        throw new PanelError('INTERNAL', '缺少机器记录，无法建立隧道');
      }
      if (state.manualStop) {
        throw new PanelError('UNAVAILABLE', '机器已停止', {
          hint: '先 POST /api/v1/machines/:id/connect 再启动',
          machineId: machine.id,
        });
      }
      this.clearReconnect(state);
      state.status = 'starting';
      this.deps.events?.onStarting?.(machine.id);
      let channel: TunnelChannel;
      try {
        channel = await connect(machine);
      } catch (error) {
        this.noteConnectFailure(state, error);
        if (throwOnError) throw this.toPanelError(error, '启动 worker 失败');
        this.scheduleReconnect(state);
        return;
      }
      try {
        await this.handshake(state, channel);
      } catch (error) {
        this.noteConnectFailure(state, error);
        if (throwOnError) throw this.toPanelError(error, '隧道握手失败');
        this.scheduleReconnect(state);
      }
    })();

    state.connecting = task;
    try {
      await task;
    } finally {
      state.connecting = undefined;
    }
  }

  private noteConnectFailure(state: TunnelState, error: unknown): void {
    state.consecutiveFailures += 1;
    state.reconnectAttempts += 1;
    const message = error instanceof Error ? error.message : String(error);
    state.lastError = message;
    state.status = state.consecutiveFailures >= 5 ? 'error' : 'offline';
    this.logger.warn('机器隧道连接失败', {
      machineId: state.machineId,
      transport: this.kind,
      error: message,
      attempts: state.consecutiveFailures,
    });
    this.deps.events?.onOffline?.(state.machineId, message, state.status);
  }

  private scheduleReconnect(state: TunnelState): void {
    if (!this.autoRestart || state.manualStop || this.options.connect === undefined) return;
    if (state.reconnectTimer !== undefined) return;
    if (state.reconnectAttempts >= 5) {
      state.status = 'error';
      state.lastError = '连续 5 次重启失败，请手动连接';
      this.deps.events?.onOffline?.(state.machineId, state.lastError, 'error');
      return;
    }
    const attempt = Math.max(1, state.reconnectAttempts);
    const base = Math.min(1_000 * 2 ** (attempt - 1), 30_000);
    const jitter = 0.8 + Math.random() * 0.4;
    const delay = Math.round(base * jitter);
    const timer = setTimeout(() => {
      state.reconnectTimer = undefined;
      void this.connectMachine(state, false);
    }, delay);
    timer.unref?.();
    state.reconnectTimer = timer;
  }

  private clearReconnect(state: TunnelState): void {
    if (state.reconnectTimer !== undefined) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = undefined;
    }
  }

  private async handshake(state: TunnelState, channel: TunnelChannel): Promise<void> {
    state.channel = channel;
    state.ready = false;
    state.status = 'starting';
    state.lastInboundAt = Date.now();
    state.protocolError = undefined;

    channel.onFrame((frame) => {
      if (state.channel !== channel) return;
      state.lastInboundAt = Date.now();
      void this.handleFrame(state, channel, frame);
    });
    channel.onClose((code, reason) => {
      if (state.channel !== channel) return;
      this.handleChannelClose(state, channel, code, reason);
    });

    const waiter = new Promise<void>((resolve, reject) => {
      state.helloWaiter = { resolve, reject };
    });

    const timer = setTimeout(() => {
      state.helloTimer = undefined;
      void this.rejectHello(state, channel, WS_CLOSE_CODES.VERSION_MISMATCH, 'hello 超时');
      const pending = state.helloWaiter;
      state.helloWaiter = undefined;
      pending?.reject(
        new PanelError('UPSTREAM_ERROR', '等待 worker hello 超时', {
          hint: '确认 worker 进程已启动且 MPANEL_TRANSPORT 配置正确',
          machineId: state.machineId,
        }),
      );
    }, this.helloTimeoutMs);
    timer.unref?.();
    state.helloTimer = timer;

    try {
      await waiter;
    } finally {
      if (state.helloTimer !== undefined) {
        clearTimeout(state.helloTimer);
        state.helloTimer = undefined;
      }
    }
  }

  private handleChannelClose(
    state: TunnelState,
    channel: TunnelChannel,
    code?: number,
    reason?: string,
  ): void {
    if (state.channel !== channel) return;
    state.channel = undefined;
    state.ready = false;
    this.stopHeartbeat(state);
    if (state.helloTimer !== undefined) {
      clearTimeout(state.helloTimer);
      state.helloTimer = undefined;
    }
    const detail = reason === undefined || reason.length === 0 ? '隧道已断开' : reason;
    if (state.helloWaiter !== undefined) {
      state.helloWaiter.reject(new PanelError('UPSTREAM_ERROR', detail, { machineId: state.machineId }));
      state.helloWaiter = undefined;
    }
    const wasOnline = state.status === 'online';
    state.status = state.protocolError !== undefined ? 'error' : 'offline';
    state.lastError = state.protocolError ?? detail;
    if (!state.manualStop && wasOnline) state.consecutiveFailures += 1;
    this.failAllPending(state, code ?? WS_CLOSE_CODES.UPSTREAM_UNAVAILABLE, detail);
    this.logger.warn('机器隧道已断开', {
      machineId: state.machineId,
      transport: this.kind,
      code,
      reason: detail,
    });
    this.deps.events?.onOffline?.(state.machineId, state.lastError, state.status);
    if (this.autoRestart && !state.manualStop) this.scheduleReconnect(state);
  }

  private failAllPending(state: TunnelState, code: number, reason: string): void {
    for (const flow of [...state.pendingHttp.values()]) {
      this.cancelHttpFlow(state, flow, `隧道已断开：${reason}`);
    }
    for (const flow of [...state.wsFlows.values()]) {
      this.closeWsStream(state, flow, this.toSendableCloseCode(code), reason, false);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 帧处理                                                              */
  /* ------------------------------------------------------------------ */

  private async handleFrame(
    state: TunnelState,
    channel: TunnelChannel,
    frame: TunnelFrame,
  ): Promise<void> {
    if (!state.ready) {
      if (frame.kind === 'hello') {
        await this.handleHello(state, channel, frame);
        return;
      }
      await this.failProtocol(state, channel, `hello 之前收到 ${frame.kind} 帧`);
      return;
    }

    switch (frame.kind) {
      case 'hello':
        // 重复 hello 忽略（可能来自对端重连竞态）。
        return;
      case 'ping': {
        await this.safeSend(state, { kind: 'pong', id: frame.id, ts: frame.ts }).catch(() => undefined);
        return;
      }
      case 'pong': {
        state.latencyMs = Math.max(0, Date.now() - frame.ts);
        return;
      }
      case 'http-response': {
        if (frame.phase === 'chunk') this.handleHttpResponseChunk(state, frame);
        else this.handleHttpResponseHead(state, frame);
        return;
      }
      case 'ws-open': {
        if ('accepted' in frame) this.handleWsOpenReply(state, frame);
        return;
      }
      case 'ws-frame':
        this.handleWsFrame(state, frame);
        return;
      case 'ws-close':
        this.handleWsClose(state, frame);
        return;
      case 'http-request':
        this.logger.warn('收到 worker 主动发起的 http-request，已忽略', {
          machineId: state.machineId,
        });
        return;
      default:
        return;
    }
  }

  private async handleHello(
    state: TunnelState,
    channel: TunnelChannel,
    frame: HelloFrame,
  ): Promise<void> {
    if (state.ready) return;
    if (frame.v !== TUNNEL_PROTOCOL_VERSION) {
      await this.rejectHello(
        state,
        channel,
        WS_CLOSE_CODES.VERSION_MISMATCH,
        `协议版本不匹配（worker v=${frame.v}）`,
      );
      return;
    }
    if (frame.role !== 'worker') {
      await this.failProtocol(state, channel, 'hello role 非法');
      return;
    }
    if (frame.machineId !== undefined && frame.machineId !== state.machineId) {
      await this.rejectHello(
        state,
        channel,
        WS_CLOSE_CODES.FORBIDDEN,
        'hello machineId 与注册身份不一致',
      );
      return;
    }
    if (frame.worker !== undefined && frame.worker.protocolVersion !== TUNNEL_PROTOCOL_VERSION) {
      await this.rejectHello(
        state,
        channel,
        WS_CLOSE_CODES.VERSION_MISMATCH,
        `worker 协议版本不匹配（${frame.worker.protocolVersion}）`,
      );
      return;
    }

    if (this.kind === 'stdio') {
      const machine = state.machine;
      if (machine === undefined) {
        await this.rejectHello(state, channel, WS_CLOSE_CODES.FORBIDDEN, '缺少机器记录');
        return;
      }
      let expected: string;
      try {
        expected = await this.deps.credentials.getToken(machine);
      } catch (error) {
        await this.rejectHello(
          state,
          channel,
          WS_CLOSE_CODES.FORBIDDEN,
          error instanceof Error ? error.message : '机器 token 不可用',
        );
        return;
      }
      if (frame.token === undefined || !constantTimeEqual(frame.token, expected)) {
        await this.rejectHello(state, channel, WS_CLOSE_CODES.FORBIDDEN, 'worker token 校验失败');
        return;
      }
    }

    state.worker = frame.worker;
    state.capabilities =
      frame.worker?.capabilities === undefined ? null : parseCapabilities(frame.worker.capabilities);
    state.ready = true;
    state.status = 'online';
    state.lastSeenAt = new Date().toISOString();
    state.lastError = undefined;
    state.consecutiveFailures = 0;
    state.reconnectAttempts = 0;

    const reply: HelloFrame = {
      kind: 'hello',
      v: TUNNEL_PROTOCOL_VERSION,
      role: 'core',
      machineId: state.machineId,
      accepted: true,
      core: {
        name: CORE_NAME,
        version: CORE_VERSION,
        apiVersion: 1,
        protocolVersion: TUNNEL_PROTOCOL_VERSION,
      },
      protocol: {
        maxFrameBytes: TUNNEL_MAX_FRAME_BYTES,
        chunkBytes: TUNNEL_CHUNK_BYTES,
        maxInflightRequests: this.maxInflight,
        maxWsStreams: this.maxWsStreams,
      },
      sentAt: new Date().toISOString(),
    };
    const pending = state.helloWaiter;
    state.helloWaiter = undefined;
    pending?.resolve();
    try {
      await channel.send(reply);
    } catch (error) {
      this.logger.warn('回写 hello 失败', {
        machineId: state.machineId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    this.startHeartbeat(state);
    this.deps.events?.onOnline?.(state.machineId, {
      ...(state.worker === undefined ? {} : { worker: state.worker }),
      capabilities: state.capabilities ?? null,
      ...(state.latencyMs === undefined ? {} : { latencyMs: state.latencyMs }),
    });
    this.logger.info('机器隧道已就绪', {
      machineId: state.machineId,
      transport: this.kind,
      workerVersion: state.worker?.version,
    });
  }

  private async rejectHello(
    state: TunnelState,
    channel: TunnelChannel,
    closeCode: number,
    reason: string,
  ): Promise<void> {
    state.protocolError = reason;
    state.lastError = reason;
    try {
      await channel.send({
        kind: 'hello',
        v: TUNNEL_PROTOCOL_VERSION,
        role: 'core',
        machineId: state.machineId,
        accepted: false,
        reason,
        sentAt: new Date().toISOString(),
      });
    } catch {
      // 通道可能已关闭，忽略发送失败。
    }
    channel.close(closeCode, truncateReason(reason));
  }

  private async failProtocol(
    state: TunnelState,
    channel: TunnelChannel,
    reason: string,
  ): Promise<void> {
    state.protocolError = reason;
    this.logger.warn('隧道协议错误', { machineId: state.machineId, reason });
    channel.close(WS_CLOSE_CODES.PROTOCOL_ERROR, truncateReason(reason));
  }

  private startHeartbeat(state: TunnelState): void {
    this.stopHeartbeat(state);
    state.lastInboundAt = Date.now();
    const timer = setInterval(() => {
      if (!state.ready || state.channel === undefined) return;
      const silence = Date.now() - state.lastInboundAt;
      if (silence > this.heartbeatTimeoutMs) {
        this.logger.warn('隧道心跳超时', { machineId: state.machineId, silenceMs: silence });
        state.lastError = 'heartbeat timeout';
        state.channel.close(WS_CLOSE_CODES.UPSTREAM_UNAVAILABLE, 'heartbeat timeout');
        return;
      }
      const ping = { kind: 'ping' as const, id: `p-${++this.counter}`, ts: Date.now() };
      void this.safeSend(state, ping).catch(() => undefined);
    }, this.heartbeatIntervalMs);
    timer.unref?.();
    state.heartbeat = timer;
  }

  private stopHeartbeat(state: TunnelState): void {
    if (state.heartbeat !== undefined) {
      clearInterval(state.heartbeat);
      state.heartbeat = undefined;
    }
  }

  /* ------------------------------------------------------------------ */
  /* HTTP 流                                                             */
  /* ------------------------------------------------------------------ */

  private async sendRequestHead(
    state: TunnelState,
    flow: HttpFlow,
    req: MachineHttpRequest,
  ): Promise<void> {
    const channel = state.channel;
    if (channel === undefined) throw this.offlineError(state.machineId, state.status);
    const head: HttpRequestHeadFrame = {
      kind: 'http-request',
      id: flow.id,
      method: flow.method,
      url: flow.url,
      headers: sanitizeForwardHeaders(req.headers),
    };
    if (req.userId !== undefined) head.headers['x-mpanel-user'] = req.userId;
    if (req.body !== null) head.stream = true;
    if (req.remoteAddress !== undefined) head.remoteAddress = req.remoteAddress.slice(0, 128);
    await channel.send(head);
    if (req.body !== null) await this.pumpRequestBody(state, flow, req.body);
  }

  private async pumpRequestBody(state: TunnelState, flow: HttpFlow, body: Readable): Promise<void> {
    let seq = 0;
    let held: Buffer | null = null;
    try {
      for await (const chunk of body) {
        if (flow.done || state.channel === undefined) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        let offset = 0;
        while (offset < buffer.length) {
          const part = buffer.subarray(offset, offset + TUNNEL_CHUNK_BYTES);
          offset += part.length;
          if (held !== null) {
            await this.sendRequestChunk(state, flow, seq++, held, false);
          }
          held = part;
        }
      }
      if (flow.done || state.channel === undefined) return;
      await this.sendRequestChunk(state, flow, seq, held ?? Buffer.alloc(0), true);
    } catch (error) {
      // 请求体中段失败：通知 worker 中止 loopback 请求，避免其等待到超时。
      const channel = state.channel;
      if (channel !== undefined && !flow.done) {
        void channel
          .send({ kind: 'http-request', phase: 'cancel', id: flow.id, reason: 'request body failed' })
          .catch(() => undefined);
      }
      this.failHttpFlow(state, flow, this.toPanelError(error, '读取请求体失败'));
    }
  }

  private async sendRequestChunk(
    state: TunnelState,
    flow: HttpFlow,
    seq: number,
    chunk: Buffer,
    final: boolean,
  ): Promise<void> {
    const channel = state.channel;
    if (channel === undefined) throw this.offlineError(state.machineId, state.status);
    const frame: HttpRequestChunkFrame = {
      kind: 'http-request',
      phase: 'chunk',
      id: flow.id,
      seq,
      chunkBase64: chunk.toString('base64'),
      final,
    };
    await channel.send(frame);
  }

  private handleHttpResponseHead(state: TunnelState, frame: HttpResponseHeadFrame): void {
    const flow = state.pendingHttp.get(frame.id);
    if (flow === undefined) {
      if (frame.error !== undefined) {
        // 未能关联到请求的错误响应不静默丢弃，便于排查。
        this.logger.debug('收到未知请求 id 的错误响应头', { machineId: state.machineId, id: frame.id });
      }
      return;
    }
    if (flow.headSeen) return;
    flow.headSeen = true;
    const headers: Record<string, string | string[]> = { ...frame.headers };
    const body = new PassThrough();

    if (frame.error !== undefined) {
      const payload = Buffer.from(
        JSON.stringify(errorEnvelope(frame.error.code, frame.error.message, frame.error.details)),
        'utf8',
      );
      headers['content-type'] = 'application/json; charset=utf-8';
      headers['content-length'] = String(payload.length);
      body.end(payload);
      const status = frame.status >= 400 ? frame.status : 502;
      this.finishHttpHead(state, flow, status, headers, body, false);
      return;
    }

    if (frame.bodyBase64 !== undefined) {
      body.end(Buffer.from(frame.bodyBase64, 'base64'));
      this.finishHttpHead(state, flow, frame.status, headers, body, false);
      return;
    }

    if (frame.stream === true) {
      flow.body = body;
      this.finishHttpHead(state, flow, frame.status, headers, body, true);
      return;
    }

    body.end();
    this.finishHttpHead(state, flow, frame.status, headers, body, false);
  }

  private finishHttpHead(
    state: TunnelState,
    flow: HttpFlow,
    status: number,
    headers: Record<string, string | string[]>,
    body: PassThrough,
    streaming: boolean,
  ): void {
    flow.resolve({ status, headers, body });
    if (!streaming) this.completeHttpFlow(state, flow);
  }

  private handleHttpResponseChunk(state: TunnelState, frame: HttpResponseChunkFrame): void {
    const flow = state.pendingHttp.get(frame.id);
    if (flow === undefined) return;
    if (!flow.headSeen || flow.body === null) {
      this.failHttpFlow(
        state,
        flow,
        new PanelError('UPSTREAM_ERROR', '响应分块先于响应头到达', { machineId: state.machineId }),
      );
      return;
    }
    if (frame.seq !== flow.expectedSeq) {
      this.failHttpFlow(
        state,
        flow,
        new PanelError('UPSTREAM_ERROR', '上游响应分块乱序', {
          machineId: state.machineId,
          expectedSeq: flow.expectedSeq,
          receivedSeq: frame.seq,
        }),
      );
      return;
    }
    flow.expectedSeq += 1;
    const chunk = Buffer.from(frame.chunkBase64, 'base64');
    if (chunk.length > 0) {
      if (flow.body.readableLength + chunk.length > MAX_BUFFERED_RESPONSE_BYTES) {
        this.failHttpFlow(
          state,
          flow,
          new PanelError('UPSTREAM_ERROR', '上游响应过快，客户端消费过慢', {
            machineId: state.machineId,
            bufferedBytes: flow.body.readableLength,
          }),
        );
        return;
      }
      flow.body.write(chunk);
    }
    if (frame.final === true) this.completeHttpFlow(state, flow);
  }

  private completeHttpFlow(state: TunnelState, flow: HttpFlow): void {
    if (flow.done) return;
    flow.done = true;
    if (flow.timer !== undefined) clearTimeout(flow.timer);
    if (flow.signal !== undefined && flow.abortHandler !== undefined) {
      flow.signal.removeEventListener('abort', flow.abortHandler);
    }
    state.pendingHttp.delete(flow.id);
    if (flow.body !== null && !flow.body.writableEnded) flow.body.end();
    flow.release();
  }

  private failHttpFlow(state: TunnelState, flow: HttpFlow, error: PanelError): void {
    if (flow.done) return;
    flow.done = true;
    if (flow.timer !== undefined) clearTimeout(flow.timer);
    if (flow.signal !== undefined && flow.abortHandler !== undefined) {
      flow.signal.removeEventListener('abort', flow.abortHandler);
    }
    state.pendingHttp.delete(flow.id);
    this.logger.warn('隧道 HTTP 请求失败', {
      machineId: state.machineId,
      id: flow.id,
      method: flow.method,
      url: flow.url,
      error: error.message,
    });
    if (!flow.headSeen) {
      flow.reject(error);
    } else if (flow.body !== null) {
      flow.body.destroy(error);
    }
    flow.release();
  }

  private cancelHttpFlow(state: TunnelState, flow: HttpFlow, reason: string): void {
    if (flow.done) return;
    const channel = state.channel;
    if (channel !== undefined) {
      void channel
        .send({ kind: 'http-request', phase: 'cancel', id: flow.id, reason: truncateReason(reason) })
        .catch(() => undefined);
    }
    this.failHttpFlow(
      state,
      flow,
      new PanelError('UPSTREAM_ERROR', reason, { machineId: state.machineId, requestId: flow.id }),
    );
  }

  private async acquireSlot(state: TunnelState, signal?: AbortSignal): Promise<void> {
    if (state.pendingHttp.size < this.maxInflight) return;
    if (state.waiters.length >= MAX_QUEUED_REQUESTS) {
      throw new PanelError('UNAVAILABLE', '隧道请求队列已满', {
        hint: '等待当前机器的请求完成后再重试（并发上限 128，排队上限 256）',
        machineId: state.machineId,
      });
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: HttpWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.removeWaiter(state, waiter);
          reject(
            new PanelError('UNAVAILABLE', '隧道繁忙，排队超时', {
              hint: '稍后重试或减少并发请求',
              machineId: state.machineId,
            }),
          );
        }, 30_000),
      };
      waiter.timer.unref?.();
      if (signal !== undefined) {
        const onAbort = (): void => {
          this.removeWaiter(state, waiter);
          reject(
            new PanelError('UPSTREAM_ERROR', '客户端已取消排队中的请求', {
              machineId: state.machineId,
            }),
          );
        };
        waiter.signal = signal;
        waiter.abortHandler = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }
      state.waiters.push(waiter);
    });
  }

  private releaseSlot(state: TunnelState): void {
    if (state.waiters.length === 0) return;
    if (state.pendingHttp.size >= this.maxInflight) return;
    const waiter = state.waiters.shift();
    if (waiter === undefined) return;
    clearTimeout(waiter.timer);
    if (waiter.signal !== undefined && waiter.abortHandler !== undefined) {
      waiter.signal.removeEventListener('abort', waiter.abortHandler);
    }
    waiter.resolve();
  }

  private removeWaiter(state: TunnelState, waiter: HttpWaiter): void {
    clearTimeout(waiter.timer);
    if (waiter.signal !== undefined && waiter.abortHandler !== undefined) {
      waiter.signal.removeEventListener('abort', waiter.abortHandler);
    }
    const index = state.waiters.indexOf(waiter);
    if (index >= 0) state.waiters.splice(index, 1);
  }

  /* ------------------------------------------------------------------ */
  /* WS 流                                                               */
  /* ------------------------------------------------------------------ */

  private handleWsOpenReply(state: TunnelState, frame: WsOpenReplyFrame): void {
    const flow = state.wsFlows.get(frame.id);
    if (flow === undefined) return;
    if (flow.state !== 'opening') return;
    if (flow.openTimer !== undefined) {
      clearTimeout(flow.openTimer);
      flow.openTimer = undefined;
    }
    if (frame.accepted) {
      flow.state = 'open';
      const connection = this.buildWsConnection(state, flow);
      const resolve = flow.resolveOpen;
      flow.resolveOpen = undefined;
      flow.rejectOpen = undefined;
      resolve?.(connection);
      const queued = flow.queued.splice(0);
      flow.queuedBytes = 0;
      for (const item of queued) this.deliverWsMessage(flow, item.data, item.binary);
      return;
    }
    flow.state = 'closed';
    state.wsFlows.delete(flow.id);
    state.wsSeq.delete(flow.id);
    const reject = flow.rejectOpen;
    flow.resolveOpen = undefined;
    flow.rejectOpen = undefined;
    reject?.(mapWsReject(frame.status, frame.reason, state.machineId));
  }

  private rejectWsOpen(state: TunnelState, flow: WsFlow, error: PanelError): void {
    if (flow.state === 'closed') return;
    flow.state = 'closed';
    if (flow.openTimer !== undefined) clearTimeout(flow.openTimer);
    state.wsFlows.delete(flow.id);
    const reject = flow.rejectOpen;
    flow.resolveOpen = undefined;
    flow.rejectOpen = undefined;
    reject?.(error);
  }

  private handleWsFrame(state: TunnelState, frame: WsFrame): void {
    const flow = state.wsFlows.get(frame.id);
    if (flow === undefined) return;
    if (frame.seq !== undefined) {
      if (flow.inboundSeq !== undefined && frame.seq !== flow.inboundSeq + 1) {
        this.closeWsStream(state, flow, WS_CLOSE_CODES.INTERNAL, 'ws 帧序号缺口');
        return;
      }
      flow.inboundSeq = frame.seq;
    }
    const binary = frame.dataEncoding === 'base64';
    const data: string | Uint8Array = binary ? Buffer.from(frame.data, 'base64') : frame.data;
    this.deliverWsMessage(flow, data, binary);
  }

  private deliverWsMessage(flow: WsFlow, data: string | Uint8Array, binary: boolean): void {
    if (flow.closeFired || flow.state === 'closed') return;
    if (flow.messageCbs.length === 0) {
      const size = typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.byteLength;
      if (flow.queued.length >= 256 || flow.queuedBytes + size > WS_MAX_MESSAGE_BYTES) return;
      flow.queued.push({ data, binary });
      flow.queuedBytes += size;
      return;
    }
    for (const cb of flow.messageCbs) {
      try {
        cb(data, binary);
      } catch (error) {
        this.logger.warn('WS 消息回调异常', {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private buildWsConnection(state: TunnelState, flow: WsFlow): MachineWsConnection {
    return {
      send: (data: string | Uint8Array, binary: boolean): void => {
        if (flow.state !== 'open' || flow.closeFired) return;
        const seq = state.wsSeq.get(flow.id) ?? 0;
        state.wsSeq.set(flow.id, seq + 1);
        const frame: WsFrame = binary
          ? {
              kind: 'ws-frame',
              id: flow.id,
              data: Buffer.from(data as Uint8Array).toString('base64'),
              dataEncoding: 'base64',
              seq,
            }
          : { kind: 'ws-frame', id: flow.id, data: String(data), dataEncoding: 'utf8', seq };
        const size =
          frame.dataEncoding === 'base64'
            ? Buffer.byteLength(frame.data, 'base64')
            : Buffer.byteLength(frame.data, 'utf8');
        if (size > WS_MAX_MESSAGE_BYTES) {
          this.closeWsStream(state, flow, WS_CLOSE_CODES.BACKPRESSURE, 'message too large');
          return;
        }
        void this.safeSend(state, frame).catch((error: unknown) => {
          this.logger.warn('发送隧道 WS 帧失败', {
            machineId: state.machineId,
            id: flow.id,
            error: error instanceof Error ? error.message : String(error),
          });
          this.closeWsStream(state, flow, WS_CLOSE_CODES.INTERNAL, 'tunnel send failed');
        });
      },
      close: (code?: number, reason?: string): void => {
        this.closeWsStream(state, flow, code, reason);
      },
      onMessage: (cb: (data: string | Uint8Array, binary: boolean) => void): void => {
        flow.messageCbs.push(cb);
        if (flow.queued.length > 0) {
          const queued = flow.queued.splice(0);
          flow.queuedBytes = 0;
          for (const item of queued) {
            try {
              cb(item.data, item.binary);
            } catch {
              // 忽略单个回调异常，保持流可用。
            }
          }
        }
      },
      onClose: (cb: (code: number, reason: string) => void): void => {
        flow.closeCbs.push(cb);
      },
    };
  }

  private handleWsClose(state: TunnelState, frame: WsCloseFrame): void {
    const flow = state.wsFlows.get(frame.id);
    if (flow === undefined) return;
    this.closeWsStream(state, flow, frame.code, frame.reason, false);
  }

  private closeWsStream(
    state: TunnelState,
    flow: WsFlow,
    code?: number,
    reason?: string,
    notifyPeer = true,
  ): void {
    if (flow.closeFired) return;
    flow.closeFired = true;
    flow.state = 'closed';
    if (flow.openTimer !== undefined) clearTimeout(flow.openTimer);
    const channel = state.channel;
    if (notifyPeer && channel !== undefined) {
      void channel
        .send({
          kind: 'ws-close',
          id: flow.id,
          code: this.toSendableCloseCode(code),
          reason: truncateReason(reason ?? ''),
          initiator: 'core',
        })
        .catch(() => undefined);
    }
    state.wsFlows.delete(flow.id);
    state.wsSeq.delete(flow.id);
    const finalCode = this.toSendableCloseCode(code);
    const finalReason = reason ?? '';
    for (const cb of flow.closeCbs) {
      try {
        cb(finalCode, finalReason);
      } catch {
        // 关闭回调异常不影响隧道。
      }
    }
  }

  private toSendableCloseCode(code?: number): number {
    if (code === undefined) return WS_CLOSE_CODES.NORMAL;
    if (code === 1000 || code === 1001 || code === 1002 || code === 1003) return code;
    if (code >= 1007 && code <= 1014) return code;
    if (code >= 3000 && code <= 4999) return code;
    return WS_CLOSE_CODES.INTERNAL;
  }

  /* ------------------------------------------------------------------ */
  /* 工具                                                                */
  /* ------------------------------------------------------------------ */

  private requireReady(machineId: string): TunnelState {
    const state = this.states.get(machineId);
    if (state === undefined || state.channel === undefined || !state.ready) {
      throw this.offlineError(machineId, state?.status ?? 'offline');
    }
    return state;
  }

  private offlineError(machineId: string, status: MachineStatus): PanelError {
    return new PanelError('UNAVAILABLE', '机器当前不可用', {
      hint: '请确认机器在线（POST /api/v1/machines/:id/connect）并检查 /machines/:id/health',
      machineId,
      machineStatus: status,
    });
  }

  private async safeSend(state: TunnelState, frame: TunnelFrame): Promise<void> {
    const channel = state.channel;
    if (channel === undefined) throw this.offlineError(state.machineId, state.status);
    if (Buffer.byteLength(JSON.stringify(frame), 'utf8') > TUNNEL_MAX_FRAME_BYTES) {
      throw new PanelError('BAD_REQUEST', '隧道帧超过 16 MiB 上限', {
        kind: frame.kind,
        machineId: state.machineId,
      });
    }
    await channel.send(frame);
  }

  private toPanelError(error: unknown, fallbackMessage: string): PanelError {
    if (isPanelError(error)) return error;
    return new PanelError('UPSTREAM_ERROR', fallbackMessage, {
      reason: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
    });
  }
}

export function createTunnelDriver(
  kind: MachineTransport,
  deps: TransportDriverDeps,
  options?: TunnelDriverOptions,
): TunnelTransportDriver {
  return new TunnelTransportDriver(kind, deps, options);
}

function parseCapabilities(value: Record<string, unknown>): Capabilities | null {
  const parsed = capabilitiesSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function mapWsReject(status?: number, reason?: string, machineId?: string): PanelError {
  const message = reason !== undefined && reason.length > 0 ? reason : 'worker 拒绝了 WS 连接';
  switch (status) {
    case 401:
      return new PanelError('UNAUTHORIZED', message, { machineId });
    case 403:
      return new PanelError('FORBIDDEN', message, { machineId });
    case 404:
      return new PanelError('NOT_FOUND', message, { machineId });
    case 503:
      return new PanelError('UNAVAILABLE', message, {
        hint: '确认该 WS 端点对应的能力已在 worker 上可用',
        machineId,
      });
    default:
      return new PanelError('UPSTREAM_ERROR', message, { machineId, upstreamStatus: status });
  }
}

/** WS 关闭原因在协议中限制为 123 字节。 */
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
