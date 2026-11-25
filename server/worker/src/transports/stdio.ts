import {
  PanelError,
  TUNNEL_HEARTBEAT_TIMEOUT_MS,
  TUNNEL_MAX_FRAME_BYTES,
  TUNNEL_PROTOCOL_VERSION,
  decodeTunnelFrame,
} from '@mpanel/shared';
import type {
  HelloFrame,
  PongFrame,
  ProtocolLimits,
  TunnelFrame,
} from '@mpanel/shared';
import type { WorkerTransport, WorkerTransportDeps } from './types.js';
import { TRANSPORT_LOOPBACK_HOST } from './types.js';
import { NdjsonFrameTooLargeError, NdjsonReader, writeNdjson } from './ndjson.js';
import { TunnelBridge } from './tunnel-bridge.js';
import { describeWorker } from '../registry.js';

export interface StdioChannel {
  send(frame: TunnelFrame): Promise<void>;
  close(code?: number, reason?: string): void;
  onFrame(cb: (frame: TunnelFrame) => void): void;
  onClose(cb: (code?: number, reason?: string) => void): void;
}

export interface StdioChannelOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  maxFrameBytes?: number;
  onError?: (error: Error) => void;
}

const HANDSHAKE_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 30_000;
const DEFAULT_PROTOCOL: ProtocolLimits = {
  maxFrameBytes: TUNNEL_MAX_FRAME_BYTES,
  chunkBytes: 512 * 1024,
  maxInflightRequests: 128,
  maxWsStreams: 64,
};

/**
 * stdin → 帧 的 NDJSON 通道。stdout 只写帧；日志由 logger 固定写 stderr。
 * 通道本身不做握手/路由，传输层负责状态机。
 */
export function createStdioChannel(options: StdioChannelOptions = {}): StdioChannel {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const reader = new NdjsonReader(options.maxFrameBytes ?? TUNNEL_MAX_FRAME_BYTES);
  let frameHandler: ((frame: TunnelFrame) => void) | null = null;
  let closeHandler: ((code?: number, reason?: string) => void) | null = null;
  let closed = false;
  let writeChain: Promise<void> = Promise.resolve();

  const finish = (code: number | undefined, reason: string | undefined): void => {
    if (closed) return;
    closed = true;
    input.off('data', onData);
    input.off('end', onEnd);
    input.off('close', onEnd);
    input.off('error', onError);
    input.pause?.();
    closeHandler?.(code, reason);
  };

  const fail = (error: Error, code = 1002, reason = 'protocol error'): void => {
    options.onError?.(error);
    finish(code, reason);
  };

  const onData = (chunk: Buffer | string): void => {
    if (closed) return;
    let lines: string[];
    try {
      lines = reader.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
    } catch (error) {
      if (error instanceof NdjsonFrameTooLargeError) {
        fail(error, 1009, 'frame too large');
      } else {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }
    for (const line of lines) {
      let frame: TunnelFrame;
      try {
        frame = decodeTunnelFrame(line);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)), 1002, 'invalid frame');
        return;
      }
      frameHandler?.(frame);
    }
  };

  const onEnd = (): void => {
    // 尝试处理最后一行不完整的帧（core 可能在 EOF 前没有补换行）。
    if (!closed) {
      try {
        for (const line of reader.end()) {
          const frame = decodeTunnelFrame(line);
          frameHandler?.(frame);
        }
      } catch (error) {
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
    finish(0, 'eof');
  };

  const onError = (error: Error): void => {
    fail(error, 1011, 'stdin error');
  };

  input.on('data', onData);
  input.once('end', onEnd);
  input.once('close', onEnd);
  input.once('error', onError);
  input.resume?.();

  const send = (frame: TunnelFrame): Promise<void> => {
    if (closed) {
      return Promise.reject(new PanelError('UNAVAILABLE', 'stdio 通道已关闭', {
        hint: 'core 已断开；worker 将退出等待 core 重启。',
      }));
    }
    const task = writeChain.then(async () => {
      let timer: NodeJS.Timeout | null = null;
      try {
        await Promise.race([
          writeNdjson(output, frame),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(
                new PanelError('UNAVAILABLE', 'stdout 写入阻塞超过 30 秒', {
                  hint: 'core 未读取 stdout；隧道将关闭并按退避重启。',
                }),
              );
            }, WRITE_TIMEOUT_MS);
            timer.unref?.();
          }),
        ]);
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    });
    writeChain = task.catch(() => undefined);
    void task.catch(() => finish(1013, 'write timeout'));
    return task;
  };

  return {
    send,
    close(code?: number, reason?: string): void {
      finish(code, reason);
    },
    onFrame(cb: (frame: TunnelFrame) => void): void {
      frameHandler = cb;
    },
    onClose(cb: (code?: number, reason?: string) => void): void {
      closeHandler = cb;
      if (closed) cb(0, 'closed');
    },
  };
}

/**
 * stdio 传输：先 listen 127.0.0.1:0（同一 Fastify 应用），再建立 NDJSON 桥。
 * stdout 只输出 hello/http-response/ws-* 帧；日志一律 stderr。
 */
export function createStdioTransport(deps: WorkerTransportDeps): WorkerTransport {
  const { app, config, logger } = deps;
  let channel: StdioChannel | null = null;
  let bridge: TunnelBridge | null = null;
  let stopped = false;
  let stopResolve: (() => void) | null = null;
  const stoppedPromise = new Promise<void>((resolve) => {
    stopResolve = resolve;
  });
  let watchdog: NodeJS.Timeout | null = null;
  let handshakeReject: ((error: Error) => void) | null = null;

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (watchdog !== null) {
      clearTimeout(watchdog);
      watchdog = null;
    }
    handshakeReject?.(new PanelError('UNAVAILABLE', 'stdio 通道提前关闭'));
    channel?.close(0, 'stopping');
    bridge?.closeAll();
    try {
      // 心跳超时/主动停止时也释放 stdin，避免管道句柄阻止进程退出。
      process.stdin.destroy();
    } catch {
      // 已经 EOF 或不可销毁。
    }
    try {
      await app.close();
    } catch (error) {
      logger.debug('stdio 传输关闭 Fastify 失败', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    stopResolve?.();
  };

  const resetWatchdog = (): void => {
    if (stopped) return;
    if (watchdog !== null) clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      logger.warn('stdio 心跳超时，退出等待 core 重启', {
        timeoutMs: TUNNEL_HEARTBEAT_TIMEOUT_MS,
      });
      void stop();
    }, TUNNEL_HEARTBEAT_TIMEOUT_MS);
    watchdog.unref?.();
  };

  const send = (frame: TunnelFrame): Promise<void> => {
    if (channel === null) {
      return Promise.reject(new PanelError('UNAVAILABLE', 'stdio 通道尚未建立'));
    }
    return channel.send(frame);
  };

  const start = async (): Promise<void> => {
    if (stopped) throw new PanelError('CONFLICT', 'stdio 传输已停止');
    await app.listen({ host: TRANSPORT_LOOPBACK_HOST, port: 0 });
    const address = app.server.address();
    if (address === null || typeof address === 'string') {
      await app.close().catch(() => undefined);
      throw new PanelError('INTERNAL', '无法获取 loopback 端口');
    }
    const port = address.port;
    bridge = new TunnelBridge({
      token: config.token,
      logger: logger.child({ component: 'tunnel-bridge' }),
      host: TRANSPORT_LOOPBACK_HOST,
      port,
      hasWsRoute: (pathname: string) => app.mpanel.wsBridge.hasRoute(pathname),
    });
    logger.debug('stdio loopback 已监听', { host: TRANSPORT_LOOPBACK_HOST, port });

    const capabilities = app.mpanel.capabilities.snapshot();
    const hello: HelloFrame = {
      kind: 'hello',
      v: TUNNEL_PROTOCOL_VERSION,
      role: 'worker',
      ...(config.machineId === undefined ? {} : { machineId: config.machineId }),
      token: config.token,
      worker: describeWorker(capabilities),
      protocol: DEFAULT_PROTOCOL,
      sentAt: new Date().toISOString(),
    };

    const stdioChannel = createStdioChannel({
      onError: (error: Error) => {
        logger.error('stdio 帧读取失败', {
          error: error.message,
          ...(error instanceof NdjsonFrameTooLargeError ? { bytes: error.bytes } : {}),
        });
      },
    });
    channel = stdioChannel;

    let accepted = false;
    const handshake = new Promise<void>((resolve, reject) => {
      handshakeReject = reject;
      const timer = setTimeout(() => {
        reject(new PanelError('UNAVAILABLE', '等待 core hello 超时', {
          hint: '确认 core 正在读取 worker stdout 并回复 hello。',
        }));
      }, HANDSHAKE_TIMEOUT_MS);
      timer.unref?.();
      const settle = (): void => {
        clearTimeout(timer);
        handshakeReject = null;
        resolve();
      };
      stdioChannel.onFrame((frame: TunnelFrame) => {
        if (!accepted) {
          if (frame.kind !== 'hello') {
            reject(
              new PanelError('BAD_REQUEST', `hello 之前收到 ${frame.kind} 帧`, {
                frameKind: frame.kind,
              }),
            );
            return;
          }
          if (frame.v !== TUNNEL_PROTOCOL_VERSION) {
            reject(
              new PanelError('UPSTREAM_ERROR', `core 协议版本不匹配：${String(frame.v)}`, {
                stage: 'hello',
                expected: TUNNEL_PROTOCOL_VERSION,
              }),
            );
            return;
          }
          if (frame.role !== 'core') {
            reject(new PanelError('BAD_REQUEST', 'core hello 的 role 必须是 core'));
            return;
          }
          if (frame.accepted !== true) {
            reject(
              new PanelError('UNAUTHORIZED', 'core 拒绝 worker hello', {
                ...(frame.reason === undefined ? {} : { reason: frame.reason }),
              }),
            );
            return;
          }
          accepted = true;
          settle();
          resetWatchdog();
          logger.info('stdio 隧道握手成功', {
            ...(frame.machineId === undefined ? {} : { machineId: frame.machineId }),
            ...(frame.core === undefined
              ? {}
              : { coreName: frame.core.name, coreVersion: frame.core.version }),
          });
          return;
        }
        resetWatchdog();
        if (frame.kind === 'ping') {
          const pong: PongFrame = { kind: 'pong', id: frame.id, ts: frame.ts };
          void send(pong).catch((error: unknown) => {
            logger.debug('stdio pong 发送失败', {
              error: error instanceof Error ? error.message : String(error),
            });
          });
          return;
        }
        if (frame.kind === 'pong' || frame.kind === 'hello') return;
        const task = bridge?.handleFrame(frame, (out: TunnelFrame) => send(out));
        if (task === undefined) return;
        void task.catch((error: unknown) => {
          logger.error('stdio 隧道协议错误，关闭通道', {
            kind: frame.kind,
            error: error instanceof Error ? error.message : String(error),
          });
          void stop();
        });
      });
      stdioChannel.onClose((code?: number, reason?: string) => {
        if (stopped) return;
        if (code === 0 && reason === 'eof') {
          logger.info('stdio 输入已结束（EOF），准备退出');
        } else {
          logger.warn('stdio 通道关闭', { code, reason });
        }
        if (!accepted) {
          reject(new PanelError('UNAVAILABLE', 'stdio 通道在握手完成前关闭', { code, reason }));
        } else {
          void stop();
        }
      });
      void stdioChannel.send(hello).catch((error: unknown) => {
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });

    try {
      await handshake;
    } catch (error) {
      await stop();
      throw error;
    }
    resetWatchdog();
  };

  return {
    kind: 'stdio',
    start,
    stop,
    waitForStop: () => stoppedPromise,
  };
}
