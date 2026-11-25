import {
  containerLogsClientMessageSchema,
  containerLogsQuerySchema,
  isPanelError,
  PanelError,
  type ContainerLogsServerMessage,
  type WsBridge,
  type WsConnection,
} from '@mpanel/shared';
import { normalizeLogsOptions } from './containers.js';
import type { ContainerService } from './containers.js';
import { assertSince, isValidContainerReference } from './docker.js';

const MAX_BUFFERED_BYTES = 1024 * 1024;

/**
 * JSON 日志流：`WS /ws/containers/:id/logs`。
 * - 客户端可发送 `{"type":"close"}`；
 * - 握手阶段先验证容器存在（NOT_FOUND→4404、UNAVAILABLE→4502）；
 * - 连接关闭/客户端断开时对迭代器调用 return()，从而杀掉 docker logs 子进程。
 */
export function registerContainerLogsWs(bridge: WsBridge, service: ContainerService): void {
  bridge.register('/ws/containers/:id/logs', async (request, sink) => {
    const id = request.params.id ?? '';
    if (!isValidContainerReference(id)) {
      throw new PanelError('NOT_FOUND', `容器 ${id} 不存在`, { resource: 'container', id });
    }

    const parsed = containerLogsQuerySchema.safeParse({
      ...request.query,
      follow: request.query.follow ?? '1',
      tail: request.query.tail ?? '200',
    });
    if (!parsed.success) {
      throw new PanelError('BAD_REQUEST', '日志参数无效', { issues: parsed.error.issues });
    }
    const options = normalizeLogsOptions(parsed.data);
    if (options.since !== undefined) assertSince(options.since);

    // 握手阶段确认容器存在且 docker 可用，让 WsBridge 用 4404/4502 拒绝。
    await service.get(id);

    const controller = new AbortController();
    const iterator = service
      .streamLogs(id, { ...options, signal: controller.signal })
      [Symbol.asyncIterator]();
    let closed = false;

    const stop = (code: number, reason?: string): void => {
      if (closed) return;
      closed = true;
      controller.abort();
      void Promise.resolve(iterator.return?.()).catch(() => undefined);
      try {
        sink.close(code, reason);
      } catch {
        // 传输层可能已经关闭。
      }
    };

    const pump = async (): Promise<void> => {
      try {
        for (;;) {
          const next = await iterator.next();
          if (closed) return;
          if (next.done === true) break;
          const entry = next.value;
          const message: ContainerLogsServerMessage = {
            type: 'log',
            stream: entry.stream,
            data: entry.data,
            ...(entry.ts !== undefined ? { ts: entry.ts } : {}),
          };
          sink.sendText(JSON.stringify(message));
          const buffered = sink.bufferedBytes;
          if (buffered !== undefined && buffered > MAX_BUFFERED_BYTES) {
            await sink.waitForDrain?.();
          }
        }
        if (closed) return;
        const endMessage: ContainerLogsServerMessage = { type: 'end' };
        sink.sendText(JSON.stringify(endMessage));
        stop(1000);
      } catch (error) {
        if (closed) return;
        if (isPanelError(error)) {
          if (error.code === 'NOT_FOUND') {
            stop(4404, error.message);
            return;
          }
          if (error.code === 'UNAVAILABLE') {
            stop(4502, error.message);
            return;
          }
          try {
            const message: ContainerLogsServerMessage = {
              type: 'error',
              code: error.code,
              message: error.message,
            };
            sink.sendText(JSON.stringify(message));
          } catch {
            // 忽略发送失败。
          }
          stop(1011, error.code);
          return;
        }
        try {
          const message: ContainerLogsServerMessage = {
            type: 'error',
            code: 'INTERNAL',
            message: '日志流内部错误',
          };
          sink.sendText(JSON.stringify(message));
        } catch {
          // 忽略发送失败。
        }
        stop(1011, 'INTERNAL');
      }
    };
    void pump();

    const connection: WsConnection = {
      receive(data, binary) {
        if (binary || typeof data !== 'string') return;
        let payload: unknown;
        try {
          payload = JSON.parse(data);
        } catch {
          return;
        }
        const message = containerLogsClientMessageSchema.safeParse(payload);
        if (!message.success) return;
        if (message.data.type === 'close') stop(1000);
      },
      close() {
        stop(1000);
      },
    };
    return connection;
  });
}
