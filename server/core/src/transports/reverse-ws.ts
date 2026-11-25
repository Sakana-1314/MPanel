import { PanelError, decodeTunnelFrame, TUNNEL_MAX_FRAME_BYTES, type TunnelFrame } from '@mpanel/shared';
import type { WebSocket, RawData } from 'ws';
import {
  TunnelTransportDriver,
  createTunnelDriver,
  type TunnelChannel,
} from './tunnel.js';
import type { TransportDriverDeps } from './types.js';
import { toTransportLogger } from './types.js';

const SEND_TIMEOUT_MS = 30_000;
/** reverse-ws 有连接后仍需等待 worker hello 的时间由驱动控制（5s）。 */
export interface ReverseWsChannelOptions {
  socket: WebSocket;
  machineId?: string;
}

export interface ReverseWsTransportDriver extends TunnelTransportDriver {
  attach(
    machineId: string,
    socket: WebSocket,
    req: import('node:http').IncomingMessage,
  ): Promise<void>;
  attachedMachineIds(): string[];
}

/**
 * 把 app.ts 已完成认证/升级的 WebSocket 适配成 TunnelChannel。
 * 每条 text message 必须恰好是一个 JSON 帧；binary 消息关闭 1003。
 */
export function createReverseWsChannel(options: ReverseWsChannelOptions): TunnelChannel {
  return new ReverseWsChannel(options);
}

class ReverseWsChannel implements TunnelChannel {
  private readonly socket: WebSocket;
  private readonly frameCbs: Array<(frame: TunnelFrame) => void> = [];
  private readonly closeCbs: Array<(code?: number, reason?: string) => void> = [];
  private readonly earlyFrames: TunnelFrame[] = [];
  private closed = false;
  private closeCode: number | undefined;
  private closeReason: string | undefined;

  constructor(options: ReverseWsChannelOptions) {
    this.socket = options.socket;
    this.socket.on('message', (data: RawData, isBinary: boolean) => this.onMessage(data, isBinary));
    this.socket.on('close', (code: number, reason: Buffer) => {
      this.finish(code, reason.toString('utf8'));
    });
    this.socket.on('error', (error: Error) => {
      this.finish(1011, `reverse-ws 连接错误：${error.message}`);
    });
    if (this.socket.readyState === this.socket.CLOSED || this.socket.readyState === this.socket.CLOSING) {
      queueMicrotask(() => this.finish(1006, 'reverse-ws 连接已关闭'));
    }
  }

  async send(frame: TunnelFrame): Promise<void> {
    if (this.closed) {
      throw new PanelError('UPSTREAM_ERROR', 'reverse-ws 隧道已关闭', {
        hint: '等待 worker 重新拨号，或检查机器 secret 是否轮换',
      });
    }
    if (this.socket.readyState !== this.socket.OPEN) {
      throw new PanelError('UPSTREAM_ERROR', 'reverse-ws 连接未就绪');
    }
    const text = JSON.stringify(frame);
    if (Buffer.byteLength(text, 'utf8') > TUNNEL_MAX_FRAME_BYTES) {
      throw new PanelError('BAD_REQUEST', '隧道帧超过 16 MiB 上限', { kind: frame.kind });
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new PanelError('UPSTREAM_ERROR', 'reverse-ws 写入阻塞超时'));
      }, SEND_TIMEOUT_MS);
      timer.unref?.();
      this.socket.send(text, { binary: false }, (error?: Error) => {
        clearTimeout(timer);
        if (error === undefined || error === null) resolve();
        else reject(new PanelError('UPSTREAM_ERROR', `reverse-ws 写入失败：${error.message}`));
      });
    });
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closeCode = code;
    this.closeReason = reason;
    const sendable = toSendableCloseCode(code);
    const text = truncateUtf8(reason ?? '', 123);
    try {
      if (this.socket.readyState === this.socket.CONNECTING) this.socket.terminate();
      else this.socket.close(sendable, text);
    } catch {
      this.socket.terminate();
    }
  }

  onFrame(cb: (frame: TunnelFrame) => void): void {
    this.frameCbs.push(cb);
    if (this.earlyFrames.length > 0) {
      const pending = this.earlyFrames.splice(0);
      for (const frame of pending) {
        try {
          cb(frame);
        } catch {
          // 忽略单个回调异常。
        }
      }
    }
  }

  onClose(cb: (code?: number, reason?: string) => void): void {
    this.closeCbs.push(cb);
    if (this.closed) {
      const code = this.closeCode;
      const reason = this.closeReason;
      queueMicrotask(() => cb(code, reason));
    }
  }

  private onMessage(data: RawData, isBinary: boolean): void {
    if (this.closed) return;
    if (isBinary) {
      this.protocolClose(1003, 'reverse-ws 不接受二进制帧');
      return;
    }
    let text: string;
    try {
      text = rawDataToText(data);
    } catch {
      this.protocolClose(1003, 'reverse-ws 帧编码无效');
      return;
    }
    if (Buffer.byteLength(text, 'utf8') > TUNNEL_MAX_FRAME_BYTES) {
      this.protocolClose(1013, 'reverse-ws 帧超过 16 MiB');
      return;
    }
    let frame: TunnelFrame;
    try {
      frame = decodeTunnelFrame(text);
    } catch {
      this.protocolClose(1002, 'reverse-ws 帧不是合法 JSON 帧');
      return;
    }
    if (this.frameCbs.length === 0) {
      if (this.earlyFrames.length < 64) this.earlyFrames.push(frame);
      return;
    }
    for (const cb of this.frameCbs) {
      try {
        cb(frame);
      } catch {
        // 忽略单个回调异常。
      }
    }
  }

  private protocolClose(code: number, reason: string): void {
    this.closeCode = code;
    this.closeReason = reason;
    try {
      this.socket.close(code, reason);
    } catch {
      this.socket.terminate();
    }
  }

  private finish(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    const finalCode = this.closeCode ?? code;
    const finalReason = this.closeReason ?? reason;
    for (const cb of this.closeCbs) {
      try {
        cb(finalCode, finalReason);
      } catch {
        // 关闭回调异常不影响 core。
      }
    }
  }
}

/**
 * reverse-ws 驱动：不主动 listen；app.ts 在 `/ws/worker` 认证升级后调用
 * handleReverseWs(machineId, socket) -> driver.attach()。同一机器新连接优先，
 * 旧连接以 4001 关闭。
 */
export function createReverseWsTransportDriver(deps: TransportDriverDeps): ReverseWsTransportDriver {
  const logger = toTransportLogger(deps.logger);
  const driver = createTunnelDriver('reverse-ws', deps, { autoRestart: false });
  const attach = async (
    machineId: string,
    socket: WebSocket,
    _req: import('node:http').IncomingMessage,
  ): Promise<void> => {
    const channel = createReverseWsChannel({ socket, machineId });
    try {
      await driver.attachChannel(machineId, channel);
    } catch (error) {
      logger.warn('reverse-ws 握手失败', {
        machineId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  return Object.assign(driver, {
    attach,
    attachedMachineIds: (): string[] => driver.connectedMachineIds(),
  });
}

function rawDataToText(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function toSendableCloseCode(code?: number): number {
  if (code === undefined) return 1000;
  if (code === 1000 || code === 1001 || code === 1002 || code === 1003) return code;
  if (code >= 1007 && code <= 1014) return code;
  if (code >= 3000 && code <= 4999) return code;
  return 1011;
}

/** ws 关闭原因限制 123 字节（按 UTF-8 字节截断，避免多字节字符超限）。 */
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
