import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';

/**
 * 终端后端抽象。优先使用可选的 node-pty（真 PTY）；加载失败、平台不支持或
 * 原生绑定不可用时，降级为 child_process.spawn 的管道会话（无 PTY，resize 无效）。
 */
export interface PtyLike {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (code: number | null, signal?: string | null) => void): void;
}

/** Pipe-based fallback: resize is a no-op. */
export interface FallbackPty extends PtyLike {}

export interface PtyModule {
  spawn(...args: unknown[]): PtyLike;
  version: string;
}

/** node-pty 支持的主流平台；其他平台直接降级，避免加载原生模块崩溃。 */
const SUPPORTED_PLATFORMS = new Set(['win32', 'linux', 'darwin', 'freebsd']);

let cachedLoad: Promise<PtyModule | null> | null = null;
let lastLoadReason: string | null = null;

/** 最近一次 node-pty 加载失败的原因；加载成功或尚未加载时为 null。 */
export function ptyLoadReason(): string | null {
  return lastLoadReason;
}

/** Returns null when node-pty is not installed/loadable. */
export function loadPty(): Promise<PtyModule | null> {
  if (cachedLoad === null) {
    cachedLoad = loadPtyInternal();
  }
  return cachedLoad;
}

interface NodePtyProcess {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (event: { exitCode: number; signal?: number }) => void): void;
}

interface NodePtyModule {
  spawn(
    file: string,
    args: string[] | string,
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string>;
      encoding?: string | null;
    },
  ): NodePtyProcess;
}

async function loadPtyInternal(): Promise<PtyModule | null> {
  if (!SUPPORTED_PLATFORMS.has(process.platform)) {
    lastLoadReason = `平台 ${process.platform} 不支持 node-pty，已降级为管道会话`;
    return null;
  }
  try {
    const require = createRequire(import.meta.url);
    const mod = require('node-pty') as NodePtyModule | undefined;
    if (mod === undefined || typeof mod.spawn !== 'function') {
      lastLoadReason = 'node-pty 未导出 spawn，已降级为管道会话';
      return null;
    }
    let version = 'unknown';
    try {
      const pkg = require('node-pty/package.json') as { version?: unknown };
      if (typeof pkg.version === 'string') version = pkg.version;
    } catch {
      // 版本信息缺失不影响使用
    }
    lastLoadReason = null;
    return {
      version,
      spawn: (...args: unknown[]): PtyLike => {
        const file = args[0];
        const argv = args[1];
        const options = args[2];
        if (typeof file !== 'string') {
          throw new TypeError('node-pty shell 必须是字符串路径');
        }
        const spawnOptions = normalizePtyOptions(options);
        const childArgs =
          Array.isArray(argv) ? argv.map((item) => String(item)) : typeof argv === 'string' ? argv : [];
        const proc = mod.spawn(file, childArgs, spawnOptions);
        return wrapNodePty(proc);
      },
    };
  } catch (error) {
    lastLoadReason = `node-pty 加载失败: ${errorMessage(error)}`;
    return null;
  }
}

function normalizePtyOptions(value: unknown): {
  name: string;
  cols: number;
  rows: number;
  cwd?: string;
  env?: Record<string, string>;
} {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const cols = typeof raw.cols === 'number' && Number.isFinite(raw.cols) ? raw.cols : 80;
  const rows = typeof raw.rows === 'number' && Number.isFinite(raw.rows) ? raw.rows : 24;
  const name = typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : 'xterm-256color';
  const cwd = typeof raw.cwd === 'string' && raw.cwd.length > 0 ? raw.cwd : undefined;
  let env: Record<string, string> | undefined;
  if (typeof raw.env === 'object' && raw.env !== null) {
    env = {};
    for (const [key, item] of Object.entries(raw.env as Record<string, unknown>)) {
      if (typeof item === 'string') env[key] = item;
    }
  }
  return { name, cols, rows, ...(cwd === undefined ? {} : { cwd }), ...(env === undefined ? {} : { env }) };
}

function wrapNodePty(proc: NodePtyProcess): PtyLike {
  return {
    get pid(): number {
      return proc.pid;
    },
    write(data: string): void {
      proc.write(data);
    },
    resize(cols: number, rows: number): void {
      try {
        proc.resize(cols, rows);
      } catch {
        // 终端已退出时 resize 会抛错，忽略即可
      }
    },
    pause(): void {
      try {
        proc.pause();
      } catch {
        // ignore
      }
    },
    resume(): void {
      try {
        proc.resume();
      } catch {
        // ignore
      }
    },
    kill(signal?: string): void {
      try {
        proc.kill(signal);
      } catch {
        // 进程可能已经退出
      }
    },
    onData(cb: (data: string) => void): void {
      proc.onData(cb);
    },
    onExit(cb: (code: number | null, signal?: string | null) => void): void {
      proc.onExit((event) => {
        cb(event.exitCode ?? null, event.signal === undefined ? null : String(event.signal));
      });
    },
  };
}

/**
 * 管道降级实现：无 TTY，输入无回显、resize 无效，但仍可交互执行命令。
 * 命令与参数始终以 argv 数组传入，绝不拼接 shell 字符串。
 */
export function spawnFallback(
  shell: string,
  args: string[],
  opts: { cols: number; rows: number; cwd?: string; env?: Record<string, string> },
): FallbackPty {
  const child: ChildProcessWithoutNullStreams = spawn(shell, args, {
    cwd: opts.cwd,
    env: opts.env,
    windowsHide: true,
    // POSIX 使用独立进程组，便于 kill 时终止整棵进程树
    detached: process.platform !== 'win32',
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  let dataHandler: ((data: string) => void) | null = null;
  let exitHandler: ((code: number | null, signal?: string | null) => void) | null = null;
  const pending: string[] = [];
  let exited = false;
  let paused = false;

  const emitData = (chunk: string): void => {
    if (chunk.length === 0) return;
    if (dataHandler !== null) {
      dataHandler(chunk);
    } else {
      pending.push(chunk);
    }
  };

  child.stdout.on('data', (chunk: string) => {
    if (!paused) emitData(chunk);
  });
  child.stderr.on('data', (chunk: string) => {
    if (!paused) emitData(chunk);
  });
  child.on('error', (error: Error) => {
    emitData(`\r\n[终端错误] ${error.message}\r\n`);
  });
  child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
    if (exited) return;
    exited = true;
    exitHandler?.(code, signal);
  });

  const killTree = (signal?: string): void => {
    const pid = child.pid;
    if (pid === undefined || exited) return;
    if (process.platform === 'win32') {
      try {
        child.kill();
      } catch {
        // ignore
      }
      try {
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
          detached: true,
        });
        killer.on('error', () => {
          // taskkill 缺失时已回退到 child.kill()
        });
        killer.unref();
      } catch {
        // ignore
      }
      return;
    }
    try {
      process.kill(-pid, (signal as NodeJS.Signals | undefined) ?? 'SIGTERM');
    } catch {
      try {
        child.kill((signal as NodeJS.Signals | undefined) ?? 'SIGTERM');
      } catch {
        // ignore
      }
    }
  };

  return {
    get pid(): number {
      return child.pid ?? -1;
    },
    write(data: string): void {
      if (exited) return;
      // Windows 管道模式的 cmd.exe 需要 CRLF 才会执行整行
      const payload =
        process.platform === 'win32' ? data.replace(/\r(?!\n)/g, '\r\n') : data;
      try {
        child.stdin.write(payload);
      } catch {
        // stdin 已关闭
      }
    },
    resize(): void {
      // 管道模式不支持窗口尺寸
    },
    pause(): void {
      paused = true;
      child.stdout.pause();
      child.stderr.pause();
    },
    resume(): void {
      if (!paused) return;
      paused = false;
      child.stdout.resume();
      child.stderr.resume();
    },
    kill(signal?: string): void {
      killTree(signal);
    },
    onData(cb: (data: string) => void): void {
      dataHandler = cb;
      while (pending.length > 0) {
        const chunk = pending.shift();
        if (chunk !== undefined) cb(chunk);
      }
    },
    onExit(cb: (code: number | null, signal?: string | null) => void): void {
      exitHandler = cb;
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
