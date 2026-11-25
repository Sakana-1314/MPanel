import { PanelError, unavailable } from '@mpanel/shared';
import type {
  CommandOptions,
  CommandResult,
  CommandRunner,
} from '@mpanel/shared';

/** 注入 runner 的统一调用：argv 数组 + 显式 env，绝不拼接 shell 字符串。 */
export interface StreamingHandlers {
  /** 每读取到一行 stderr 时回调（pg_dump --verbose / pg_restore --verbose 的进度）。 */
  onStderrLine?: (line: string) => void;
  onStdoutLine?: (line: string) => void;
}

/**
 * 执行命令并持续消费 stdout/stderr，避免管道背压；进度回调只读取行文本。
 * 进程启动失败（ENOENT 等）统一转换为 UNAVAILABLE。
 */
export async function runStreamingCommand(
  runner: CommandRunner,
  command: string,
  args: readonly string[],
  options: CommandOptions,
  handlers: StreamingHandlers = {},
): Promise<CommandResult> {
  let stream;
  try {
    stream = runner.stream(command, args, options);
  } catch (error) {
    throw mapSpawnError(error, command);
  }

  const stdoutTask = consumeLines(stream.stdout, handlers.onStdoutLine);
  const stderrTask = consumeLines(stream.stderr, handlers.onStderrLine);

  try {
    const result = await stream.completion;
    await Promise.allSettled([stdoutTask, stderrTask]);
    return result;
  } catch (error) {
    await Promise.allSettled([stdoutTask, stderrTask]);
    throw mapSpawnError(error, command);
  }
}

/** 用 argv 执行一次性命令（不向用户暴露 stderr 中的任何 secret）。 */
export async function runCommand(
  runner: CommandRunner,
  command: string,
  args: readonly string[],
  options: CommandOptions,
): Promise<CommandResult> {
  try {
    return await runner.run(command, args, options);
  } catch (error) {
    throw mapSpawnError(error, command);
  }
}

/**
 * 能力/工具探测：缺少二进制返回 UNAVAILABLE（带可执行的 hint），而不是 500。
 * 返回解析后的绝对路径，后续调用直接使用，避免 PATH 在探测后被替换。
 */
export async function requireTool(
  runner: CommandRunner,
  bin: string,
  envName: string,
  purpose: string,
): Promise<string> {
  let resolved: string | null = null;
  try {
    resolved = await runner.which(bin);
  } catch {
    resolved = null;
  }
  if (resolved === null || resolved.length === 0) {
    throw unavailable(
      `未找到 ${purpose} 所需的工具 ${bin}`,
      `在 worker 主机安装对应客户端，或通过 ${envName} 指定可执行文件路径。`,
      { tool: bin, env: envName },
    );
  }
  return resolved;
}

export function commandFailure(
  label: string,
  result: CommandResult,
  secret?: string | null,
): PanelError {
  if (result.timedOut) {
    return new PanelError('UPSTREAM_ERROR', `${label} 执行超时`, {
      command: label,
      timeout: true,
    });
  }
  const tail = tailText(result.stderr, 2000) || tailText(result.stdout, 2000);
  const detail = scrubSecret(tail, secret);
  return new PanelError(
    'UPSTREAM_ERROR',
    `${label} 执行失败（退出码 ${result.code ?? 'signal'}）${detail.length > 0 ? `：${detail}` : ''}`,
    { exitCode: result.code, signal: result.signal },
  );
}

export function tailText(text: string, maxBytes: number): string {
  if (text.length <= maxBytes) return text.trim();
  return text.slice(Math.max(0, text.length - maxBytes)).trim();
}

/** 从任意错误/输出中删除已知密码，防止 stderr 回显到 API 或日志。 */
export function scrubSecret(text: string, secret?: string | null): string {
  if (typeof secret !== 'string' || secret.length === 0) return text;
  return text.split(secret).join('***');
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown error';
}

export function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function mapSpawnError(error: unknown, command: string): PanelError {
  if (isErrno(error, 'ENOENT')) {
    return unavailable(
      `无法启动 ${command}`,
      `确认 ${command} 已安装且可执行，或在 MPanel 配置中指定绝对路径。`,
      { command },
    );
  }
  if (isErrno(error, 'EACCES') || isErrno(error, 'EPERM')) {
    return unavailable(
      `没有权限执行 ${command}`,
      '检查可执行文件权限与 worker 运行用户。',
      { command },
    );
  }
  return new PanelError(
    'UPSTREAM_ERROR',
    `执行 ${command} 失败：${describeError(error)}`,
    { command },
    { cause: error },
  );
}

async function consumeLines(
  iterable: AsyncIterable<Uint8Array>,
  onLine?: (line: string) => void,
): Promise<void> {
  let carry = '';
  for await (const chunk of iterable) {
    if (onLine === undefined) continue;
    carry += Buffer.from(chunk).toString('utf8');
    const parts = carry.split(/\r?\n/);
    carry = parts.pop() ?? '';
    for (const line of parts) {
      if (line.length > 0) onLine(line);
    }
  }
  if (carry.length > 0 && onLine !== undefined) onLine(carry);
}
