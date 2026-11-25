import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { appendJsonl } from './store.js';

export interface AuditEvent {
  at: string;
  action: string;
  actor: string;
  ip?: string;
  target?: string;
  result: 'ok' | 'denied' | 'error';
  details?: Record<string, unknown>;
}

/**
 * Append-only audit log. Handoff events may only record the first 8 hex chars
 * of the ticket hash; never the body, URL secret, password or token.
 */
export interface AuditLog {
  write(event: AuditEvent): Promise<void>;
  /** 等待队列中的审计记录落盘（优雅退出时调用）。 */
  flush?(): Promise<void>;
}

/**
 * 串行追加的 JSONL 审计日志：
 * - 单进程内写请求排队，避免并发 append 交错；
 * - 审计失败不抛回请求处理链，只记录最近一次错误；
 * - flush() 等待当前队列完成，供优雅退出使用。
 */
export function createAuditLog(file: string): AuditLog {
  let tail: Promise<void> = Promise.resolve();
  let lastError: unknown;
  let dirReady: Promise<void> | undefined;

  function ensureDir(): Promise<void> {
    dirReady ??= mkdir(dirname(file), { recursive: true, mode: 0o700 }).then(
      () => undefined,
      (error: unknown) => {
        // 目录创建失败时保留错误，由第一次写入失败体现；不阻断启动。
        lastError = error;
      },
    );
    return dirReady;
  }

  return {
    write(event) {
      const record: AuditEvent = {
        ...event,
        at: event.at || new Date().toISOString(),
      };
      tail = tail.then(async () => {
        try {
          await ensureDir();
          await appendJsonl(file, record);
        } catch (error) {
          lastError = error;
        }
      });
      return tail;
    },

    async flush() {
      await tail;
      if (lastError !== undefined) {
        const error = lastError;
        lastError = undefined;
        throw error;
      }
    },
  };
}
