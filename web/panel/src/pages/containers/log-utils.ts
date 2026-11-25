import type { ContainerLogsServerMessage } from '../../api/types';
import type { LogLine } from '../../components/ui/LogViewer';

/** 最多保留的日志行数，避免长时间 follow 把内存撑爆。 */
export const LOG_LINE_LIMIT = 5000;

export function parseLogMessage(raw: string): ContainerLogsServerMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const value = parsed as Record<string, unknown>;
  if (value.type === 'log') {
    if (typeof value.data !== 'string') return null;
    const stream = value.stream === 'stderr' ? 'stderr' : 'stdout';
    return {
      type: 'log',
      stream,
      data: value.data,
      ts: typeof value.ts === 'string' ? value.ts : undefined,
    };
  }
  if (value.type === 'end') return { type: 'end' };
  if (value.type === 'error') {
    return {
      type: 'error',
      code: typeof value.code === 'string' ? value.code : 'INTERNAL',
      message: typeof value.message === 'string' ? value.message : '日志流发生未知错误',
    };
  }
  return null;
}

export function toLogLine(message: ContainerLogsServerMessage): LogLine | null {
  if (message.type !== 'log') return null;
  return {
    ts: message.ts,
    stream: message.stream,
    text: message.data.replace(/\r?\n$/, ''),
  };
}

export function appendLogLines(
  existing: readonly LogLine[],
  incoming: readonly LogLine[],
  limit: number = LOG_LINE_LIMIT,
): LogLine[] {
  if (incoming.length === 0) return [...existing];
  const merged = [...existing, ...incoming];
  return merged.length > limit ? merged.slice(-limit) : merged;
}

/** 关闭码的中文可执行提示。 */
export function wsCloseHint(code: number): string {
  if (code === 4401) return 'WebSocket ticket 无效或已过期，请重新连接。';
  if (code === 4404) return '容器不存在或已被删除。';
  if (code === 4502) return 'Docker 不可用，无法读取日志。';
  if (code === 1013) return '连接被限流或超过帧上限，请稍后重试。';
  return code === 1000 ? '日志流已结束。' : `连接已关闭（${code}）。`;
}

/** 日志流结束后不应继续自动重连的关闭码。 */
export function isFatalCloseCode(code: number): boolean {
  return code === 4401 || code === 4404 || code === 4502 || code === 1013;
}
