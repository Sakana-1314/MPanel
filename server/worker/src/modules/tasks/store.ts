import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  PanelError,
  taskSchema,
  type ListResult,
  type PageQuery,
  type Task,
  type TaskCreateInput,
  type TaskRun,
  type TaskRunStatus,
  type TaskRunSummary,
  type TaskUpdateInput,
} from '@mpanel/shared';
import { createTaskHistory, type HistoryLimits, type TaskHistory } from './history.js';
import { computeNextRuns, validateSchedule } from './scheduler.js';
import { sanitizeTaskEnv } from './runner.js';

/** 默认任务超时（秒）。 */
const DEFAULT_TIMEOUT_SEC = 300;

/**
 * 任务定义 + 运行历史的持久化存储。
 * - 任务定义：`tasks.json`，原子写（tmp + fsync + rename）。
 * - 运行历史：`task-runs.jsonl`，追加快照、按 id 覆盖，裁剪时原子重写。
 */
export interface TaskStore {
  list(q: PageQuery & { enabled?: boolean; q?: string }): Promise<ListResult<Task>>;
  get(id: string): Promise<Task | undefined>;
  create(input: TaskCreateInput): Promise<Task>;
  update(id: string, input: TaskUpdateInput): Promise<Task>;
  remove(id: string): Promise<void>;
  listRuns(q: PageQuery & { taskId?: string; status?: TaskRunStatus }): Promise<ListResult<TaskRun>>;
  getRun(id: string): Promise<TaskRun | undefined>;
  appendRun(run: TaskRun): Promise<void>;
  updateRun(id: string, patch: Partial<TaskRun>): Promise<TaskRun>;
  trimHistory(taskId: string): Promise<void>;
  /** 清空某任务的全部历史（需求：历史可清空），返回删除条数。 */
  clearHistory(taskId: string): Promise<number>;
}

interface TaskFile {
  schemaVersion: 1;
  tasks: Task[];
}

export function createTaskStore(file: string, runsFile: string, limits?: HistoryLimits): TaskStore {
  return new FileTaskStore(file, createTaskHistory(runsFile, limits));
}

class FileTaskStore implements TaskStore {
  private tasks: Task[] | null = null;
  private loadPromise: Promise<void> | null = null;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly history: TaskHistory,
  ) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loadPromise === null) {
      this.loadPromise = this.load();
    }
    await this.loadPromise;
  }

  private async load(): Promise<void> {
    let raw = '';
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    const loaded: Task[] = [];
    if (raw.trim().length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      const candidates = Array.isArray(parsed)
        ? parsed
        : typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as { tasks?: unknown }).tasks)
          ? ((parsed as { tasks: unknown[] }).tasks)
          : [];
      for (const candidate of candidates) {
        const result = taskSchema.safeParse(candidate);
        if (result.success) {
          loaded.push(result.data);
        }
      }
    }

    this.tasks = loaded;
    for (const task of loaded) {
      this.refreshNextRun(task);
      try {
        const latest = await this.history.latest(task.id);
        task.lastRun = latest === undefined ? null : summarize(latest);
        if (task.lastRun !== null) task.nextRunAt = this.nextRunFor(task);
      } catch {
        // 历史读取失败不应阻止任务定义加载
      }
    }
  }

  private async ensure(): Promise<Task[]> {
    await this.ensureLoaded();
    return this.tasks ?? [];
  }

  async list(q: PageQuery & { enabled?: boolean; q?: string }): Promise<ListResult<Task>> {
    const tasks = await this.ensure();
    const query = typeof q.q === 'string' ? q.q.trim().toLowerCase() : '';
    const filtered = tasks.filter((task) => {
      if (q.enabled !== undefined && task.enabled !== q.enabled) return false;
      if (query.length === 0) return true;
      return (
        task.name.toLowerCase().includes(query) ||
        task.command.toLowerCase().includes(query) ||
        (task.description ?? '').toLowerCase().includes(query)
      );
    });
    for (const task of filtered) this.refreshNextRun(task);
    filtered.sort((a, b) => a.name.localeCompare(b.name));

    const limit = typeof q.limit === 'number' && q.limit >= 1 ? Math.min(q.limit, 200) : 50;
    const offset = decodeCursor(q.cursor);
    const items = filtered.slice(offset, offset + limit);
    const nextOffset = offset + items.length;
    const result: ListResult<Task> = {
      available: true,
      items,
      total: filtered.length,
    };
    if (nextOffset < filtered.length && items.length > 0) {
      result.nextCursor = String(nextOffset);
    }
    return result;
  }

  async get(id: string): Promise<Task | undefined> {
    const tasks = await this.ensure();
    const task = tasks.find((item) => item.id === id);
    if (task !== undefined) this.refreshNextRun(task);
    return task;
  }

  async create(input: TaskCreateInput): Promise<Task> {
    const tasks = await this.ensure();
    const schedule = normalizeSchedule(input.schedule);
    const timezone = normalizeTimezone(input.timezone);
    validateSchedule(schedule, timezone);
    const now = new Date().toISOString();
    const enabled = input.enabled ?? true;
    const task: Task = {
      id: newTaskId(),
      name: input.name,
      description: input.description ?? null,
      schedule,
      timezone,
      command: input.command,
      cwd: input.cwd ?? null,
      env: sanitizeTaskEnv(input.env ?? {}),
      enabled,
      timeoutSec: normalizeTimeout(input.timeoutSec),
      overlap: input.overlap ?? 'skip',
      createdAt: now,
      updatedAt: now,
      nextRunAt: enabled ? nextRunOrThrow(schedule, timezone) : null,
      lastRun: null,
    };
    tasks.push(task);
    await this.save();
    return task;
  }

  async update(id: string, input: TaskUpdateInput): Promise<Task> {
    const tasks = await this.ensure();
    const task = tasks.find((item) => item.id === id);
    if (task === undefined) {
      throw new PanelError('NOT_FOUND', '计划任务不存在', { resource: 'task', id });
    }

    // 先在副本上应用变更并校验，避免非法输入污染内存态
    const next: Task = { ...task };
    if (input.name !== undefined) next.name = input.name;
    if (input.description !== undefined) next.description = input.description;
    if (input.schedule !== undefined) next.schedule = normalizeSchedule(input.schedule);
    if (input.timezone !== undefined) next.timezone = normalizeTimezone(input.timezone);
    if (input.command !== undefined) next.command = input.command;
    if (input.cwd !== undefined) next.cwd = input.cwd;
    if (input.env !== undefined) next.env = sanitizeTaskEnv(input.env);
    if (input.enabled !== undefined) next.enabled = input.enabled;
    if (input.timeoutSec !== undefined) next.timeoutSec = normalizeTimeout(input.timeoutSec);
    if (input.overlap !== undefined) next.overlap = input.overlap;

    validateSchedule(next.schedule, next.timezone);
    next.updatedAt = new Date().toISOString();
    next.nextRunAt = next.enabled ? nextRunOrThrow(next.schedule, next.timezone) : null;
    Object.assign(task, next);
    await this.save();
    return task;
  }

  async remove(id: string): Promise<void> {
    const tasks = await this.ensure();
    const index = tasks.findIndex((item) => item.id === id);
    if (index < 0) {
      throw new PanelError('NOT_FOUND', '计划任务不存在', { resource: 'task', id });
    }
    tasks.splice(index, 1);
    await this.save();
  }

  async listRuns(
    q: PageQuery & { taskId?: string; status?: TaskRunStatus },
  ): Promise<ListResult<TaskRun>> {
    await this.ensureLoaded();
    return this.history.list(q.taskId, {
      ...(q.limit === undefined ? {} : { limit: q.limit }),
      ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
      ...(q.status === undefined ? {} : { status: q.status }),
    });
  }

  async getRun(id: string): Promise<TaskRun | undefined> {
    await this.ensureLoaded();
    return this.history.get(id);
  }

  async appendRun(run: TaskRun): Promise<void> {
    await this.ensureLoaded();
    await this.history.append(run);
    await this.updateLastRun(run.taskId);
  }

  async updateRun(id: string, patch: Partial<TaskRun>): Promise<TaskRun> {
    await this.ensureLoaded();
    const run = await this.history.update(id, patch);
    await this.updateLastRun(run.taskId);
    return run;
  }

  async trimHistory(taskId: string): Promise<void> {
    await this.ensureLoaded();
    await this.history.trimTask(taskId);
    await this.updateLastRun(taskId);
  }

  async clearHistory(taskId: string): Promise<number> {
    await this.ensureLoaded();
    const removed = await this.history.clear(taskId);
    await this.updateLastRun(taskId);
    return removed;
  }

  private async updateLastRun(taskId: string): Promise<void> {
    const tasks = this.tasks;
    if (tasks === null) return;
    const task = tasks.find((item) => item.id === taskId);
    if (task === undefined) return;
    const latest = await this.history.latest(taskId);
    task.lastRun = latest === undefined ? null : summarize(latest);
    await this.save();
  }

  private refreshNextRun(task: Task): void {
    task.nextRunAt = task.enabled ? this.nextRunFor(task) : null;
  }

  private nextRunFor(task: Task): string | null {
    try {
      const [first] = computeNextRuns(task.schedule, task.timezone, 1);
      return first ?? null;
    } catch {
      return null;
    }
  }

  private save(): Promise<void> {
    const payload: TaskFile = {
      schemaVersion: 1,
      tasks: this.tasks ?? [],
    };
    const body = `${JSON.stringify(payload, null, 2)}\n`;
    const previous = this.writeChain;
    const current = previous.then(() => writeFileAtomic(this.file, body));
    this.writeChain = current.catch(() => {
      // 保持写队列可用，错误由本次调用方感知
    });
    return current;
  }
}

function summarize(run: TaskRun): TaskRunSummary {
  return {
    id: run.id,
    taskId: run.taskId,
    status: run.status,
    triggeredBy: run.triggeredBy,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? null,
    exitCode: run.exitCode ?? null,
    durationMs: run.durationMs ?? null,
  };
}

function normalizeSchedule(schedule: string): string {
  const trimmed = typeof schedule === 'string' ? schedule.trim() : '';
  if (trimmed.length === 0) {
    throw new PanelError('BAD_REQUEST', 'cron 表达式不能为空', { field: 'schedule' });
  }
  return trimmed;
}

function normalizeTimezone(timezone: string | null | undefined): string | null {
  if (typeof timezone !== 'string') return null;
  const trimmed = timezone.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function normalizeTimeout(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TIMEOUT_SEC;
  return Math.min(86_400, Math.max(1, Math.trunc(value)));
}

function nextRunOrThrow(schedule: string, timezone: string | null): string {
  const [first] = computeNextRuns(schedule, timezone, 1);
  if (first === undefined) {
    throw new PanelError('BAD_REQUEST', 'cron 表达式没有未来运行时间', { field: 'schedule' });
  }
  return first;
}

function newTaskId(): string {
  return `tk_${randomBytes(8).toString('hex')}`;
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const parsed = Number(cursor);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new PanelError('BAD_REQUEST', '无效的分页 cursor', { cursor });
  }
  return parsed;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

async function writeFileAtomic(file: string, data: string): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const handle = await fs.open(tmp, 'w');
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}
