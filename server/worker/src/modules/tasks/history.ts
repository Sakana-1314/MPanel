import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PanelError, type ListResult, type PageQuery, type TaskRun, type TaskRunStatus } from '@mpanel/shared';

/** 每个任务保留的最近运行次数（需求：50）。 */
export const TASK_RUNS_PER_TASK = 50;
/** 全局保留的运行记录上限（契约：1000 条或 30 天）。 */
export const TASK_RUNS_GLOBAL_LIMIT = 1000;
/** 全局保留时长上限（契约：30 天）。 */
export const TASK_RUNS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 任务运行历史账本。文件为 JSONL：每次状态变化追加一条完整快照，
 * 读取时按 id 覆盖（后写胜出）后按开始时间倒序。裁剪时原子重写整个文件。
 */
export interface TaskHistory {
  append(run: TaskRun): Promise<void>;
  list(
    taskId: string | undefined,
    q: PageQuery & { status?: TaskRunStatus },
  ): Promise<ListResult<TaskRun>>;
  trim(): Promise<void>;
  get(id: string): Promise<TaskRun | undefined>;
  update(id: string, patch: Partial<TaskRun>): Promise<TaskRun>;
  latest(taskId: string): Promise<TaskRun | undefined>;
  trimTask(taskId: string): Promise<void>;
  clear(taskId: string): Promise<number>;
}

export interface HistoryLimits {
  /** 全局保留条数（默认 1000，来自 MPANEL_TASK_HISTORY_LIMIT）。 */
  globalLimit?: number;
  /** 每任务保留条数（默认 50）。 */
  perTask?: number;
  /** 全局保留时长（默认 30 天）。 */
  maxAgeMs?: number;
}

export function createTaskHistory(file: string, limits?: HistoryLimits): TaskHistory {
  const ledger = new RunLedger(file, limits);

  return {
    async append(run: TaskRun): Promise<void> {
      await ledger.append(run);
    },
    async list(
      taskId: string | undefined,
      q: PageQuery & { status?: TaskRunStatus },
    ): Promise<ListResult<TaskRun>> {
      return ledger.list(taskId, q);
    },
    async trim(): Promise<void> {
      await ledger.trim();
    },
    async get(id: string): Promise<TaskRun | undefined> {
      await ledger.ensureLoaded();
      const run = ledger.byId.get(id);
      return run === undefined ? undefined : cloneRun(run);
    },
    async update(id: string, patch: Partial<TaskRun>): Promise<TaskRun> {
      return ledger.update(id, patch);
    },
    async latest(taskId: string): Promise<TaskRun | undefined> {
      return ledger.latest(taskId);
    },
    async trimTask(taskId: string): Promise<void> {
      await ledger.trimTask(taskId);
    },
    async clear(taskId: string): Promise<number> {
      return ledger.clear(taskId);
    },
  };
}

class RunLedger {
  private runs: TaskRun[] = [];
  readonly byId = new Map<string, TaskRun>();
  private loadPromise: Promise<void> | null = null;
  private dirty = false;
  private writeChain: Promise<void> = Promise.resolve();
  private readonly globalLimit: number;
  private readonly perTaskLimit: number;
  private readonly maxAgeMs: number;

  constructor(
    private readonly file: string,
    limits?: HistoryLimits,
  ) {
    this.globalLimit =
      typeof limits?.globalLimit === 'number' && Number.isFinite(limits.globalLimit) && limits.globalLimit >= 1
        ? Math.trunc(limits.globalLimit)
        : TASK_RUNS_GLOBAL_LIMIT;
    this.perTaskLimit =
      typeof limits?.perTask === 'number' && Number.isFinite(limits.perTask) && limits.perTask >= 1
        ? Math.trunc(limits.perTask)
        : TASK_RUNS_PER_TASK;
    this.maxAgeMs =
      typeof limits?.maxAgeMs === 'number' && Number.isFinite(limits.maxAgeMs) && limits.maxAgeMs > 0
        ? limits.maxAgeMs
        : TASK_RUNS_MAX_AGE_MS;
  }

  async ensureLoaded(): Promise<void> {
    if (this.loadPromise === null) {
      this.loadPromise = this.load();
    }
    await this.loadPromise;
  }

  async latest(taskId: string): Promise<TaskRun | undefined> {
    await this.ensureLoaded();
    const run = this.runs.find((item) => item.taskId === taskId);
    return run === undefined ? undefined : cloneRun(run);
  }

  private async load(): Promise<void> {
    let raw = '';
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    const byId = new Map<string, TaskRun>();
    const now = new Date().toISOString();
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const run = coerceRun(parsed);
      if (run === undefined) continue;
      if (run.status === 'running') {
        // worker 重启后不可能还有存活进程：把残留的 running 标为 failed
        run.status = 'failed';
        run.finishedAt = now;
        run.exitCode = null;
        run.durationMs = null;
        this.dirty = true;
      }
      byId.set(run.id, run);
    }

    this.runs = [...byId.values()].sort(compareRuns);
    this.byId.clear();
    for (const run of this.runs) this.byId.set(run.id, run);
    this.applyTrim();
    if (this.dirty) {
      await this.flush();
    }
  }

  async append(run: TaskRun): Promise<void> {
    await this.ensureLoaded();
    const record = cloneRun(run);
    this.byId.set(record.id, record);
    this.runs = [record, ...this.runs.filter((item) => item.id !== record.id)].sort(compareRuns);
    await this.appendLine(record);
    this.applyTrim();
    if (this.dirty) await this.flush();
  }

  async update(id: string, patch: Partial<TaskRun>): Promise<TaskRun> {
    await this.ensureLoaded();
    const current = this.byId.get(id);
    if (current === undefined) {
      throw new PanelError('NOT_FOUND', '任务运行记录不存在', { resource: 'task_run', id });
    }
    const next: TaskRun = { ...current, ...definedOnly(patch) };
    this.byId.set(id, next);
    this.runs = this.runs.map((item) => (item.id === id ? next : item)).sort(compareRuns);
    await this.appendLine(next);
    return cloneRun(next);
  }

  async list(
    taskId: string | undefined,
    q: PageQuery & { status?: TaskRunStatus },
  ): Promise<ListResult<TaskRun>> {
    await this.ensureLoaded();
    const filtered = this.runs.filter((run) => {
      if (taskId !== undefined && run.taskId !== taskId) return false;
      if (q.status !== undefined && run.status !== q.status) return false;
      return true;
    });
    const limit = typeof q.limit === 'number' && q.limit >= 1 ? Math.min(q.limit, 200) : 50;
    const offset = decodeCursor(q.cursor);
    const items = filtered.slice(offset, offset + limit).map(cloneRun);
    const nextOffset = offset + items.length;
    const result: ListResult<TaskRun> = {
      available: true,
      items,
      total: filtered.length,
    };
    if (nextOffset < filtered.length && items.length > 0) {
      result.nextCursor = String(nextOffset);
    }
    return result;
  }

  async trim(): Promise<void> {
    await this.ensureLoaded();
    this.applyTrim();
    if (this.dirty) await this.flush();
  }

  async trimTask(taskId: string): Promise<void> {
    await this.ensureLoaded();
    const kept: TaskRun[] = [];
    let perTask = 0;
    for (const run of this.runs) {
      if (run.taskId === taskId) {
        if (perTask >= this.perTaskLimit) {
          this.dirty = true;
          continue;
        }
        perTask += 1;
      }
      kept.push(run);
    }
    this.runs = kept;
    this.reindex();
    if (this.dirty) await this.flush();
  }

  async clear(taskId: string): Promise<number> {
    await this.ensureLoaded();
    const before = this.runs.length;
    this.runs = this.runs.filter((run) => run.taskId !== taskId);
    const removed = before - this.runs.length;
    if (removed > 0) {
      this.dirty = true;
      this.reindex();
      await this.flush();
    }
    return removed;
  }

  /** 在内存中执行裁剪，返回是否发生变化。 */
  private applyTrim(): void {
    const now = Date.now();
    const perTask = new Map<string, number>();
    const kept: TaskRun[] = [];
    for (const run of this.runs) {
      const started = Date.parse(run.startedAt);
      if (Number.isFinite(started) && now - started > this.maxAgeMs) {
        this.dirty = true;
        continue;
      }
      const used = perTask.get(run.taskId) ?? 0;
      if (used >= this.perTaskLimit) {
        this.dirty = true;
        continue;
      }
      if (kept.length >= this.globalLimit) {
        this.dirty = true;
        break;
      }
      perTask.set(run.taskId, used + 1);
      kept.push(run);
    }
    if (kept.length !== this.runs.length) {
      this.runs = kept;
      this.reindex();
    }
  }

  private reindex(): void {
    this.byId.clear();
    for (const run of this.runs) this.byId.set(run.id, run);
  }

  private async appendLine(run: TaskRun): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.appendFile(this.file, `${JSON.stringify(run)}\n`, 'utf8');
  }

  private async flush(): Promise<void> {
    const payload = this.runs.map((run) => JSON.stringify(run)).join('\n');
    const body = payload.length === 0 ? '' : `${payload}\n`;
    const previous = this.writeChain;
    const current = previous.then(() => writeFileAtomic(this.file, body));
    this.writeChain = current.catch(() => {
      // 保证后续写入仍能排队；错误由本次调用方感知
    });
    await current;
    this.dirty = false;
  }
}

function compareRuns(a: TaskRun, b: TaskRun): number {
  const delta = Date.parse(b.startedAt) - Date.parse(a.startedAt);
  if (Number.isFinite(delta) && delta !== 0) return delta;
  return a.id.localeCompare(b.id);
}

function cloneRun(run: TaskRun): TaskRun {
  return { ...run };
}

function definedOnly(patch: Partial<TaskRun>): Partial<TaskRun> {
  const result: Partial<TaskRun> = {};
  for (const [key, value] of Object.entries(patch) as [keyof TaskRun, TaskRun[keyof TaskRun]][]) {
    if (value !== undefined) {
      (result as Record<string, unknown>)[key] = value;
    }
  }
  return result;
}

function coerceRun(value: unknown): TaskRun | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== 'string' || typeof raw.taskId !== 'string') return undefined;
  if (typeof raw.startedAt !== 'string' || Number.isNaN(Date.parse(raw.startedAt))) return undefined;
  const status =
    raw.status === 'running' ||
    raw.status === 'success' ||
    raw.status === 'failed' ||
    raw.status === 'timeout' ||
    raw.status === 'skipped'
      ? raw.status
      : 'failed';
  return {
    id: raw.id,
    taskId: raw.taskId,
    status,
    triggeredBy: raw.triggeredBy === 'manual' ? 'manual' : 'schedule',
    startedAt: raw.startedAt,
    finishedAt: typeof raw.finishedAt === 'string' ? raw.finishedAt : null,
    exitCode: typeof raw.exitCode === 'number' ? raw.exitCode : null,
    durationMs: typeof raw.durationMs === 'number' ? raw.durationMs : null,
    stdoutTail: typeof raw.stdoutTail === 'string' ? raw.stdoutTail : '',
    stderrTail: typeof raw.stderrTail === 'string' ? raw.stderrTail : '',
    truncated: raw.truncated === true,
    logPath: typeof raw.logPath === 'string' ? raw.logPath : null,
  };
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
