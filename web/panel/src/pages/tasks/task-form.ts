import type { Task, TaskCreateInput, TaskOverlap, TaskUpdateInput } from '@/api/types';

export interface TaskDraft {
  name: string;
  description: string;
  schedule: string;
  timezone: string;
  command: string;
  cwd: string;
  env: Record<string, string>;
  enabled: boolean;
  /** null = 使用服务端默认值（300 秒）。 */
  timeoutSec: number | null;
  overlap: TaskOverlap;
}

export interface TaskDraftErrors {
  name?: string;
  description?: string;
  schedule?: string;
  timezone?: string;
  command?: string;
  cwd?: string;
  timeoutSec?: string;
  env?: string;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const ENV_KEY_FORBIDDEN = /[=\u0000-\u001f\u007f]/;

export function emptyTaskDraft(): TaskDraft {
  return {
    name: '',
    description: '',
    schedule: '',
    timezone: '',
    command: '',
    cwd: '',
    env: {},
    enabled: true,
    timeoutSec: null,
    overlap: 'skip',
  };
}

export function draftFromTask(task: Task): TaskDraft {
  return {
    name: task.name,
    description: task.description ?? '',
    schedule: task.schedule,
    timezone: task.timezone ?? '',
    command: task.command,
    cwd: task.cwd ?? '',
    env: { ...task.env },
    enabled: task.enabled,
    timeoutSec: task.timeoutSec,
    overlap: task.overlap,
  };
}

function normalizedEnv(env: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of Object.keys(env).sort()) {
    const trimmed = key.trim();
    if (trimmed.length === 0) continue;
    result[trimmed] = env[key] ?? '';
  }
  return result;
}

export function draftToCreateInput(draft: TaskDraft): TaskCreateInput {
  const description = draft.description.trim();
  const timezone = draft.timezone.trim();
  const cwd = draft.cwd.trim();
  return {
    name: draft.name.trim(),
    schedule: draft.schedule.trim(),
    command: draft.command.trim(),
    enabled: draft.enabled,
    overlap: draft.overlap,
    env: normalizedEnv(draft.env),
    ...(description.length === 0 ? {} : { description }),
    ...(timezone.length === 0 ? {} : { timezone }),
    ...(cwd.length === 0 ? {} : { cwd }),
    ...(draft.timeoutSec === null ? {} : { timeoutSec: draft.timeoutSec }),
  };
}

export function draftToUpdateInput(draft: TaskDraft): TaskUpdateInput {
  const description = draft.description.trim();
  const timezone = draft.timezone.trim();
  const cwd = draft.cwd.trim();
  return {
    name: draft.name.trim(),
    description: description.length === 0 ? null : description,
    schedule: draft.schedule.trim(),
    timezone: timezone.length === 0 ? null : timezone,
    command: draft.command.trim(),
    cwd: cwd.length === 0 ? null : cwd,
    env: normalizedEnv(draft.env),
    enabled: draft.enabled,
    timeoutSec: draft.timeoutSec ?? 300,
    overlap: draft.overlap,
  };
}

export function serializeTaskDraft(draft: TaskDraft): string {
  return JSON.stringify({
    name: draft.name,
    description: draft.description,
    schedule: draft.schedule,
    timezone: draft.timezone,
    command: draft.command,
    cwd: draft.cwd,
    env: normalizedEnv(draft.env),
    enabled: draft.enabled,
    timeoutSec: draft.timeoutSec,
    overlap: draft.overlap,
  });
}

export function envKeyIssue(key: string): string | null {
  if (key.length === 0) return '变量名不能为空';
  if (key.length > 128) return '变量名最长 128 个字符';
  if (ENV_KEY_FORBIDDEN.test(key)) return '变量名不能包含“=”或控制字符';
  return null;
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function validateTaskDraft(draft: TaskDraft, cronError?: string): TaskDraftErrors {
  const errors: TaskDraftErrors = {};
  const name = draft.name.trim();
  if (name.length === 0) errors.name = '请输入任务名称';
  else if (name.length > 120) errors.name = '任务名称最长 120 个字符';

  if (draft.description.length > 2000) errors.description = '描述最长 2000 个字符';

  const schedule = draft.schedule.trim();
  if (schedule.length === 0) errors.schedule = '请输入 cron 表达式';
  else if (cronError !== undefined) errors.schedule = cronError;

  const timezone = draft.timezone.trim();
  if (timezone.length > 64) errors.timezone = '时区名称最长 64 个字符';
  else if (timezone.length > 0 && !isValidTimezone(timezone)) {
    errors.timezone = '时区不是合法的 IANA 名称（如 Asia/Shanghai）';
  }

  const command = draft.command.trim();
  if (command.length === 0) errors.command = '请输入要执行的命令';
  else if (command.length > 65_536) errors.command = '命令最长 64 KiB';

  const cwd = draft.cwd.trim();
  if (cwd.length > 4096) errors.cwd = '工作目录最长 4096 个字符';
  else if (CONTROL_CHARS.test(cwd)) errors.cwd = '工作目录不能包含控制字符';

  if (draft.timeoutSec !== null) {
    if (!Number.isInteger(draft.timeoutSec) || draft.timeoutSec < 1 || draft.timeoutSec > 86_400) {
      errors.timeoutSec = '超时必须是 1–86400 之间的整数秒';
    }
  }

  for (const [key, value] of Object.entries(draft.env)) {
    const issue = envKeyIssue(key.trim());
    if (issue !== null) {
      errors.env = `环境变量名“${key}”：${issue}`;
      break;
    }
    if (value.length > 4096) {
      errors.env = `环境变量“${key}”的值超过 4096 个字符`;
      break;
    }
  }
  return errors;
}

export function hasTaskDraftErrors(errors: TaskDraftErrors): boolean {
  return Object.values(errors).some((value) => typeof value === 'string' && value.length > 0);
}
