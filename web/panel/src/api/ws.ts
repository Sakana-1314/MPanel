import type { ApiClient } from './client';
import { AppError } from './errors';

export type WsStatus = 'connecting' | 'open' | 'closed';

export interface WsHandlers {
  onOpen?(): void;
  onMessage(data: string | Uint8Array, binary: boolean): void;
  onClose?(event: { code: number; reason: string }): void;
  onError?(error: unknown): void;
}

export interface WsSession {
  readonly status: WsStatus;
  /** 供页面幂等关闭（标签页关闭/组件卸载时统一关闭）。 */
  readonly url: string;
  sendText(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface ConnectWsOptions {
  timeoutMs?: number;
}

const openSockets = new Set<WebSocket>();

export function closeAllWs(): void {
  for (const socket of [...openSockets]) {
    try {
      socket.close(1000, 'workspace changed');
    } catch {
      // 已关闭的 socket 忽略。
    }
  }
  openSockets.clear();
}

/**
 * 经 core 代理建立 WebSocket：先 POST /auth/ws-ticket 取一次性 ticket，
 * 再连 `/api/v1/machines/<id>/proxy/ws<featurePath>?ticket=...`。
 * 前端不保存任何 agent 地址；WS 与 REST 一样只经过 core。
 */
export async function connectWs(
  client: ApiClient,
  featurePath: string,
  handlers: WsHandlers,
  opts: ConnectWsOptions = {},
): Promise<WsSession> {
  if (client.machineId === undefined || client.machineId.length === 0) {
    throw new AppError('UNAVAILABLE', '尚未绑定机器', 0, {
      hint: '终端与日志只能从具体机器的页面打开。',
    });
  }
  const ticket = await client.getWsTicket(featurePath);
  const url = client.wsUrl(featurePath, ticket.ticket);
  const socket = new WebSocket(url);
  openSockets.add(socket);

  let status: WsStatus = 'connecting';
  const session: WsSession = {
    get status() {
      return status;
    },
    url,
    sendText(data: string): void {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    },
    close(code?: number, reason?: string): void {
      socket.close(code, reason);
    },
  };

  return await new Promise<WsSession>((resolve, reject) => {
    let opened = false;
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const timer = setTimeout(() => {
      if (opened) return;
      try {
        socket.close();
      } catch {
        // ignore
      }
      reject(
        new AppError('TIMEOUT', 'WebSocket 连接超时', 0, {
          hint: '请确认 core 与目标机器在线，且反向代理允许 Upgrade/Connection 头。',
        }),
      );
    }, timeoutMs);

    socket.onopen = () => {
      clearTimeout(timer);
      opened = true;
      status = 'open';
      handlers.onOpen?.();
      resolve(session);
    };

    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data === 'string') {
        handlers.onMessage(event.data, false);
        return;
      }
      if (event.data instanceof Blob) {
        void event.data.text().then((text) => handlers.onMessage(text, false));
        return;
      }
      handlers.onMessage(new Uint8Array(event.data as ArrayBuffer), true);
    };

    socket.onerror = (event: Event) => {
      handlers.onError?.(event);
      if (!opened) {
        clearTimeout(timer);
        reject(
          new AppError('NETWORK', 'WebSocket 连接失败', 0, {
            hint: '请检查 core 地址、机器在线状态与反向代理的 WebSocket 配置。',
          }),
        );
      }
    };

    socket.onclose = (event: CloseEvent) => {
      clearTimeout(timer);
      status = 'closed';
      openSockets.delete(socket);
      handlers.onClose?.({ code: event.code, reason: event.reason });
      if (!opened) {
        reject(closeError(event.code, event.reason));
      }
    };
  });
}

function closeError(code: number, reason: string): AppError {
  if (code === 4401) {
    return new AppError('UNAUTHORIZED', 'WebSocket ticket 无效或已过期', 0, {
      hint: '请重新打开页面或重新登录以获取新的 ticket。',
      reason,
    });
  }
  if (code === 4404) {
    return new AppError('NOT_FOUND', 'WebSocket 目标不存在', 0, { hint: '会话可能已被关闭。', reason });
  }
  if (code === 4502) {
    return new AppError('UNAVAILABLE', '机器不可用，无法建立 WebSocket', 0, {
      hint: '请确认机器在线并已连接后重试。',
      reason,
    });
  }
  if (code === 1013) {
    return new AppError('UNAVAILABLE', '连接被限流或超过帧上限', 0, { hint: '请稍后重试。', reason });
  }
  return new AppError('UPSTREAM_ERROR', `WebSocket 已关闭（${code}）`, 0, {
    hint: '请检查 core 与 agent 日志或重试。',
    reason,
  });
}
