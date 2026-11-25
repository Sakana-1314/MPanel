import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  PanelError,
  taskCreateSchema,
  taskRunStatusSchema,
  taskUpdateSchema,
  type Task,
  type TaskCreateInput,
  type TaskRunStatus,
  type TaskUpdateInput,
} from '@mpanel/shared';
import type { WorkerModule } from '../../registry.js';
import { isTruthyQuery, parsePage } from '../../util.js';
import { killAllRuns, killTaskRuns, runTask } from './runner.js';
import { computeNextRuns, createTaskScheduler } from './scheduler.js';
import { createTaskStore } from './store.js';

/** Scheduled tasks API 模块：prefixes: ['/tasks']。 */
export function createTasksModule(): WorkerModule {
  return {
    name: 'tasks',
    prefixes: ['/tasks'],
    register(ctx): void {
      const stateDir = path.join(ctx.config.home, 'state');
      const logsDir = path.join(ctx.config.home, 'logs', 'tasks');
      const store = createTaskStore(
        path.join(stateDir, 'tasks.json'),
        path.join(stateDir, 'task-runs.jsonl'),
        { globalLimit: ctx.config.tasks.historyLimit },
      );
      const scheduler = createTaskScheduler({
        config: ctx.config,
        logger: ctx.logger,
        runner: ctx.runner,
        store,
      });
      scheduler.start();

      ctx.app.addHook('onClose', async () => {
        scheduler.stop();
        const killed = killAllRuns();
        if (killed.length > 0) {
          ctx.logger.info('worker 关闭，已终止运行中的计划任务', { runIds: killed });
        }
      });

      const runDeps = {
        runner: ctx.runner,
        store,
        logger: ctx.logger,
        ...(ctx.config.tasks.shell === undefined ? {} : { shell: ctx.config.tasks.shell }),
        logsDir,
      };

      // 静态路径必须先于 /tasks/:id 注册
      ctx.app.get('/tasks/runs', async (request) => {
        const q = asRecord(request.query);
        const page = parsePage(q);
        const taskId = nonEmptyString(q.taskId);
        const status = parseStatus(q.status);
        return ok(
          await store.listRuns({
            ...page,
            ...(taskId === undefined ? {} : { taskId }),
            ...(status === undefined ? {} : { status }),
          }),
        );
      });

      ctx.app.get('/tasks/next-runs', async (request) => {
        const q = asRecord(request.query);
        const cron = nonEmptyString(q.cron);
        if (cron === undefined) {
          throw new PanelError('BAD_REQUEST', '缺少 cron 查询参数', { field: 'cron' });
        }
        const timezone = nonEmptyString(q.timezone) ?? null;
        const count = parseCount(q.count, 5);
        const nextRuns = computeNextRuns(cron, timezone, count).map((at) => ({ at }));
        return ok({ nextRuns });
      });

      ctx.app.get('/tasks', async (request) => {
        const q = asRecord(request.query);
        const page = parsePage(q);
        const enabled = q.enabled === undefined ? undefined : isTruthyQuery(q.enabled);
        const search = nonEmptyString(q.q);
        return ok(
          await store.list({
            ...page,
            ...(enabled === undefined ? {} : { enabled }),
            ...(search === undefined ? {} : { q: search }),
          }),
        );
      });

      ctx.app.post('/tasks', async (request, reply) => {
        const parsed = taskCreateSchema.safeParse(asRecord(request.body));
        if (!parsed.success) throw validationError(parsed.error.issues);
        const input: TaskCreateInput = { ...parsed.data };
        if (input.cwd !== undefined) {
          input.cwd = await normalizeTaskCwd(input.cwd, ctx.config.home);
        }
        const task = await store.create(input);
        scheduler.refresh(task);
        reply.code(201);
        return ok(withNextRuns(task));
      });

      ctx.app.get('/tasks/:id', async (request) => {
        const { id } = request.params as { id: string };
        const task = await store.get(id);
        if (task === undefined) throw taskNotFound(id);
        return ok(task);
      });

      ctx.app.put('/tasks/:id', async (request) => {
        const { id } = request.params as { id: string };
        const existing = await store.get(id);
        if (existing === undefined) throw taskNotFound(id);
        const parsed = taskUpdateSchema.safeParse(asRecord(request.body));
        if (!parsed.success) throw validationError(parsed.error.issues);
        const input: TaskUpdateInput = { ...parsed.data };
        if (input.cwd !== undefined && input.cwd !== null) {
          input.cwd = await normalizeTaskCwd(input.cwd, ctx.config.home);
        }
        const task = await store.update(id, input);
        scheduler.refresh(task);
        return ok(task);
      });

      ctx.app.delete('/tasks/:id', async (request) => {
        const { id } = request.params as { id: string };
        const task = await store.get(id);
        if (task === undefined) throw taskNotFound(id);
        scheduler.remove(id);
        const killed = killTaskRuns(id);
        await store.remove(id);
        return ok({
          deleted: true as const,
          id,
          ...(killed.length > 0 && killed[0] !== undefined ? { killedRun: killed[0] } : {}),
        });
      });

      ctx.app.post('/tasks/:id/run', async (request) => {
        const { id } = request.params as { id: string };
        const task = await store.get(id);
        if (task === undefined) throw taskNotFound(id);
        // disabled 任务也允许手动执行；overlap=skip 时返回 skipped run。
        const run = await runTask(runDeps, task, 'manual');
        return ok({ run });
      });

      ctx.app.get('/tasks/:id/history', async (request) => {
        const { id } = request.params as { id: string };
        const task = await store.get(id);
        if (task === undefined) throw taskNotFound(id);
        const q = asRecord(request.query);
        const page = parsePage(q);
        const status = parseStatus(q.status);
        return ok(
          await store.listRuns({
            ...page,
            taskId: id,
            ...(status === undefined ? {} : { status }),
          }),
        );
      });

      ctx.app.delete('/tasks/:id/history', async (request) => {
        const { id } = request.params as { id: string };
        const task = await store.get(id);
        if (task === undefined) throw taskNotFound(id);
        const removed = await store.clearHistory(id);
        return ok({ cleared: true as const, id, removed });
      });

      ctx.app.get('/tasks/:id/next-runs', async (request) => {
        const { id } = request.params as { id: string };
        const task = await store.get(id);
        if (task === undefined) throw taskNotFound(id);
        const q = asRecord(request.query);
        const count = parseCount(q.count, 5);
        const nextRuns = scheduler.nextRuns(task, count).map((at) => ({ at }));
        return ok({ nextRuns });
      });
    },
  };
}

function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}

function withNextRuns(task: Task): Task & { nextRuns: { at: string }[] } {
  let nextRuns: { at: string }[] = [];
  try {
    nextRuns = computeNextRuns(task.schedule, task.timezone, 5).map((at) => ({ at }));
  } catch {
    // cron 已在 store 校验；这里仅做展示，失败时返回空数组
    nextRuns = [];
  }
  return { ...task, nextRuns };
}

function taskNotFound(id: string): PanelError {
  return new PanelError('NOT_FOUND', '计划任务不存在', { resource: 'task', id });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function parseStatus(value: unknown): TaskRunStatus | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = taskRunStatusSchema.safeParse(value);
  if (!parsed.success) {
    throw new PanelError('BAD_REQUEST', '无效的运行状态过滤', {
      field: 'status',
      status: value,
      allowed: taskRunStatusSchema.options,
    });
  }
  return parsed.data;
}

function parseCount(value: unknown, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 10) {
    throw new PanelError('BAD_REQUEST', 'count 必须是 1..10 的整数', {
      field: 'count',
      count: value,
    });
  }
  return numeric;
}

function validationError(
  issues: readonly { path: readonly PropertyKey[]; code: string; message: string }[],
): PanelError {
  return new PanelError('BAD_REQUEST', '请求参数校验失败', {
    issues: issues.map((issue) => ({
      path: issue.path.map((part) => String(part)).join('.'),
      code: issue.code,
      message: issue.message,
    })),
  });
}

/** 任务 cwd 必须是已存在的目录；相对路径按 MPANEL_HOME 解析。 */
async function normalizeTaskCwd(raw: string, home: string): Promise<string> {
  const candidate = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(home, raw);
  try {
    const stat = await fs.stat(candidate);
    if (!stat.isDirectory()) {
      throw new PanelError('BAD_REQUEST', '任务工作目录不是目录', { cwd: candidate });
    }
  } catch (error) {
    if (error instanceof PanelError) throw error;
    throw new PanelError('BAD_REQUEST', '任务工作目录不存在或不可访问', {
      cwd: candidate,
      field: 'cwd',
    });
  }
  return candidate;
}
