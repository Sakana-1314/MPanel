import { createWriteStream, type WriteStream } from 'node:fs';
import type { ModuleLogger } from '@mpanel/shared';

/**
 * Worker 日志器。所有日志固定写 stderr（stdio 传输下 stdout 只允许协议帧），
 * 可选再追加写入日志文件。字段按白名单脱敏，绝不让 token/密码进入日志。
 */
export interface WorkerLogger extends ModuleLogger {
  child(bindings: Record<string, unknown>): WorkerLogger;
  /** 关闭文件日志句柄；不传 file 时为 no-op。 */
  close?(): void;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
  silent: 100,
};

const SENSITIVE_KEY = /^(?:authorization|proxy-authorization|cookie|set-cookie|password|passwd|pwd|secret|token|ticket|apikey|api-key|access[_-]?token|refresh[_-]?token|client[_-]?secret|pgpassword|rediscli_auth|machine[_-]?secret|private[_-]?key)$/i;

const INLINE_SECRET = /(bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const QUERY_SECRET = /(^|[?&\s])((?:token|ticket|secret|password|api_key|apikey)=)[^&\s#"']+/gi;
const ENV_SECRET = /\b(PGPASSWORD|REDISCLI_AUTH|MPANEL_TOKEN|MPANEL_MACHINE_SECRET|MPANEL_SECRET_KEY)=([^\s"']+)/gi;

const REDACTED = '[redacted]';

/** 把字符串里明显的凭据片段替换掉，保留结构便于排障。 */
export function redactText(value: string): string {
  return value
    .replace(INLINE_SECRET, `$1${REDACTED}`)
    .replace(QUERY_SECRET, `$1$2${REDACTED}`)
    .replace(ENV_SECRET, `$1=${REDACTED}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 递归脱敏任意值。敏感键整个替换为 [redacted]；字符串值再做内联替换。
 * 保持 Error 的 name/message/stack，便于内部错误记录堆栈（响应绝不包含）。
 */
export function redact(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message),
      ...(value.stack === undefined ? {} : { stack: redactText(value.stack) }),
      ...(value.cause === undefined ? {} : { cause: redact(value.cause, depth + 1, seen) }),
    };
  }
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[circular]';
  if (depth > 6) return '[truncated]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, depth + 1, seen));
  }
  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if (SENSITIVE_KEY.test(key)) {
      output[key] = REDACTED;
      continue;
    }
    output[key] = redact(item, depth + 1, seen);
  }
  return output;
}

function normalizeLevel(level: string): LogLevel {
  const lowered = level.trim().toLowerCase();
  if (lowered === 'warning') return 'warn';
  if (lowered in LEVEL_WEIGHT) return lowered as LogLevel;
  return 'info';
}

class StderrLogger implements WorkerLogger {
  private readonly threshold: number;
  private readonly level: LogLevel;
  private readonly bindings: Record<string, unknown>;
  private fileStream: WriteStream | null;
  private fileBroken = false;

  constructor(
    level: LogLevel,
    bindings: Record<string, unknown>,
    fileStream: WriteStream | null,
  ) {
    this.level = level;
    this.threshold = LEVEL_WEIGHT[level];
    this.bindings = bindings;
    this.fileStream = fileStream;
  }

  child(bindings: Record<string, unknown>): WorkerLogger {
    return new StderrLogger(this.level, { ...this.bindings, ...bindings }, this.fileStream);
  }

  debug(message: string, details?: Record<string, unknown>): void {
    this.write('debug', message, details);
  }

  info(message: string, details?: Record<string, unknown>): void {
    this.write('info', message, details);
  }

  warn(message: string, details?: Record<string, unknown>): void {
    this.write('warn', message, details);
  }

  error(message: string, details?: Record<string, unknown>): void {
    this.write('error', message, details);
  }

  close(): void {
    if (this.fileStream !== null && !this.fileStream.closed) {
      this.fileStream.end();
    }
  }

  private write(
    level: Exclude<LogLevel, 'silent'>,
    message: string,
    details?: Record<string, unknown>,
  ): void {
    if (LEVEL_WEIGHT[level] < this.threshold) return;
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      msg: redactText(message),
      ...this.bindings,
    };
    if (details !== undefined) {
      const safe = redact(details);
      if (isPlainObject(safe)) {
        Object.assign(record, safe);
      } else {
        record.details = safe;
      }
    }
    let line: string;
    try {
      line = `${JSON.stringify(record)}\n`;
    } catch {
      line = `${JSON.stringify({ ts: record.ts, level, msg: record.msg, details: '[unserializable]' })}\n`;
    }
    process.stderr.write(line);
    if (this.fileStream !== null && !this.fileBroken) {
      try {
        this.fileStream.write(line);
      } catch {
        this.fileBroken = true;
      }
    }
  }
}

export function createLogger(
  level: string,
  opts: { stderrOnly: boolean; file?: string },
): WorkerLogger {
  // stdio 模式下必须只写 stderr；其他模式也统一写 stderr，避免与任何 stdout 输出竞争。
  void opts.stderrOnly;
  let fileStream: WriteStream | null = null;
  if (opts.file !== undefined && opts.file.length > 0) {
    try {
      fileStream = createWriteStream(opts.file, { flags: 'a', mode: 0o600 });
      fileStream.on('error', () => {
        // 文件日志失败不能影响主流程，也不再重试。
        fileStream = null;
      });
    } catch {
      fileStream = null;
    }
  }
  return new StderrLogger(normalizeLevel(level), {}, fileStream);
}
