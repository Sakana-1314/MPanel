import type { ApiClient } from './client';
import { getClient } from './client';
import { AppError } from './errors';
import { onConnectionChange } from '../lib/connection-events';

export type WsStatus = 'connecting' | 'open' | 'closed';

export interface WsHandlers {
  onOpen?(): void;
  onMessage(data: string | Uint8Array, binary: boolean): void;
  onClose?(event: { code: number; reason: string }): void;
  onError?(error: unknown): void;
}

export interface WsSession {
  readonly status: WsStatus;
  /** 供页面幂等关闭（连接切换时外壳也会统一关闭）。 */
  readonly url: string;
  sendText(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface ConnectWsOptions {
  timeoutMs?: number;
}

const openSockets = new Set<WebSocket>();
let guardInstalled = false;

/**
 * 连接/机器切换时统一关闭所有已建立的 WS。
 * 订阅式安装，避免 connection-store ↔ api/ws 的循环依赖。
 */
export function installWsConnectionGuard(): void {
  if (guardInstalled) return;
  guardInstalled = true;
  onConnectionChange((reason) => {
    if (reason === 'activate' || reason === 'remove' || reason === 'machine') closeAllWs();
  });
}

export function closeAllWs(): void {
  for (const socket of [...openSockets]) {
    try {
      socket.close(1000, 'connection changed');
    } catch {
      // 已关闭的 socket 忽略。
    }
  }
  openSockets.clear();
}

/** worker: /ws<path>; core 代理: /api/v1/machines/<id>/proxy/ws<path>。 */
export function wsPathFor(featurePath: string): string {
  return getClient().wsPathFor(featurePath);
}

export async function connectWs(
  featurePath: string,
  handlers: WsHandlers,
  opts: ConnectWsOptions = {},
): Promise<WsSession> {
  return connectClientWs(getClient(), featurePath, handlers, opts);
}

/**
 * 取一次性 ticket 后建连；ticket 只出现在 WS URL query 中，60 秒有效。
 * Promise 在 open 后 resolve，升级失败/超时会 reject（便于 UI 展示原因）。
 */
export async function connectClientWs(
  client: ApiClient,
  featurePath: string,
  handlers: WsHandlers,
  opts: ConnectWsOptions = {},
): Promise<WsSession> {
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
          hint: '请确认后端在线，且反向代理允许 Upgrade/Connection 头。',
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
            hint: '请检查后端地址、机器在线状态与反向代理的 WebSocket 配置。',
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
    hint: '请检查后端日志或重试。',
    reason,
  });
}
