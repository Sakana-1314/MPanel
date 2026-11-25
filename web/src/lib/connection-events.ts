/**
 * 连接切换的跨模块通知总线。
 * 连接 store 只负责发事件；QueryClient 清缓存、WebSocket 关闭等副作用各自订阅，
 * 避免 store ↔ api 之间的循环依赖。
 */
export type ConnectionChangeReason =
  | 'activate'
  | 'update'
  | 'remove'
  | 'machine'
  | 'secret'
  | 'bootstrap';

type Listener = (reason: ConnectionChangeReason) => void;

const listeners = new Set<Listener>();

export function onConnectionChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitConnectionChange(reason: ConnectionChangeReason): void {
  for (const listener of [...listeners]) {
    try {
      listener(reason);
    } catch {
      // 订阅方异常不能影响连接切换本身。
    }
  }
}
