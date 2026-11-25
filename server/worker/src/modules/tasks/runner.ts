import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
  PanelError,
  type CommandStream,
  type ModuleLogger,
  type ShellRunner,
  type Task,
  type TaskRun,
} from '@mpanel/shared';

/** run 记录中 stdout/stderr 尾部上限（需求：4 KiB）。 */
export const TASK_TAIL_BYTES = 4 * 1024;
/** 每个任务保留的完整日志文件数（与历史 50 次对齐）。 */
const TASK_LOG_KEEP = 50;
/** 超时兜底：ShellRunner 自身超时之外的额外保护。 */
const TIMEOUT_GRACE_MS = 2_000;
/** 默认任务超时（秒）。 */
const DEFAULT_TIMEOUT_SEC = 300;

export interface TaskRunDeps {
  runner: ShellRunner;
  store: {
    appendRun(run: TaskRun): Promise<void>;
    updateRun(id: string, patch: Partial<TaskRun>): Promise<TaskRun>;
  };
  logger: ModuleLogger;
  /** 默认 shell（MPANEL_TASK_SHELL）；为空时由 ShellRunner 选择。 */
  shell?: string;
  /** 完整日志目录（$MPANEL_HOME/logs/tasks）；缺省则不落文件。 */
  logsDir?: string;
}

interface ActiveRun {
  readonly runId: string;
  readonly taskId: string;
  cancelled: boolean;
  kill: (() => void) | null;
}

/**
 * 进程内活动 run 注册表。用于：
 * - overlap=skip 判断同一任务是否仍在运行；
 * - DELETE 任务 / worker 关闭时终止进程树；
 * - 识别被手动终止的 run。
 */
const activeRuns = new Map<string, ActiveRun>();
const activeByTask = new Map<string, Set<string>>();

export function hasActiveRun(taskId: string): boolean {
  const set = activeByTask.get(taskId);
  return set !== undefined && set.size > 0;
}

/** 终止某任务当前所有 run，返回被终止的 runId 列表。 */
export function killTaskRuns(taskId: string): string[] {
  const set = activeByTask.get(taskId);
  if (set === undefined) return [];
  const ids = [...set];
  for (const id of ids) {
    const run = activeRuns.get(id);
    if (run === undefined) continue;
    run.cancelled = true;
    try {
      run.kill?.();
    } catch {
      // ignore
    }
  }
  return ids;
}

/** 终止所有活动 run（worker 关闭时调用）。 */
export function killAllRuns(): string[] {
  const ids = [...activeRuns.keys()];
  for (const id of ids) {
    const run = activeRuns.get(id);
    if (run === undefined) continue;
    run.cancelled = true;
    try {
      run.kill?.();
    } catch {
      // ignore
    }
  }
  return ids;
}

export function activeRunCount(): number {
  return activeRuns.size;
}

/**
 * 启动一次任务运行。函数在 run 记录写入后立即返回（status=running），
 * 实际进程在后台执行并在结束时更新同一条 run 记录；overlap=skip 且已有
 * 同任务 run 时改为写入一条 skipped 记录并返回。
 */
export async function runTask(
  deps: TaskRunDeps,
  task: Task,
  triggeredBy: 'schedule' | 'manual',
): Promise<TaskRun> {
  if (task.overlap === 'skip' && hasActiveRun(task.id)) {
    const skipped = buildRecord(task.id, triggeredBy, 'skipped', new Date());
    await deps.store.appendRun(skipped);
    deps.logger.info('计划任务上一轮仍在运行，按 overlap=skip 跳过', {
      taskId: task.id,
      runId: skipped.id,
    });
    return skipped;
  }

  const run = buildRecord(task.id, triggeredBy, 'running', new Date());
  const active: ActiveRun = {
    runId: run.id,
    taskId: task.id,
    cancelled: false,
    kill: null,
  };
  registerActive(active);
  try {
    await deps.store.appendRun(run);
  } catch (error) {
    unregisterActive(active);
    throw error;
  }
  void executeRun(deps, task, run, active).catch((error: unknown) => {
    deps.logger.error('计划任务运行出现未处理错误', {
      taskId: task.id,
      runId: run.id,
      error: errorMessage(error),
    });
  });
  return run;
}

async function executeRun(
  deps: TaskRunDeps,
  task: Task,
  run: TaskRun,
  active: ActiveRun,
): Promise<void> {
  const startedMs = Date.now();
  let stream: CommandStream | null = null;
  let timedOut = false;
  let timeoutTimer: NodeJS.Timeout | null = null;
  const stdoutTail = new TailBuffer(TASK_TAIL_BYTES);
  const stderrTail = new TailBuffer(TASK_TAIL_BYTES);

  try {
    if (task.cwd !== null) {
      try {
        const stat = await fs.stat(task.cwd);
        if (!stat.isDirectory()) {
          throw new Error('不是目录');
        }
      } catch (error) {
        throw new PanelError('BAD_REQUEST', `任务工作目录无效: ${task.cwd}`, {
          taskId: task.id,
          cwd: task.cwd,
          reason: errorMessage(error),
        });
      }
    }

    const timeoutSec =
      typeof task.timeoutSec === 'number' && Number.isFinite(task.timeoutSec)
        ? Math.min(86_400, Math.max(1, Math.trunc(task.timeoutSec)))
        : DEFAULT_TIMEOUT_SEC;
    const env = sanitizeTaskEnv(task.env);
    // 统一解析默认 shell（POSIX $SHELL / Windows ComSpec），再交给 ShellRunner；
    // 命令始终作为单个 argv 元素传入，绝不拼接 shell 字符串。
    const invocation = buildShellArgs(deps.shell, task.command);
    stream = deps.runner.streamShell(task.command, {
      shell: invocation.command,
      ...(task.cwd === null ? {} : { cwd: task.cwd }),
      env,
      timeoutMs: timeoutSec * 1000,
    });
    active.kill = (): void => {
      try {
        stream?.kill('SIGKILL');
      } catch {
        // 进程可能已退出
      }
    };
    if (active.cancelled) active.kill();

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      active.kill?.();
    }, timeoutSec * 1000 + TIMEOUT_GRACE_MS);
    timeoutTimer.unref?.();

    await Promise.all([
      consume(stream.stdout, stdoutTail),
      consume(stream.stderr, stderrTail),
    ]);
    const result = await stream.completion;

    const status =
      timedOut || result.timedOut
        ? 'timeout'
        : active.cancelled
          ? 'failed'
          : result.code === 0
            ? 'success'
            : 'failed';
    const finishedAt = new Date();
    const stdout = stdoutTail.read() || result.stdout.slice(-TASK_TAIL_BYTES);
    const stderr = stderrTail.read() || result.stderr.slice(-TASK_TAIL_BYTES);
    const logPath = await writeRunLog(deps, task, run, result.stdout, result.stderr, deps.logger);
    const patch: Partial<TaskRun> = {
      status,
      finishedAt: finishedAt.toISOString(),
      exitCode: result.code,
      durationMs: finishedAt.getTime() - startedMs,
      stdoutTail: stdout,
      stderrTail: stderr,
      truncated: stdoutTail.truncated || stderrTail.truncated || result.truncated,
      logPath,
    };
    await deps.store.updateRun(run.id, patch);
    deps.logger.info('计划任务运行结束', {
      taskId: task.id,
      runId: run.id,
      status,
      exitCode: result.code,
      durationMs: patch.durationMs,
    });
  } catch (error) {
    if (stream !== null) {
      // 避免完成 Promise 的迟到拒绝变成未处理异常
      void Promise.resolve(stream.completion).catch(() => undefined);
    }
    const finishedAt = new Date();
    const message = errorMessage(error);
    try {
      await deps.store.updateRun(run.id, {
        status: 'failed',
        finishedAt: finishedAt.toISOString(),
        exitCode: null,
        durationMs: finishedAt.getTime() - startedMs,
        stdoutTail: stdoutTail.read(),
        stderrTail: stderrTail.read() || message,
        truncated: stdoutTail.truncated || stderrTail.truncated,
        logPath: null,
      });
    } catch (updateError) {
      deps.logger.error('写入任务运行结果失败', {
        taskId: task.id,
        runId: run.id,
        error: errorMessage(updateError),
      });
    }
    deps.logger.warn('计划任务运行失败', {
      taskId: task.id,
      runId: run.id,
      error: message,
    });
  } finally {
    if (timeoutTimer !== null) clearTimeout(timeoutTimer);
    unregisterActive(active);
  }
}

async function consume(iterable: AsyncIterable<Uint8Array>, tail: TailBuffer): Promise<void> {
  const decoder = new StringDecoder('utf8');
  try {
    for await (const chunk of iterable) {
      tail.push(Buffer.from(decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)), 'utf8'));
    }
  } catch {
    // 进程被终止时流可能抛错；已收集的输出仍然有效
  } finally {
    const rest = decoder.end();
    if (rest.length > 0) tail.push(Buffer.from(rest, 'utf8'));
  }
}

function registerActive(active: ActiveRun): void {
  activeRuns.set(active.runId, active);
  let set = activeByTask.get(active.taskId);
  if (set === undefined) {
    set = new Set();
    activeByTask.set(active.taskId, set);
  }
  set.add(active.runId);
}

function unregisterActive(active: ActiveRun): void {
  activeRuns.delete(active.runId);
  const set = activeByTask.get(active.taskId);
  if (set !== undefined) {
    set.delete(active.runId);
    if (set.size === 0) activeByTask.delete(active.taskId);
  }
}

function buildRecord(
  taskId: string,
  triggeredBy: 'schedule' | 'manual',
  status: TaskRun['status'],
  at: Date,
): TaskRun {
  const iso = at.toISOString();
  const finished = status === 'running' ? null : iso;
  return {
    id: `run_${randomBytes(9).toString('hex')}`,
    taskId,
    status,
    triggeredBy,
    startedAt: iso,
    finishedAt: finished,
    exitCode: null,
    durationMs: status === 'skipped' ? 0 : null,
    stdoutTail: '',
    stderrTail: '',
    truncated: false,
    logPath: null,
  };
}

/** POSIX sh -lc / PowerShell -Command / cmd /c. argv only. */
export function buildShellArgs(
  shell: string | undefined,
  command: string,
): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    const resolved = shell !== undefined && shell.trim().length > 0 ? shell.trim() : process.env.ComSpec ?? 'cmd.exe';
    const base = path.basename(resolved).toLowerCase().replace(/\.exe$/, '');
    if (base === 'powershell' || base === 'pwsh') {
      return {
        command: resolved,
        args: ['-NoProfile', '-NonInteractive', '-Command', command],
      };
    }
    return { command: resolved, args: ['/d', '/s', '/c', command] };
  }
  const resolved =
    shell !== undefined && shell.trim().length > 0
      ? shell.trim()
      : process.env.SHELL ?? '/bin/sh';
  return { command: resolved, args: ['-lc', command] };
}

/**
 * Removes panel credentials (MPANEL_TOKEN, MPANEL_SECRET_KEY, ...) from task env.
 * 同时拒绝非法环境变量名，避免把奇怪键传给子进程。
 */
export function sanitizeTaskEnv(env: Record<string, string | undefined>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (key.toUpperCase().startsWith('MPANEL_')) continue;
    sanitized[key] = value;
  }
  return sanitized;
}

async function writeRunLog(
  deps: TaskRunDeps,
  task: Task,
  run: TaskRun,
  stdout: string,
  stderr: string,
  logger: ModuleLogger,
): Promise<string | null> {
  const logsDir = deps.logsDir;
  if (logsDir === undefined || logsDir.length === 0) return null;
  const safeTask = task.id.replace(/[^A-Za-z0-9_-]/g, '_');
  const safeRun = run.id.replace(/[^A-Za-z0-9_-]/g, '_');
  const dir = path.join(logsDir, safeTask);
  const file = path.join(dir, `${safeRun}.log`);
  try {
    await fs.mkdir(dir, { recursive: true });
    const parts: string[] = [
      `# task ${task.id} run ${run.id}`,
      `# started ${run.startedAt}`,
      '# --- stdout ---',
      stdout,
      '# --- stderr ---',
      stderr,
      '',
    ];
    await fs.writeFile(file, parts.join('\n'), 'utf8');
    await pruneLogs(dir, logger);
    return file;
  } catch (error) {
    logger.warn('写入任务完整日志失败', {
      taskId: task.id,
      runId: run.id,
      error: errorMessage(error),
    });
    return null;
  }
}

async function pruneLogs(dir: string, logger: ModuleLogger): Promise<void> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files: { file: string; mtime: number }[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.log')) continue;
      const stat = await fs.stat(path.join(dir, entry.name));
      files.push({ file: path.join(dir, entry.name), mtime: stat.mtimeMs });
    }
    if (files.length <= TASK_LOG_KEEP) return;
    files.sort((a, b) => b.mtime - a.mtime);
    for (const item of files.slice(TASK_LOG_KEEP)) {
      await fs.rm(item.file, { force: true });
    }
  } catch (error) {
    logger.warn('清理任务日志失败', { dir, error: errorMessage(error) });
  }
}

/** 保留尾部 N 字节的 UTF-8 缓冲。 */
class TailBuffer {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private dropped = false;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    while (this.bytes > this.limit && this.chunks.length > 1) {
      const removed = this.chunks.shift();
      if (removed !== undefined) {
        this.bytes -= removed.length;
        this.dropped = true;
      }
    }
    if (this.bytes > this.limit && this.chunks.length === 1) {
      const single = this.chunks[0] ?? Buffer.alloc(0);
      this.chunks = [single.subarray(single.length - this.limit)];
      this.bytes = this.limit;
      this.dropped = true;
    }
  }

  get truncated(): boolean {
    return this.dropped;
  }

  read(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
