import {
  PanelError,
  terminalClientMessageSchema,
  type TerminalServerMessage,
  type WsBridge,
  type WsConnection,
  type WsSink,
} from '@mpanel/shared';
import type { TerminalManager } from './sessions.js';

/** 客户端单帧输入上限：1 MiB（契约）。 */
const MAX_INPUT_BYTES = 1024 * 1024;
/** 单条 output 帧的 UTF-8 字节上限；更大的 PTY 输出会被切成多帧。 */
const OUTPUT_FRAME_BYTES = 256 * 1024;
/** 背压高水位：8 MiB；超过后暂停读取 PTY。 */
const HIGH_WATER_BYTES = 8 * 1024 * 1024;
/** 背压持续超过该时长仍未缓解则按 1013 关闭。 */
const BACKPRESSURE_TIMEOUT_MS = 30_000;

/**
 * JSON 终端协议：/ws/terminal/:sessionId。
 * 客户端 -> 服务器：input / resize / ping；服务器 -> 客户端：ready / output / exit / error / pong。
 * WS 断开只退订输出，不杀 PTY；只有 DELETE 会话或空闲回收才终止进程。
 */
export function registerTerminalWs(bridge: WsBridge, manager: TerminalManager): void {
  bridge.register('/ws/terminal/:sessionId', async (request, sink) => {
    const sessionId = request.params.sessionId;
    if (sessionId === undefined || sessionId.length === 0) {
      throw new PanelError('NOT_FOUND', '终端会话不存在', { resource: 'terminal_session' });
    }
    const session = await manager.get(sessionId);
    if (session === undefined) {
      throw new PanelError('NOT_FOUND', '终端会话不存在', {
        resource: 'terminal_session',
        id: sessionId,
      });
    }

    let closed = false;
    let unsubscribe: (() => void) | null = null;
    let draining = false;

    sendJson(sink, { type: 'ready', session });

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      if (unsubscribe !== null) {
        unsubscribe();
        unsubscribe = null;
      }
    };

    const safeClose = (code: number, reason: string): void => {
      try {
        sink.close(code, reason);
      } catch {
        // 传输已关闭
      }
    };

    const closeWith = (code: number, reason: string): void => {
      cleanup();
      sendJson(sink, { type: 'error', code: 'BAD_REQUEST', message: reason });
      safeClose(code, reason);
    };

    const maybePause = async (): Promise<void> => {
      if (closed || draining) return;
      if ((sink.bufferedBytes ?? 0) < HIGH_WATER_BYTES) return;
      draining = true;
      manager.pause(sessionId);
      const deadline = Date.now() + BACKPRESSURE_TIMEOUT_MS;
      try {
        while (!closed && (sink.bufferedBytes ?? 0) > HIGH_WATER_BYTES / 2) {
          if (Date.now() >= deadline) break;
          if (sink.waitForDrain !== undefined) {
            try {
              await Promise.race([sink.waitForDrain(), delay(500)]);
            } catch {
              await delay(50);
            }
          } else {
            await delay(50);
          }
          await delay(10);
        }
      } finally {
        draining = false;
        if (!closed) {
          manager.resume(sessionId);
          if ((sink.bufferedBytes ?? 0) >= HIGH_WATER_BYTES) {
            closeWith(1013, '终端输出背压过高');
          }
        }
      }
    };

    unsubscribe = manager.attach(sessionId, {
      onOutput(data: string): void {
        if (closed) return;
        for (const part of splitUtf8(data, OUTPUT_FRAME_BYTES)) {
          sendJson(sink, { type: 'output', data: part });
        }
        void maybePause().catch(() => {
          // 背压处理失败不影响会话
        });
      },
      onExit(code: number | null, signal?: string | null): void {
        if (closed) return;
        sendJson(sink, { type: 'exit', code, signal: signal ?? null });
        cleanup();
        safeClose(1000, 'session exited');
      },
    });

    if (unsubscribe === null) {
      // 会话在 ready 与 attach 之间被删除
      sendJson(sink, { type: 'exit', code: null, signal: null });
      safeClose(1000, 'session closed');
      closed = true;
    }

    const connection: WsConnection = {
      receive(data: string | Uint8Array, binary: boolean): void {
        if (closed) return;
        if (binary) {
          closeWith(1003, '终端仅接受文本帧');
          return;
        }
        const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
        if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) {
          closeWith(1013, '终端输入超过 1 MiB 限制');
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          sendJson(sink, { type: 'error', code: 'BAD_REQUEST', message: '消息不是合法 JSON' });
          return;
        }
        const message = terminalClientMessageSchema.safeParse(parsed);
        if (!message.success) {
          sendJson(sink, { type: 'error', code: 'BAD_REQUEST', message: '终端消息格式不正确' });
          return;
        }
        switch (message.data.type) {
          case 'input': {
            if (!manager.write(sessionId, message.data.data)) {
              sendJson(sink, { type: 'error', code: 'CONFLICT', message: '终端会话已退出' });
            }
            break;
          }
          case 'resize': {
            manager.resize(sessionId, message.data.cols, message.data.rows);
            break;
          }
          case 'ping': {
            sendJson(sink, { type: 'pong' });
            break;
          }
          default: {
            break;
          }
        }
      },
      close(): void {
        cleanup();
      },
    };

    return connection;
  });
}

function sendJson(sink: WsSink, message: TerminalServerMessage): void {
  try {
    sink.sendText(JSON.stringify(message));
  } catch {
    // 传输已关闭；会话不受影响
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** 按 UTF-8 字节预算切分字符串，不拆开代理对/多字节字符。 */
function splitUtf8(text: string, maxBytes: number): string[] {
  if (text.length === 0) return [];
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return [text];
  const parts: string[] = [];
  let start = 0;
  let bytes = 0;
  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    const char = String.fromCodePoint(codePoint);
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes > 0 && bytes + size > maxBytes) {
      parts.push(text.slice(start, index));
      start = index;
      bytes = 0;
    }
    bytes += size;
    index += char.length;
  }
  if (start < text.length) parts.push(text.slice(start));
  return parts;
}
