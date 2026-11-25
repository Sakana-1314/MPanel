import type { EdgeJob, EdgeJobKind, EdgeJobStatus, EdgeKey, Machine } from '../../api/types';
import type { StatusTone } from '../../components/ui/tones';
import { formatDuration } from '../../lib/format';

export type EdgeKeyState = 'active' | 'revoked' | 'expired' | 'exhausted';

export interface EdgeKeyStateView {
  state: EdgeKeyState;
  label: string;
  tone: StatusTone;
}

function parseTime(value: string): number | null {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/** 密钥状态优先级：吊销 > 过期 > 用尽 > 有效。 */
export function edgeKeyState(key: EdgeKey, now = Date.now()): EdgeKeyStateView {
  if (key.revokedAt !== null) {
    return { state: 'revoked', label: '已吊销', tone: 'danger' };
  }
  if (key.expiresAt !== null) {
    const expiresAt = parseTime(key.expiresAt);
    if (expiresAt !== null && expiresAt <= now) {
      return { state: 'expired', label: '已过期', tone: 'warning' };
    }
  }
  if (key.maxUses > 0 && key.uses >= key.maxUses) {
    return { state: 'exhausted', label: '已用尽', tone: 'neutral' };
  }
  return { state: 'active', label: '有效', tone: 'success' };
}

export const EDGE_JOB_KIND_LABEL: Record<EdgeJobKind, string> = {
  snapshot: '快照',
  'run-task': '运行任务',
  'apply-site': '应用站点',
};

export const EDGE_JOB_STATUS_LABEL: Record<EdgeJobStatus, string> = {
  pending: '待执行',
  running: '执行中',
  succeeded: '成功',
  failed: '失败',
  canceled: '已取消',
};

export const EDGE_JOB_STATUS_TONE: Record<EdgeJobStatus, StatusTone> = {
  pending: 'warning',
  running: 'info',
  succeeded: 'success',
  failed: 'danger',
  canceled: 'neutral',
};

export interface EdgeJobKindOption {
  value: EdgeJobKind;
  label: string;
  description: string;
}

export const EDGE_JOB_KIND_OPTIONS: readonly EdgeJobKindOption[] = [
  {
    value: 'snapshot',
    label: '快照',
    description: 'GET /system/snapshot，刷新 core 上的节点快照',
  },
  {
    value: 'run-task',
    label: '运行任务',
    description: 'POST /tasks/:id/run，payload.taskId',
  },
  {
    value: 'apply-site',
    label: '应用站点',
    description: 'POST /sites/:id/apply，payload.siteId',
  },
];

/** 作业耗时：未开始返回 null；running 使用当前时间。 */
export function edgeJobDurationMs(job: EdgeJob, now = Date.now()): number | null {
  if (job.startedAt === null) return null;
  const started = parseTime(job.startedAt);
  if (started === null) return null;
  const finished = job.finishedAt === null ? now : parseTime(job.finishedAt);
  if (finished === null) return null;
  return Math.max(0, finished - started);
}

export function edgeJobDurationText(job: EdgeJob, now = Date.now()): string {
  const duration = edgeJobDurationMs(job, now);
  return duration === null ? '—' : formatDuration(duration);
}

/** 安全地把任意 JSON 值格式化为只读文本。 */
export function jsonText(value: unknown): string {
  if (value === undefined) return '';
  try {
    const text = JSON.stringify(value, null, 2);
    return text ?? '';
  } catch {
    return String(value);
  }
}

const RESULT_LIMIT_BYTES = 16 * 1024;

function utf8Size(text: string): number {
  try {
    return new TextEncoder().encode(text).length;
  } catch {
    return text.length;
  }
}

/** core 截断结果时会在 result 中标记 truncated；UTF-8 字节数超限也视为截断。 */
export function isTruncatedJobResult(result: unknown, text: string): boolean {
  if (utf8Size(text) > RESULT_LIMIT_BYTES) return true;
  if (typeof result === 'object' && result !== null) {
    const candidate = (result as Record<string, unknown>).truncated;
    return candidate === true;
  }
  return false;
}

export interface WorkerCommandPair {
  unix: string;
  windows: string;
}

/**
 * 入网命令示例。coreUrl 来自当前 core 连接（已去掉 /api/v1）。
 * secret 可能包含 shell 特殊字符，示例命令不额外转义；如需生产使用请改为环境变量文件。
 */
export function buildWorkerCommands(coreUrl: string, secret: string): WorkerCommandPair {
  const url = coreUrl.length === 0 ? '<当前 core 地址>' : coreUrl;
  return {
    unix: `MPANEL_TRANSPORT=reverse-ws MPANEL_CORE_URL=${url} MPANEL_EDGE_KEY=${secret} node server/worker/dist/index.js serve`,
    windows: `set MPANEL_TRANSPORT=reverse-ws && set MPANEL_CORE_URL=${url} && set MPANEL_EDGE_KEY=${secret} && node server\\worker\\dist\\index.js serve`,
  };
}

export function machineName(machines: readonly Machine[], machineId: string): string {
  return machines.find((machine) => machine.id === machineId)?.name ?? machineId;
}
