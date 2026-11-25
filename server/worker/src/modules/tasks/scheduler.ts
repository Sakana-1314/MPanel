import path from 'node:path';
import { Cron } from 'croner';
import { PanelError, type ModuleLogger, type ShellRunner, type Task } from '@mpanel/shared';
import type { WorkerConfig } from '../../config.js';
import type { TaskStore } from './store.js';
import { runTask } from './runner.js';

/** next-runs 数量上限（契约 1..10）。 */
export const MAX_NEXT_RUNS = 10;

export interface TaskScheduler {
  start(): void;
  stop(): void;
  refresh(task: Task): void;
  remove(taskId: string): void;
  nextRuns(task: Task, count: number): string[];
}

export interface TaskSchedulerDeps {
  config: WorkerConfig;
  logger: ModuleLogger;
  runner: ShellRunner;
  store: TaskStore;
}

/** 校验 cron 表达式与时区；非法时抛 BAD_REQUEST。 */
export function validateSchedule(schedule: string, timezone?: string | null): void {
  computeNextRuns(schedule, timezone, 1);
}

/** 计算未来 N 次运行时间（ISO 8601 UTC）。 */
export function computeNextRuns(
  schedule: string,
  timezone: string | null | undefined,
  count: number,
): string[] {
  const pattern = typeof schedule === 'string' ? schedule.trim() : '';
  if (pattern.length === 0) {
    throw new PanelError('BAD_REQUEST', 'cron 表达式不能为空', { field: 'schedule' });
  }
  const zone = typeof timezone === 'string' && timezone.trim().length > 0 ? timezone.trim() : undefined;
  if (zone !== undefined && !isValidTimezone(zone)) {
    throw new PanelError('BAD_REQUEST', `无效的时区: ${zone}`, {
      field: 'timezone',
      timezone: zone,
    });
  }
  const wanted = Number.isFinite(count) ? Math.min(MAX_NEXT_RUNS, Math.max(1, Math.trunc(count))) : 5;
  let cron: Cron | null = null;
  try {
    cron = new Cron(pattern, {
      paused: true,
      unref: true,
      ...(zone === undefined ? {} : { timezone: zone }),
    });
    if (cron.getOnce() !== null) {
      throw new PanelError('BAD_REQUEST', '任务计划必须是 cron 表达式，不能是单次时间', {
        field: 'schedule',
      });
    }
    const dates = cron.nextRuns(wanted);
    if (dates.length === 0) {
      throw new PanelError('BAD_REQUEST', 'cron 表达式没有未来运行时间', {
        field: 'schedule',
        schedule: pattern,
      });
    }
    return dates.map((date) => date.toISOString());
  } catch (error) {
    if (error instanceof PanelError) throw error;
    throw new PanelError('BAD_REQUEST', `无效的 cron 表达式: ${pattern}`, {
      field: 'schedule',
      schedule: pattern,
      timezone: zone ?? null,
      reason: errorMessage(error),
    });
  } finally {
    if (cron !== null) {
      try {
        cron.stop();
      } catch {
        // ignore
      }
    }
  }
}

/** croner-backed scheduler with timezone and overlap handling. */
export function createTaskScheduler(deps: TaskSchedulerDeps): TaskScheduler {
  const { logger, config, store, runner } = deps;
  const jobs = new Map<string, Cron>();
  const logsDir = path.join(config.home, 'logs', 'tasks');
  let started = false;

  const remove = (taskId: string): void => {
    const job = jobs.get(taskId);
    if (job === undefined) return;
    jobs.delete(taskId);
    try {
      job.stop();
    } catch (error) {
      logger.warn('停止计划任务调度失败', { taskId, error: errorMessage(error) });
    }
  };

  const fire = async (taskId: string): Promise<void> => {
    try {
      const task = await store.get(taskId);
      if (task === undefined || !task.enabled) return;
      await runTask(
        {
          runner,
          store,
          logger,
          ...(config.tasks.shell === undefined ? {} : { shell: config.tasks.shell }),
          logsDir,
        },
        task,
        'schedule',
      );
    } catch (error) {
      logger.error('计划任务触发失败', { taskId, error: errorMessage(error) });
    }
  };

  const refresh = (task: Task): void => {
    remove(task.id);
    if (!started || !task.enabled) return;
    try {
      // 先校验再注册，避免非法表达式产生半初始化 job
      validateSchedule(task.schedule, task.timezone);
      const job = new Cron(
        task.schedule,
        {
          unref: true,
          protect: false,
          ...(task.timezone === null ? {} : { timezone: task.timezone }),
          catch: (error: unknown) => {
            logger.error('计划任务调度回调异常', {
              taskId: task.id,
              error: errorMessage(error),
            });
          },
        },
        () => {
          void fire(task.id);
        },
      );
      jobs.set(task.id, job);
      logger.debug('计划任务已注册调度', { taskId: task.id, schedule: task.schedule });
    } catch (error) {
      logger.warn('计划任务 cron 无效，已跳过调度', {
        taskId: task.id,
        schedule: task.schedule,
        error: errorMessage(error),
      });
    }
  };

  const loadAll = async (): Promise<Task[]> => {
    const tasks: Task[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const result = await store.list({ limit: 200, ...(cursor === undefined ? {} : { cursor }) });
      tasks.push(...result.items);
      if (result.nextCursor === undefined || result.nextCursor === null) break;
      cursor = result.nextCursor;
    }
    return tasks;
  };

  const bootstrap = async (): Promise<void> => {
    try {
      const tasks = await loadAll();
      for (const task of tasks) refresh(task);
      logger.info('计划任务调度器已恢复', { total: tasks.length, enabled: jobs.size });
    } catch (error) {
      logger.error('恢复计划任务调度失败', { error: errorMessage(error) });
    }
  };

  return {
    start(): void {
      if (started) return;
      started = true;
      void bootstrap();
    },
    stop(): void {
      started = false;
      for (const taskId of [...jobs.keys()]) remove(taskId);
    },
    refresh,
    remove,
    nextRuns(task: Task, count: number): string[] {
      return computeNextRuns(task.schedule, task.timezone, count);
    },
  };
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
