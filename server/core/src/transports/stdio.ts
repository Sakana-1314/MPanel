import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import path from 'node:path';
import { PanelError, decodeTunnelFrame, TUNNEL_MAX_FRAME_BYTES, type TunnelFrame } from '@mpanel/shared';
import { NdjsonReader, encodeNdjson } from './ndjson.js';
import { createTunnelDriver, type TunnelChannel } from './tunnel.js';
import type { TransportDriver, TransportDriverDeps } from './types.js';
import { toTransportLogger } from './types.js';

/** 只从 core 进程继承这些变量；MPANEL_* 一律不继承，避免凭据串台。 */
const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'PATHEXT',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
  'LANG',
  'LC_ALL',
  'TZ',
] as const;

const STDERR_RING_LINES = 1_000;
const STDERR_RING_BYTES = 10 * 1024 * 1024;
const STDERR_LINE_LIMIT = 64 * 1024;
const STDOUT_LINE_LIMIT = TUNNEL_MAX_FRAME_BYTES;
const SEND_TIMEOUT_MS = 30_000;
const GRACEFUL_KILL_MS = 5_000;
const FORCE_FINISH_MS = 8_000;

export type StdioSpawner = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface StdioChannelOptions {
  command: string;
  args: readonly string[];
  env: Record<string, string>;
  cwd?: string;
  machineId: string;
  /** 合并 core 允许继承的最小环境变量（默认 true）。 */
  inheritEnv?: boolean;
  stderrLogFile?: string;
  spawner?: StdioSpawner;
  onStderrLine?: (line: string) => void;
}

/**
 * 以 argv 数组 spawn worker 子进程，stdout 仅解析 NDJSON 帧、stderr 作为日志。
 * 禁止 shell 拼接；这是长期运行的双向传输进程，不是一次性命令，因此不走
 * CommandRunner（CommandRunner 无法提供长连接 stdin/stdout 帧管道）。
 */
export function createStdioChannel(options: StdioChannelOptions): TunnelChannel {
  return new StdioChannel(options);
}

class StdioChannel implements TunnelChannel {
  private readonly child: ChildProcess;
  private readonly reader = new NdjsonReader(STDOUT_LINE_LIMIT);
  private readonly frameCbs: Array<(frame: TunnelFrame) => void> = [];
  private readonly closeCbs: Array<(code?: number, reason?: string) => void> = [];
  private readonly earlyFrames: TunnelFrame[] = [];
  private readonly stderrRing: string[] = [];
  private stderrBytes = 0;
  private stderrPartial = '';
  private readonly logStream: WriteStream | null;
  private writeChain: Promise<void> = Promise.resolve();
  private closed = false;
  private closeCode: number | undefined;
  private closeReason: string | undefined;
  private killTimer: NodeJS.Timeout | undefined;
  private forceTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: StdioChannelOptions) {
    const env: Record<string, string> = {};
    if (options.inheritEnv !== false) {
      for (const name of ENV_ALLOWLIST) {
        const value = process.env[name];
        if (value !== undefined) env[name] = value;
      }
    }
    Object.assign(env, options.env);

    let logStream: WriteStream | null = null;
    if (options.stderrLogFile !== undefined) {
      try {
        mkdirSync(path.dirname(options.stderrLogFile), { recursive: true });
        logStream = createWriteStream(options.stderrLogFile, { flags: 'a', mode: 0o600 });
        logStream.on('error', () => undefined);
      } catch {
        logStream = null;
      }
    }
    this.logStream = logStream;

    const spawner: StdioSpawner =
      options.spawner ?? ((command, args, spawnOptions) => spawn(command, [...args], spawnOptions));

    this.child = spawner(options.command, options.args, {
      cwd: options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });

    this.child.stdout?.on('data', (chunk: Buffer) => this.onStdout(chunk));
    this.child.stdout?.on('error', (error) => this.finish(1, `stdout 读取失败：${error.message}`));
    this.child.stderr?.on('data', (chunk: Buffer) => this.onStderr(chunk));
    this.child.stdin?.on('error', (error) => this.finish(1, `stdin 写入失败：${error.message}`));
    this.child.on('error', (error) => this.finish(1, `worker 启动失败：${error.message}`));
    this.child.on('exit', (code, signal) => {
      const detail =
        signal !== null && signal !== undefined
          ? `worker 进程被信号 ${signal} 终止`
          : `worker 进程已退出（code=${code ?? 'null'}）`;
      this.finish(code ?? 1, detail);
    });
  }

  send(frame: TunnelFrame): Promise<void> {
    if (this.closed) {
      return Promise.reject(new PanelError('UPSTREAM_ERROR', 'stdio 隧道已关闭', {
        hint: '等待 core 自动重启 worker，或手动 POST /api/v1/machines/:id/connect',
        machineId: this.options.machineId,
      }));
    }
    const line = encodeNdjson(frame);
    if (Buffer.byteLength(line, 'utf8') > TUNNEL_MAX_FRAME_BYTES) {
      return Promise.reject(new PanelError('BAD_REQUEST', '隧道帧超过 16 MiB 上限', {
        kind: frame.kind,
        machineId: this.options.machineId,
      }));
    }
    const task = async (): Promise<void> => {
      const stdin = this.child.stdin;
      if (stdin === null || stdin.destroyed) {
        throw new PanelError('UPSTREAM_ERROR', 'worker stdin 不可写', {
          machineId: this.options.machineId,
        });
      }
      const written = stdin.write(line);
      if (written) return;
      await this.waitForDrain();
    };
    const next = this.writeChain.then(task, task);
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closeCode = code;
    this.closeReason = reason;
    const stdin = this.child.stdin;
    if (stdin !== null && !stdin.destroyed) {
      try {
        stdin.end();
      } catch {
        // 忽略。
      }
    }
    if (this.killTimer === undefined) {
      const timer = setTimeout(() => {
        this.killTimer = undefined;
        try {
          this.child.kill();
        } catch {
          // 忽略。
        }
        const force = setTimeout(() => {
          this.forceTimer = undefined;
          this.finish(code ?? 1, reason ?? 'worker 未在超时内退出');
        }, FORCE_FINISH_MS - GRACEFUL_KILL_MS);
        force.unref?.();
        this.forceTimer = force;
      }, GRACEFUL_KILL_MS);
      timer.unref?.();
      this.killTimer = timer;
    }
  }

  onFrame(cb: (frame: TunnelFrame) => void): void {
    this.frameCbs.push(cb);
    if (this.earlyFrames.length > 0) {
      const pending = this.earlyFrames.splice(0);
      for (const frame of pending) {
        try {
          cb(frame);
        } catch {
          // 忽略单个回调异常。
        }
      }
    }
  }

  onClose(cb: (code?: number, reason?: string) => void): void {
    this.closeCbs.push(cb);
    if (this.closed) {
      const code = this.closeCode;
      const reason = this.closeReason;
      queueMicrotask(() => cb(code, reason));
    }
  }

  /* ------------------------------------------------------------------ */

  private onStdout(chunk: Buffer): void {
    if (this.closed) return;
    let lines: string[];
    try {
      lines = this.reader.push(chunk);
    } catch (error) {
      this.finish(1, error instanceof Error ? error.message : 'stdout 帧超过上限');
      try {
        this.child.kill();
      } catch {
        // 忽略。
      }
      return;
    }
    for (const line of lines) this.handleLine(line);
  }

  private handleLine(line: string): void {
    let frame: TunnelFrame;
    try {
      frame = decodeTunnelFrame(line);
    } catch (error) {
      const detail = error instanceof PanelError ? error.message : 'stdout 出现非法帧';
      this.finish(1, `stdio 协议错误：${detail}`);
      try {
        this.child.kill();
      } catch {
        // 忽略。
      }
      return;
    }
    if (this.frameCbs.length === 0) {
      if (this.earlyFrames.length < 64) this.earlyFrames.push(frame);
      return;
    }
    for (const cb of this.frameCbs) {
      try {
        cb(frame);
      } catch {
        // 忽略单个回调异常。
      }
    }
  }

  private onStderr(chunk: Buffer): void {
    this.stderrPartial += chunk.toString('utf8');
    const lines = this.stderrPartial.split(/\r?\n/);
    this.stderrPartial = lines.pop() ?? '';
    if (this.stderrPartial.length > STDERR_LINE_LIMIT) {
      lines.push(this.stderrPartial.slice(0, STDERR_LINE_LIMIT));
      this.stderrPartial = '';
    }
    for (const raw of lines) {
      const line = raw.trimEnd();
      if (line.length === 0) continue;
      this.pushStderr(line);
    }
  }

  private pushStderr(line: string): void {
    this.stderrRing.push(line);
    this.stderrBytes += Buffer.byteLength(line, 'utf8');
    while (
      this.stderrRing.length > STDERR_RING_LINES ||
      (this.stderrBytes > STDERR_RING_BYTES && this.stderrRing.length > 1)
    ) {
      const removed = this.stderrRing.shift();
      if (removed === undefined) break;
      this.stderrBytes -= Buffer.byteLength(removed, 'utf8');
    }
    this.options.onStderrLine?.(line);
    if (this.logStream !== null) {
      this.logStream.write(`${new Date().toISOString()} ${line}\n`);
    }
  }

  /** 最近 stderr 尾部（用于错误 reason，供驱动/服务诊断）。 */
  stderrTail(limit = 20): string[] {
    return this.stderrRing.slice(-limit);
  }

  private waitForDrain(): Promise<void> {
    const stdin = this.child.stdin;
    if (stdin === null) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        stdin.removeListener('drain', onDrain);
        stdin.removeListener('error', onError);
        stdin.removeListener('close', onClose);
      };
      const onDrain = (): void => {
        cleanup();
        resolve();
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(new PanelError('UPSTREAM_ERROR', `worker stdin 写入失败：${error.message}`));
      };
      const onClose = (): void => {
        cleanup();
        reject(new PanelError('UPSTREAM_ERROR', 'worker stdin 已关闭'));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new PanelError('UPSTREAM_ERROR', 'worker stdin 写入阻塞超时', {
          machineId: this.options.machineId,
        }));
      }, SEND_TIMEOUT_MS);
      timer.unref?.();
      stdin.once('drain', onDrain);
      stdin.once('error', onError);
      stdin.once('close', onClose);
    });
  }

  private finish(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    const finalCode = this.closeCode ?? code;
    const finalReason = this.closeReason ?? reason;
    if (this.killTimer !== undefined) {
      clearTimeout(this.killTimer);
      this.killTimer = undefined;
    }
    if (this.forceTimer !== undefined) {
      clearTimeout(this.forceTimer);
      this.forceTimer = undefined;
    }
    this.child.stdout?.removeAllListeners();
    this.child.stderr?.removeAllListeners();
    this.child.stdin?.removeAllListeners();
    try {
      this.child.kill();
    } catch {
      // 进程可能已退出。
    }
    if (this.logStream !== null) {
      this.logStream.end();
    }
    for (const cb of this.closeCbs) {
      try {
        cb(finalCode, finalReason);
      } catch {
        // 关闭回调异常不影响 core。
      }
    }
  }
}

function buildBaseEnv(userEnv: Record<string, string> | null): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ENV_ALLOWLIST) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  if (userEnv !== null) Object.assign(env, userEnv);
  return env;
}

/** 供服务/驱动构造 stdio 子进程环境（保留 MPANEL_* 由调用方显式注入）。 */
export function bindStdioEnv(
  userEnv: Record<string, string> | null,
  reserved: Record<string, string>,
): Record<string, string> {
  return { ...buildBaseEnv(userEnv), ...reserved };
}

/**
 * stdio 传输驱动：spawn `node <workerEntry> serve --transport stdio`，
 * 断线按 1s→30s 退避自动重启；连续 5 次失败后进入 error，等待手动 connect。
 */
export function createStdioTransportDriver(deps: TransportDriverDeps): TransportDriver {
  const logger = toTransportLogger(deps.logger);
  return createTunnelDriver('stdio', deps, {
    autoRestart: true,
    connect: async (machine) => {
      if (!deps.config.allowStdio) {
        throw new PanelError('FORBIDDEN', 'core 未启用 stdio 传输', {
          hint: '设置 MPANEL_ALLOW_STDIO=1 后重启 core',
          machineId: machine.id,
        });
      }
      const token = await deps.credentials.getToken(machine);
      const home = path.join(deps.config.home, 'workers', machine.id);
      const command = machine.command ?? process.execPath;
      const args = machine.args ?? (deps.config.workerEntry.length > 0 ? [deps.config.workerEntry] : []);
      if (args.length === 0) {
        throw new PanelError('BAD_REQUEST', 'stdio 机器缺少 worker 入口参数', {
          hint: '设置 MPANEL_WORKER_ENTRY，或在创建机器时提供 args',
          machineId: machine.id,
        });
      }
      const logFile = path.join(deps.config.home, 'logs', 'workers', `${machine.id}.log`);
      return createStdioChannel({
        command,
        args,
        env: bindStdioEnv(machine.env, {
          MPANEL_TRANSPORT: 'stdio',
          MPANEL_TOKEN: token,
          MPANEL_HOME: home,
          MPANEL_LOG_LEVEL: deps.config.logLevel,
        }),
        machineId: machine.id,
        stderrLogFile: logFile,
        onStderrLine: (line) => {
          logger.debug('worker stderr', { machineId: machine.id, line: line.slice(0, 500) });
        },
      });
    },
  });
}
