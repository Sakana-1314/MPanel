import { randomBytes } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PanelError,
  type ModuleLogger,
  type ShellInfo,
  type TerminalCreateInput,
  type TerminalSession,
} from '@mpanel/shared';
import type { WorkerConfig } from '../../config.js';
import {
  loadPty,
  ptyLoadReason,
  spawnFallback,
  type PtyLike,
  type PtyModule,
} from './pty.js';

/** 终端会话上限（并发运行）。契约：20/worker。 */
export const MAX_TERMINAL_SESSIONS = 20;
/** 空闲回收阈值：30 分钟。 */
export const TERMINAL_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
/** 最近输出环形缓冲上限：200 KiB。 */
export const TERMINAL_BUFFER_BYTES = 200 * 1024;

/** API 对象上的可选展示名（重命名），属于加法字段，旧客户端忽略。 */
export type TerminalSessionView = TerminalSession & { name?: string | null };

export interface TerminalListener {
  onOutput(data: string): void;
  onExit(code: number | null, signal?: string | null): void;
}

export interface TerminalManager {
  create(input: TerminalCreateInput): Promise<TerminalSessionView>;
  list(): Promise<TerminalSessionView[]>;
  get(id: string): Promise<TerminalSessionView | undefined>;
  close(id: string): Promise<void>;
  noteActivity(id: string): void;
  sweep(): void;
  /** 订阅会话输出/退出；返回退订函数。会话已退出时异步补发 exit。 */
  attach(id: string, listener: TerminalListener): (() => void) | null;
  /** 写入 stdin；会话不存在或已退出返回 false。 */
  write(id: string, data: string): boolean;
  resize(id: string, cols: number, rows: number): void;
  pause(id: string): void;
  resume(id: string): void;
  /** 重命名会话（内存态，属于加法能力）。 */
  rename(id: string, name: string | null): Promise<TerminalSessionView>;
  /** 读取最近输出（诊断/测试用）。 */
  readBuffer(id: string): string | null;
  /** 释放所有会话与定时器（worker 关闭时调用）。 */
  dispose(): Promise<void>;
}

export interface TerminalManagerDeps {
  config: WorkerConfig;
  logger: ModuleLogger;
  /** 测试注入；默认自动加载 node-pty。 */
  pty?: PtyModule | null;
  /** 空闲回收扫描间隔，默认 60s。 */
  sweepIntervalMs?: number;
}

interface SessionState {
  info: TerminalSession;
  name: string | null;
  proc: PtyLike | null;
  buffer: OutputRing;
  listeners: Set<TerminalListener>;
  closed: boolean;
}

export function createTerminalManager(deps: TerminalManagerDeps): TerminalManager {
  const { config, logger } = deps;
  const sessions = new Map<string, SessionState>();
  let ptyPromise: Promise<PtyModule | null> | null =
    deps.pty === undefined ? null : Promise.resolve(deps.pty);
  let disposed = false;

  const sweepTimer = setInterval(
    () => sweep(deps, sessions),
    deps.sweepIntervalMs ?? 60_000,
  );
  sweepTimer.unref?.();

  const getPty = async (): Promise<PtyModule | null> => {
    if (ptyPromise === null) ptyPromise = loadPty();
    return ptyPromise;
  };

  const manager: TerminalManager = {
    async create(input: TerminalCreateInput): Promise<TerminalSessionView> {
      if (disposed) {
        throw new PanelError('UNAVAILABLE', '终端服务正在关闭', {
          hint: 'The worker is shutting down; retry after restart.',
        });
      }
      const running = countRunning(sessions);
      if (running >= MAX_TERMINAL_SESSIONS) {
        throw new PanelError('BAD_REQUEST', `终端会话数已达到上限 ${MAX_TERMINAL_SESSIONS}`, {
          limit: MAX_TERMINAL_SESSIONS,
          running,
        });
      }

      const cols = clampDimension(input.cols, 80, 2, 500);
      const rows = clampDimension(input.rows, 24, 2, 300);
      const cwd = await resolveTerminalCwd(input.cwd, config);
      const shell = await resolveShell(input.shell, config);
      const env = buildTerminalEnv(input.env);
      if (disposed) {
        throw new PanelError('UNAVAILABLE', '终端服务正在关闭', {
          hint: 'The worker is shutting down; retry after restart.',
        });
      }

      let proc: PtyLike | null = null;
      let usedPty = true;
      const pty = await getPty();
      if (pty !== null) {
        try {
          proc = pty.spawn(shell, [], {
            name: 'xterm-256color',
            cols,
            rows,
            cwd,
            env,
          });
        } catch (error) {
          logger.warn('node-pty 启动失败，降级为管道会话', {
            shell,
            cwd,
            error: errorMessage(error),
          });
          proc = null;
        }
      }
      if (proc === null) {
        usedPty = false;
        try {
          proc = spawnFallback(shell, [], { cols, rows, cwd, env });
        } catch (error) {
          throw new PanelError('BAD_REQUEST', '无法启动终端 shell', {
            shell,
            cwd,
            reason: errorMessage(error),
            hint: '确认 shell 路径存在且可执行，或在 capabilities 中检查 pty 能力。',
          });
        }
        if (ptyLoadReason() !== null) {
          logger.info('终端使用管道降级模式', {
            shell,
            reason: ptyLoadReason(),
          });
        }
      }

      if (disposed) {
        try {
          proc.kill('SIGTERM');
        } catch {
          // ignore
        }
        throw new PanelError('UNAVAILABLE', '终端服务正在关闭', {
          hint: 'The worker is shutting down; retry after restart.',
        });
      }

      const now = new Date().toISOString();
      const state: SessionState = {
        info: {
          id: newSessionId(),
          shell,
          cwd,
          cols,
          rows,
          pty: usedPty,
          status: 'running',
          exitCode: null,
          createdAt: now,
          lastActivityAt: now,
        },
        name: null,
        proc,
        buffer: new OutputRing(TERMINAL_BUFFER_BYTES),
        listeners: new Set(),
        closed: false,
      };
      sessions.set(state.info.id, state);

      proc.onData((data: string) => {
        if (state.closed) return;
        state.info.lastActivityAt = new Date().toISOString();
        state.buffer.push(data);
        for (const listener of state.listeners) {
          try {
            listener.onOutput(data);
          } catch {
            // 单个订阅者异常不得影响会话
          }
        }
      });
      proc.onExit((code: number | null, signal?: string | null) => {
        if (state.closed) return;
        state.closed = true;
        state.proc = null;
        state.info.status = 'exited';
        state.info.exitCode = code;
        state.info.lastActivityAt = new Date().toISOString();
        for (const listener of state.listeners) {
          try {
            listener.onExit(code, signal ?? null);
          } catch {
            // ignore
          }
        }
        state.listeners.clear();
      });

      logger.info('终端会话已创建', {
        sessionId: state.info.id,
        shell,
        cwd,
        pty: usedPty,
        cols,
        rows,
      });
      return view(state);
    },

    async list(): Promise<TerminalSessionView[]> {
      return [...sessions.values()]
        .map(view)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    async get(id: string): Promise<TerminalSessionView | undefined> {
      const state = sessions.get(id);
      return state === undefined ? undefined : view(state);
    },

    async close(id: string): Promise<void> {
      const state = sessions.get(id);
      if (state === undefined) return;
      teardown(state, 'SIGTERM', logger);
      sessions.delete(id);
    },

    noteActivity(id: string): void {
      const state = sessions.get(id);
      if (state !== undefined && !state.closed) {
        state.info.lastActivityAt = new Date().toISOString();
      }
    },

    sweep(): void {
      sweep(deps, sessions);
    },

    attach(id: string, listener: TerminalListener): (() => void) | null {
      const state = sessions.get(id);
      if (state === undefined) return null;
      if (state.closed) {
        // 异步补发 exit，便于调用方先完成订阅登记
        queueMicrotask(() => {
          try {
            listener.onExit(state.info.exitCode, null);
          } catch {
            // ignore
          }
        });
        return () => undefined;
      }
      state.listeners.add(listener);
      return () => {
        state.listeners.delete(listener);
      };
    },

    write(id: string, data: string): boolean {
      const state = sessions.get(id);
      if (state === undefined || state.closed || state.proc === null) return false;
      try {
        state.proc.write(data);
        state.info.lastActivityAt = new Date().toISOString();
        return true;
      } catch (error) {
        logger.warn('终端写入失败', { sessionId: id, error: errorMessage(error) });
        return false;
      }
    },

    resize(id: string, cols: number, rows: number): void {
      const state = sessions.get(id);
      if (state === undefined || state.closed) return;
      state.info.cols = clampDimension(cols, state.info.cols, 2, 500);
      state.info.rows = clampDimension(rows, state.info.rows, 2, 300);
      state.info.lastActivityAt = new Date().toISOString();
      try {
        state.proc?.resize(state.info.cols, state.info.rows);
      } catch {
        // 管道模式或已退出时忽略
      }
    },

    pause(id: string): void {
      const state = sessions.get(id);
      if (state === undefined || state.closed) return;
      try {
        state.proc?.pause();
      } catch {
        // ignore
      }
    },

    resume(id: string): void {
      const state = sessions.get(id);
      if (state === undefined || state.closed) return;
      try {
        state.proc?.resume();
      } catch {
        // ignore
      }
    },

    async rename(id: string, name: string | null): Promise<TerminalSessionView> {
      const state = sessions.get(id);
      if (state === undefined) {
        throw new PanelError('NOT_FOUND', '终端会话不存在', { resource: 'terminal_session', id });
      }
      const trimmed = name === null ? null : name.trim();
      state.name = trimmed === null || trimmed.length === 0 ? null : trimmed.slice(0, 120);
      state.info.lastActivityAt = new Date().toISOString();
      return view(state);
    },

    readBuffer(id: string): string | null {
      const state = sessions.get(id);
      return state === undefined ? null : state.buffer.read();
    },

    async dispose(): Promise<void> {
      disposed = true;
      clearInterval(sweepTimer);
      for (const state of sessions.values()) {
        teardown(state, 'SIGTERM', logger);
      }
      sessions.clear();
    },
  };

  return manager;
}

function view(state: SessionState): TerminalSessionView {
  return { ...state.info, ...(state.name === null ? {} : { name: state.name }) };
}

function countRunning(sessions: Map<string, SessionState>): number {
  let count = 0;
  for (const state of sessions.values()) {
    if (!state.closed) count += 1;
  }
  return count;
}

function sweep(deps: TerminalManagerDeps, sessions: Map<string, SessionState>): void {
  const now = Date.now();
  for (const [id, state] of sessions) {
    const last = Date.parse(state.info.lastActivityAt);
    if (!Number.isFinite(last)) continue;
    if (now - last < TERMINAL_IDLE_TIMEOUT_MS) continue;
    deps.logger.info('回收空闲终端会话', { sessionId: id, idleMs: now - last });
    teardown(state, 'SIGTERM', deps.logger);
    sessions.delete(id);
  }
}

function teardown(
  state: SessionState,
  signal: string,
  logger: ModuleLogger,
): void {
  if (state.closed && state.proc === null) {
    state.listeners.clear();
    return;
  }
  state.closed = true;
  const proc = state.proc;
  state.proc = null;
  if (proc !== null) {
    try {
      proc.kill(signal);
    } catch (error) {
      logger.warn('终止终端进程失败', { sessionId: state.info.id, error: errorMessage(error) });
    }
  }
  state.info.status = 'exited';
  state.info.exitCode = null;
  state.info.lastActivityAt = new Date().toISOString();
  for (const listener of state.listeners) {
    try {
      listener.onExit(null, signal);
    } catch {
      // ignore
    }
  }
  state.listeners.clear();
}

/**
 * cwd 必须存在、是目录，且落在允许根（MPANEL_HOME / 用户主目录 / 文件根 /
 * Caddy 站点根）内；否则返回 BAD_REQUEST。使用 realpath 防止符号链接逃逸。
 */
export async function resolveTerminalCwd(
  input: string | undefined,
  config: WorkerConfig,
): Promise<string> {
  const raw = input === undefined || input.trim().length === 0 ? config.home : input.trim();
  const candidate = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(config.home, raw);
  let real: string;
  try {
    const stat = await fs.stat(candidate);
    if (!stat.isDirectory()) {
      throw new PanelError('BAD_REQUEST', '终端工作目录不是目录', { cwd: candidate });
    }
    real = await fs.realpath(candidate);
  } catch (error) {
    if (error instanceof PanelError) throw error;
    throw new PanelError('BAD_REQUEST', '终端工作目录不存在或不可访问', {
      cwd: candidate,
      reason: errorMessage(error),
    });
  }

  const roots = allowedCwdRoots(config);
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = await fs.realpath(root);
    } catch {
      continue;
    }
    if (isInside(real, realRoot)) return real;
  }
  throw new PanelError('BAD_REQUEST', '终端工作目录不在允许范围内', {
    cwd: real,
    allowedRoots: roots,
    hint: '使用 MPANEL_HOME、用户主目录或已配置文件根 / Caddy 站点根内的目录。',
  });
}

function allowedCwdRoots(config: WorkerConfig): string[] {
  const roots = new Set<string>();
  roots.add(config.home);
  try {
    roots.add(os.homedir());
  } catch {
    // ignore
  }
  for (const root of config.files.roots) roots.add(root.path);
  for (const root of config.caddy.sitesRoots) roots.add(root);
  roots.add(config.caddy.configDir);
  roots.add(config.caddy.dataDir);
  return [...roots].filter((root) => typeof root === 'string' && root.length > 0);
}

function isInside(target: string, root: string): boolean {
  const normalizedTarget = process.platform === 'win32' ? target.toLowerCase() : target;
  const normalizedRoot = process.platform === 'win32' ? root.toLowerCase() : root;
  const relative = path.relative(normalizedRoot, normalizedTarget);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** 合并进程环境与用户环境，强制删除面板凭据。 */
export function buildTerminalEnv(extra: Record<string, string> | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  if (extra !== undefined) {
    for (const [key, value] of Object.entries(extra)) {
      if (typeof value === 'string') env[key] = value;
    }
  }
  delete env.MPANEL_TOKEN;
  delete env.MPANEL_SECRET_KEY;
  delete env.MPANEL_CORE_TOKEN;
  delete env.MPANEL_MACHINE_SECRET;
  return env;
}

function clampDimension(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, numeric));
}

/** 默认 shell：Windows powershell.exe；POSIX $SHELL 或 /bin/bash。 */
export function defaultShell(config: WorkerConfig): string {
  if (process.platform === 'win32') {
    return 'powershell.exe';
  }
  const fromEnv = process.env.SHELL;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim();
  void config;
  return '/bin/bash';
}

/** 校验用户指定 shell，返回可执行的绝对路径；不存在 -> BAD_REQUEST。 */
export async function resolveShell(
  input: string | undefined,
  config: WorkerConfig,
): Promise<string> {
  const candidate =
    input === undefined || input.trim().length === 0 ? defaultShell(config) : input.trim();
  if (/[\u0000-\u001f\u007f]/.test(candidate)) {
    throw new PanelError('BAD_REQUEST', 'shell 包含非法字符', { shell: candidate });
  }
  const resolved = await findExecutable(candidate);
  if (resolved !== null) return resolved;
  if (input === undefined || input.trim().length === 0) {
    const fallback = process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : '/bin/sh';
    const fallbackResolved = await findExecutable(fallback);
    if (fallbackResolved !== null) return fallbackResolved;
  }
  throw new PanelError('BAD_REQUEST', '指定的 shell 不存在或不可执行', {
    shell: candidate,
    hint: '传入宿主上已存在的 shell 绝对路径，或留空使用默认 shell。',
  });
}

/** 在 PATH 中查找可执行文件；绝对路径直接校验。 */
export async function findExecutable(command: string): Promise<string | null> {
  const trimmed = command.trim();
  if (trimmed.length === 0 || /[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  if (path.isAbsolute(trimmed)) {
    return (await isExecutableFile(trimmed)) ? trimmed : null;
  }
  const pathEnv = process.env.PATH ?? '';
  const dirs = pathEnv.split(path.delimiter).filter((dir) => dir.length > 0);
  const extensions =
    process.platform === 'win32'
      ? buildWindowsExtensions(trimmed)
      : [''];
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${trimmed}${extension}`);
      if (await isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

function buildWindowsExtensions(command: string): string[] {
  if (/\.[A-Za-z0-9]+$/.test(command)) return [''];
  const raw = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  const extensions = raw
    .split(';')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return ['', ...extensions];
}

async function isExecutableFile(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.stat(candidate);
    if (!stat.isFile()) return false;
    await fs.access(candidate, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 列出宿主可用 shell（GET /terminal/shells）。 */
export async function listShells(config: WorkerConfig): Promise<ShellInfo[]> {
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    candidates.push('powershell.exe', 'pwsh.exe');
    if (typeof process.env.ComSpec === 'string') candidates.push(process.env.ComSpec);
    candidates.push('cmd.exe');
  } else {
    if (typeof process.env.SHELL === 'string') candidates.push(process.env.SHELL);
    candidates.push('/bin/bash', '/usr/bin/bash', '/bin/zsh', '/bin/sh', '/usr/bin/fish');
  }
  if (typeof config.tasks.shell === 'string' && config.tasks.shell.length > 0) {
    candidates.push(config.tasks.shell);
  }

  const seen = new Set<string>();
  const shells: ShellInfo[] = [];
  for (const candidate of candidates) {
    const resolved = await findExecutable(candidate);
    if (resolved === null) continue;
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    shells.push({ path: resolved, name: shellDisplayName(resolved) });
  }
  return shells.sort((a, b) => a.name.localeCompare(b.name));
}

function shellDisplayName(shellPath: string): string {
  const base = path.basename(shellPath);
  return process.platform === 'win32' ? base.replace(/\.exe$/i, '') : base;
}

function newSessionId(): string {
  return `term_${randomBytes(8).toString('hex')}`;
}

/** 按 UTF-8 字节数裁剪的环形输出缓冲。 */
class OutputRing {
  private chunks: string[] = [];
  private bytes = 0;

  constructor(private readonly limitBytes: number) {}

  push(chunk: string): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.bytes += Buffer.byteLength(chunk, 'utf8');
    while (this.bytes > this.limitBytes && this.chunks.length > 1) {
      const removed = this.chunks.shift();
      if (removed !== undefined) this.bytes -= Buffer.byteLength(removed, 'utf8');
    }
    if (this.bytes > this.limitBytes && this.chunks.length === 1) {
      // 单块超过上限时只保留尾部
      const single = Buffer.from(this.chunks[0] ?? '', 'utf8');
      const kept = single.subarray(Math.max(0, single.length - this.limitBytes));
      const text = kept.toString('utf8');
      this.chunks = [text];
      this.bytes = Buffer.byteLength(text, 'utf8');
    }
  }

  read(): string {
    return this.chunks.join('');
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
