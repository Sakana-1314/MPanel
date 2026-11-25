import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PanelError } from '@mpanel/shared';
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
  CommandStream,
  ShellRunOptions,
  ShellRunner,
} from '@mpanel/shared';
import type { WorkerLogger } from './logger.js';

/**
 * 命令执行器：只用 spawn/execFile + argv 数组，绝不拼接 shell 字符串。
 * ShellRunner 是可信属主的任务模块专用例外，用显式 shell 可执行文件 + 参数实现。
 */

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFER_BYTES = 8 * 1024 * 1024;
const STREAM_HIGH_WATER = 1024 * 1024;
const STREAM_LOW_WATER = 256 * 1024;
const KILL_GRACE_MS = 2_000;

/** 继承进程环境时允许保留的键（大小写按原样匹配，Windows 额外项）。 */
const ENV_ALLOWLIST = new Set([
  'PATH',
  'Path',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'TZ',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'SYSTEMROOT',
  'SystemRoot',
  'SYSTEMDRIVE',
  'SystemDrive',
  'WINDIR',
  'windir',
  'COMSPEC',
  'ComSpec',
  'PATHEXT',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
]);

/** 即使在 inheritEnv 模式下也必须剔除的敏感变量。 */
function isForbiddenEnvKey(key: string): boolean {
  return (
    /^MPANEL_/i.test(key) ||
    /^(PGPASSWORD|REDISCLI_AUTH|NODE_OPTIONS|NODE_EXTRA_CA_CERTS|ELECTRON_RUN_AS_NODE)$/i.test(key)
  );
}

function minimalBaseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function buildEnv(
  options: CommandOptions | ShellRunOptions | undefined,
  baseEnv: Record<string, string> | undefined,
): Record<string, string> {
  let env: Record<string, string> = {};
  if (options?.inheritEnv === true) {
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined || isForbiddenEnvKey(key)) continue;
      env[key] = value;
    }
  } else {
    env = { ...minimalBaseEnv(), ...(baseEnv ?? {}) };
  }
  for (const [key, value] of Object.entries(options?.env ?? {})) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

function toBuffer(input: string | Uint8Array): Buffer {
  return typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
}

function normalizeResult(
  command: string,
  args: readonly string[],
  stdout: string,
  stderr: string,
  startedAt: number,
  extra: { code: number | null; signal: string | null; truncated: boolean; timedOut: boolean },
): CommandResult {
  return {
    command,
    args: [...args],
    code: extra.code,
    signal: extra.signal,
    stdout,
    stderr,
    durationMs: Math.max(0, Date.now() - startedAt),
    truncated: extra.truncated,
    timedOut: extra.timedOut,
  };
}

/** 有界字节队列：消费者慢时暂停子进程，超过硬上限后丢弃并标记截断。 */
class ByteQueue implements AsyncIterable<Uint8Array> {
  private readonly chunks: Buffer[] = [];
  private buffered = 0;
  private ended = false;
  private failure: Error | null = null;
  private readonly waiters: Array<(result: { value: Buffer | null; error: Error | null }) => void> = [];

  constructor(
    private readonly maxBytes: number,
    private readonly onHighWater?: (paused: boolean) => void,
  ) {}

  get truncated(): boolean {
    return this.dropped;
  }

  private dropped = false;

  push(chunk: Buffer): void {
    if (this.ended) return;
    if (this.buffered + chunk.length > this.maxBytes) {
      const allowed = Math.max(0, this.maxBytes - this.buffered);
      if (allowed > 0) {
        this.chunks.push(chunk.subarray(0, allowed));
        this.buffered += allowed;
        this.wake();
      }
      if (!this.dropped) {
        this.dropped = true;
        this.onHighWater?.(true);
      }
      return;
    }
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    if (this.buffered >= STREAM_HIGH_WATER) this.onHighWater?.(true);
    this.wake();
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.wake();
  }

  fail(error: Error): void {
    if (this.ended) return;
    this.failure = error;
    this.ended = true;
    this.wake();
  }

  private wake(): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (waiter === undefined) break;
      if (this.chunks.length > 0) {
        const chunk = this.chunks.shift() as Buffer;
        this.buffered -= chunk.length;
        if (this.buffered <= STREAM_LOW_WATER) this.onHighWater?.(false);
        waiter({ value: chunk, error: null });
        continue;
      }
      if (this.failure !== null) {
        waiter({ value: null, error: this.failure });
        continue;
      }
      if (this.ended) {
        waiter({ value: null, error: null });
        continue;
      }
      this.waiters.unshift(waiter);
      break;
    }
  }

  private next(): Promise<Buffer | null> {
    if (this.chunks.length > 0) {
      const chunk = this.chunks.shift() as Buffer;
      this.buffered -= chunk.length;
      if (this.buffered <= STREAM_LOW_WATER) this.onHighWater?.(false);
      return Promise.resolve(chunk);
    }
    if (this.failure !== null) return Promise.reject(this.failure);
    if (this.ended) return Promise.resolve(null);
    return new Promise<Buffer | null>((resolve, reject) => {
      this.waiters.push((result) => {
        if (result.error !== null) reject(result.error);
        else resolve(result.value);
      });
    });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    while (true) {
      const chunk = await this.next();
      if (chunk === null) return;
      yield chunk;
    }
  }
}

interface Collected {
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
}

function appendCollected(collected: Collected, chunk: Buffer, maxBytes: number): void {
  if (collected.bytes + chunk.length > maxBytes) {
    const allowed = Math.max(0, maxBytes - collected.bytes);
    if (allowed > 0) {
      collected.chunks.push(chunk.subarray(0, allowed));
      collected.bytes += allowed;
    }
    collected.truncated = true;
    return;
  }
  collected.chunks.push(chunk);
  collected.bytes += chunk.length;
}

function collectedText(collected: Collected): string {
  return Buffer.concat(collected.chunks).toString('utf8');
}

function spawnArgs(options: CommandOptions | ShellRunOptions | undefined): readonly string[] {
  return options !== undefined && 'args' in options ? options.args ?? [] : [];
}

function spawnInput(
  options: CommandOptions | ShellRunOptions | undefined,
): string | Uint8Array | undefined {
  return options !== undefined && 'input' in options ? options.input : undefined;
}

interface SpawnSpec {
  command: string;
  args: string[];
  options: CommandOptions | ShellRunOptions | undefined;
  baseEnv: Record<string, string> | undefined;
  timeoutMs: number;
  maxBufferBytes: number;
  /**
   * Windows 下 cmd.exe/powershell 的 `-c/-Command <script>` 必须以原样命令行
   * 传递；否则 Node 会给引号加反斜杠转义，cmd 再把转义符号交给子进程，
   * 带双引号的 `node -e "<script>"` 会静默无输出。仅用于 ShellRunner。
   */
  windowsVerbatimArguments?: boolean;
}

function createChildProcess(spec: SpawnSpec): ChildProcess {
  const args = [...spawnArgs(spec.options), ...spec.args];
  try {
    return spawn(spec.command, args, {
      cwd: spec.options?.cwd,
      env: buildEnv(spec.options, spec.baseEnv),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
      ...(process.platform === 'win32' && spec.windowsVerbatimArguments === true
        ? { windowsVerbatimArguments: true }
        : {}),
    });
  } catch (cause) {
    throw new PanelError('INTERNAL', '无法启动子进程', { command: spec.command }, { cause });
  }
}

function attachInput(child: ChildProcess, input: string | Uint8Array | undefined): void {
  if (child.stdin === null) return;
  child.stdin.on('error', () => {
    // 进程提前退出导致的 EPIPE 不影响结果。
  });
  if (input !== undefined) {
    child.stdin.end(toBuffer(input));
  } else {
    child.stdin.end();
  }
}

function runCollected(spec: SpawnSpec, logger: WorkerLogger): Promise<CommandResult> {
  const startedAt = Date.now();
  const stdout: Collected = { chunks: [], bytes: 0, truncated: false };
  const stderr: Collected = { chunks: [], bytes: 0, truncated: false };
  return new Promise<CommandResult>((resolve) => {
    let child: ChildProcess;
    try {
      child = createChildProcess(spec);
    } catch (error) {
      resolve(
        normalizeResult(spec.command, spec.args, '', `无法启动命令：${String(error)}`, startedAt, {
          code: null,
          signal: null,
          truncated: false,
          timedOut: false,
        }),
      );
      return;
    }
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const finish = (code: number | null, signal: string | null, spawnError?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (spawnError !== undefined) {
        appendCollected(
          stderr,
          Buffer.from(`无法启动命令：${spawnError.message}`, 'utf8'),
          spec.maxBufferBytes,
        );
      }
      const result = normalizeResult(
        spec.command,
        spec.args,
        collectedText(stdout),
        collectedText(stderr),
        startedAt,
        {
          code,
          signal,
          truncated: stdout.truncated || stderr.truncated,
          timedOut,
        },
      );
      logger.debug('命令执行结束', {
        command: spec.command,
        argc: spec.args.length,
        code,
        durationMs: result.durationMs,
        timedOut,
      });
      resolve(result);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      appendCollected(stdout, chunk, spec.maxBufferBytes);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      appendCollected(stderr, chunk, spec.maxBufferBytes);
    });
    child.on('error', (error) => {
      finish(null, null, error);
    });
    child.on('close', (code, signal) => {
      finish(code, signal);
    });
    attachInput(child, spawnInput(spec.options));
    timer = setTimeout(() => {
      timedOut = true;
      logger.warn('命令超时，终止进程树', {
        command: spec.command,
        argc: spec.args.length,
        timeoutMs: spec.timeoutMs,
      });
      void killProcessTree(child).finally(() => {
        // 极端情况下 close 事件不再到达，2s 后强制结算。
        const force = setTimeout(() => finish(null, 'SIGKILL'), KILL_GRACE_MS);
        force.unref();
      });
    }, spec.timeoutMs);
    timer.unref?.();
  });
}

function streamProcess(spec: SpawnSpec, logger: WorkerLogger): CommandStream {
  const startedAt = Date.now();
  const stdoutQueue = new ByteQueue(spec.maxBufferBytes, (paused) => {
    if (child.stdout === null) return;
    if (paused) child.stdout.pause();
    else child.stdout.resume();
  });
  const stderrQueue = new ByteQueue(spec.maxBufferBytes, (paused) => {
    if (child.stderr === null) return;
    if (paused) child.stderr.pause();
    else child.stderr.resume();
  });
  let child: ChildProcess;
  try {
    child = createChildProcess(spec);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stdoutQueue.end();
    stderrQueue.end();
    return {
      stdout: stdoutQueue,
      stderr: stderrQueue,
      completion: Promise.resolve(
        normalizeResult(spec.command, spec.args, '', message, startedAt, {
          code: null,
          signal: null,
          truncated: false,
          timedOut: false,
        }),
      ),
      kill: () => undefined,
    };
  }
  let timedOut = false;
  let timer: NodeJS.Timeout | null = null;
  const completion = new Promise<CommandResult>((resolve) => {
    let settled = false;
    const finish = (code: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      stdoutQueue.end();
      stderrQueue.end();
      resolve(
        normalizeResult(spec.command, spec.args, '', '', startedAt, {
          code,
          signal,
          truncated: stdoutQueue.truncated || stderrQueue.truncated,
          timedOut,
        }),
      );
    };
    child.stdout?.on('data', (chunk: Buffer) => stdoutQueue.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrQueue.push(chunk));
    child.stdout?.on('end', () => stdoutQueue.end());
    child.stderr?.on('end', () => stderrQueue.end());
    child.on('error', () => {
      stdoutQueue.fail(new Error('子进程启动失败'));
      stderrQueue.fail(new Error('子进程启动失败'));
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
    attachInput(child, spawnInput(spec.options));
    timer = setTimeout(() => {
      timedOut = true;
      logger.warn('流式命令超时，终止进程树', {
        command: spec.command,
        timeoutMs: spec.timeoutMs,
      });
      void killProcessTree(child);
    }, spec.timeoutMs);
    timer.unref?.();
  });
  return {
    stdout: stdoutQueue,
    stderr: stderrQueue,
    completion,
    kill: (signal?: string) => {
      void killProcessTree(child, signal).catch(() => undefined);
    },
  };
}

function shellInvocation(specified: string | undefined, command: string): { shell: string; args: string[] } {
  const shell = specified ?? (process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : '/bin/sh');
  const base = path.basename(shell).toLowerCase();
  if (base === 'powershell.exe' || base === 'powershell' || base === 'pwsh' || base === 'pwsh.exe') {
    return { shell, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command] };
  }
  if (base === 'cmd.exe' || base === 'cmd') {
    return { shell, args: ['/d', '/s', '/c', command] };
  }
  return { shell, args: ['-c', command] };
}

/** cmd.exe/powershell 的原始命令串必须作为 verbatim 命令行传递（见 SpawnSpec）。 */
function needsVerbatimShell(shell: string): boolean {
  if (process.platform !== 'win32') return false;
  const base = path.basename(shell).toLowerCase().replace(/\.exe$/, '');
  return base === 'cmd' || base === 'powershell' || base === 'pwsh';
}

export function createCommandRunner(
  logger: WorkerLogger,
  opts?: { defaultTimeoutMs?: number; maxBufferBytes?: number; baseEnv?: Record<string, string> },
): CommandRunner & ShellRunner {
  const defaultTimeoutMs = Math.max(1, opts?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  const maxBufferBytes = Math.max(64, opts?.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES);
  const baseEnv = opts?.baseEnv;

  const resolveSpec = (
    command: string,
    args: readonly string[],
    options: CommandOptions | undefined,
  ): SpawnSpec => {
    if (typeof command !== 'string' || command.trim().length === 0) {
      throw new PanelError('BAD_REQUEST', '命令不能为空');
    }
    if (args.some((arg) => typeof arg !== 'string')) {
      throw new PanelError('BAD_REQUEST', '命令参数必须是字符串数组');
    }
    return {
      command,
      args: [...args],
      options,
      baseEnv,
      timeoutMs: Math.max(1, options?.timeoutMs ?? defaultTimeoutMs),
      maxBufferBytes: Math.max(64, options?.maxBufferBytes ?? maxBufferBytes),
    };
  };

  return {
    run(command: string, args: readonly string[], options?: CommandOptions): Promise<CommandResult> {
      return runCollected(resolveSpec(command, args, options), logger);
    },
    stream(command: string, args: readonly string[], options?: CommandOptions): CommandStream {
      return streamProcess(resolveSpec(command, args, options), logger);
    },
    async which(command: string): Promise<string | null> {
      return whichBinary(command, baseEnv);
    },
    runShell(command: string, options?: ShellRunOptions): Promise<CommandResult> {
      const invocation = shellInvocation(options?.shell, command);
      const spec = resolveSpec(invocation.shell, invocation.args, options);
      return runCollected(
        { ...spec, windowsVerbatimArguments: needsVerbatimShell(invocation.shell) },
        logger,
      );
    },
    streamShell(command: string, options?: ShellRunOptions): CommandStream {
      const invocation = shellInvocation(options?.shell, command);
      const spec = resolveSpec(invocation.shell, invocation.args, options);
      return streamProcess(
        { ...spec, windowsVerbatimArguments: needsVerbatimShell(invocation.shell) },
        logger,
      );
    },
  };
}

async function isExecutable(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function whichBinary(
  command: string,
  baseEnv: Record<string, string> | undefined,
): Promise<string | null> {
  if (typeof command !== 'string' || command.trim().length === 0) return null;
  const trimmed = command.trim();
  if (trimmed.includes('/') || trimmed.includes('\\') || /^[A-Za-z]:/.test(trimmed)) {
    const resolved = path.resolve(trimmed);
    return (await isExecutable(resolved)) ? resolved : null;
  }
  const pathValue = baseEnv?.PATH ?? process.env.PATH ?? process.env.Path ?? '';
  const directories = pathValue.split(path.delimiter).filter((entry) => entry.length > 0);
  if (directories.length === 0) return null;
  const extensions =
    process.platform === 'win32'
      ? (baseEnv?.PATHEXT ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter((entry) => entry.length > 0)
      : [''];
  const hasExtension = path.extname(trimmed).length > 0;
  for (const directory of directories) {
    const candidates = hasExtension
      ? [path.join(directory, trimmed)]
      : [
          path.join(directory, trimmed),
          ...extensions.map((extension) => path.join(directory, `${trimmed}${extension}`)),
        ];
    for (const candidate of candidates) {
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

async function processAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export async function killProcessTree(child: ChildProcess, signal = 'SIGTERM'): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      try {
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'ignore'],
          env: minimalBaseEnv(),
        });
        const timer = setTimeout(() => {
          killer.kill('SIGKILL');
          done();
        }, 5_000);
        timer.unref?.();
        killer.on('error', () => {
          clearTimeout(timer);
          done();
        });
        killer.on('close', () => {
          clearTimeout(timer);
          done();
        });
      } catch {
        done();
      }
    });
    try {
      child.kill('SIGKILL');
    } catch {
      // 已退出。
    }
    return;
  }
  // POSIX：子进程以 detached 方式启动，成为进程组组长，负 pid 可覆盖整棵进程树。
  const send = (target: number, sig: NodeJS.Signals): void => {
    try {
      process.kill(target, sig);
    } catch {
      // 进程已退出或权限不足。
    }
  };
  send(-pid, signal as NodeJS.Signals);
  await delay(KILL_GRACE_MS);
  if (await processAlive(pid)) {
    send(-pid, 'SIGKILL');
    try {
      child.kill('SIGKILL');
    } catch {
      // 已退出。
    }
  }
}

/* ------------------------------------------------------------------ */
/* 测试用假实现                                                        */
/* ------------------------------------------------------------------ */

export interface FakeCommandCall {
  kind: 'run' | 'stream' | 'runShell' | 'streamShell' | 'which';
  command: string;
  args: string[];
  options?: CommandOptions | ShellRunOptions;
}

export interface FakeCommandRunner extends CommandRunner, ShellRunner {
  readonly calls: FakeCommandCall[];
  reset(): void;
  setWhich(command: string, resolved: string | null): void;
  setRunResult(command: string, result: Partial<CommandResult> | CommandResult): void;
}

export interface FakeCommandRunnerOptions {
  run?: (command: string, args: readonly string[], options?: CommandOptions) => CommandResult | Promise<CommandResult>;
  stream?: (command: string, args: readonly string[], options?: CommandOptions) => CommandStream;
  runShell?: (command: string, options?: ShellRunOptions) => CommandResult | Promise<CommandResult>;
  streamShell?: (command: string, options?: ShellRunOptions) => CommandStream;
  which?: (command: string) => string | null;
  defaultResult?: Partial<CommandResult>;
}

function fakeResult(
  command: string,
  args: readonly string[],
  overrides: Partial<CommandResult> | undefined,
  options?: CommandOptions | ShellRunOptions,
): CommandResult {
  return {
    command,
    args: [...args],
    code: 0,
    signal: null,
    stdout: '',
    stderr: '',
    durationMs: 0,
    truncated: false,
    timedOut: false,
    ...(options?.timeoutMs !== undefined ? {} : {}),
    ...overrides,
  };
}

function fakeStream(
  command: string,
  args: readonly string[],
  chunks: { stdout?: string[]; stderr?: string[] },
  result: CommandResult,
): CommandStream {
  async function* iterate(items: string[] | undefined): AsyncIterable<Uint8Array> {
    for (const item of items ?? []) {
      yield Buffer.from(item, 'utf8');
    }
  }
  return {
    stdout: iterate(chunks.stdout),
    stderr: iterate(chunks.stderr),
    completion: Promise.resolve(result),
    kill: () => undefined,
  };
}

/** 可注入的假命令执行器：供单元/冒烟测试替换真实二进制。 */
export function createFakeCommandRunner(options: FakeCommandRunnerOptions = {}): FakeCommandRunner {
  const calls: FakeCommandCall[] = [];
  const whichMap = new Map<string, string | null>();
  const runOverrides = new Map<string, Partial<CommandResult> | CommandResult>();
  const base = fakeResult('', [], options.defaultResult);

  const runner: FakeCommandRunner = {
    calls,
    reset(): void {
      calls.length = 0;
      whichMap.clear();
      runOverrides.clear();
    },
    setWhich(command: string, resolved: string | null): void {
      whichMap.set(command, resolved);
    },
    setRunResult(command: string, result: Partial<CommandResult> | CommandResult): void {
      runOverrides.set(command, result);
    },
    run(command: string, args: readonly string[], runOptions?: CommandOptions): Promise<CommandResult> {
      calls.push({ kind: 'run', command, args: [...args], options: runOptions });
      if (options.run !== undefined) return Promise.resolve(options.run(command, args, runOptions));
      const override = runOverrides.get(command) ?? runOverrides.get(path.basename(command));
      return Promise.resolve({ ...base, command, args: [...args], ...(override ?? {}) });
    },
    stream(command: string, args: readonly string[], runOptions?: CommandOptions): CommandStream {
      calls.push({ kind: 'stream', command, args: [...args], options: runOptions });
      if (options.stream !== undefined) return options.stream(command, args, runOptions);
      return fakeStream(command, args, {}, { ...base, command, args: [...args] });
    },
    async which(command: string): Promise<string | null> {
      calls.push({ kind: 'which', command, args: [] });
      if (options.which !== undefined) return options.which(command);
      if (whichMap.has(command)) return whichMap.get(command) ?? null;
      return command;
    },
    runShell(command: string, shellOptions?: ShellRunOptions): Promise<CommandResult> {
      calls.push({ kind: 'runShell', command, args: [], options: shellOptions });
      if (options.runShell !== undefined) {
        return Promise.resolve(options.runShell(command, shellOptions));
      }
      return Promise.resolve({ ...base, command });
    },
    streamShell(command: string, shellOptions?: ShellRunOptions): CommandStream {
      calls.push({ kind: 'streamShell', command, args: [], options: shellOptions });
      if (options.streamShell !== undefined) return options.streamShell(command, shellOptions);
      return fakeStream(command, [], {}, { ...base, command });
    },
  };
  return runner;
}

/** 平台默认临时目录，诊断输出用。 */
export function defaultScratchDir(): string {
  return os.tmpdir();
}
