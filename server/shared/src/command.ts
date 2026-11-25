/**
 * Command execution contract. Every implementation MUST use child_process
 * spawn/execFile with an argv array. String concatenation into a shell command
 * is forbidden, except for ShellRunner.run(), which exists solely for the
 * trusted-owner task module.
 */

export interface CommandOptions {
  cwd?: string;
  /** Explicit env merged onto the runner's minimal allowlist; never full process.env. */
  env?: Record<string, string | undefined>;
  /** Reserved for the stdio worker spawn path; command executions must keep this false/default. */
  inheritEnv?: boolean;
  timeoutMs?: number;
  maxBufferBytes?: number;
  /** Written to stdin, then stdin is closed. */
  input?: string | Uint8Array;
  /** Extra argv array; never a shell string. */
  args?: readonly string[];
}

export interface CommandResult {
  command: string;
  args: string[];
  /** null when the process was killed by a signal. */
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
  timedOut: boolean;
}

export interface CommandStream {
  stdout: AsyncIterable<Uint8Array>;
  stderr: AsyncIterable<Uint8Array>;
  /** Resolves after the process exits and both streams are drained. */
  completion: Promise<CommandResult>;
  kill(signal?: string): void;
}

export interface CommandRunner {
  run(command: string, args: readonly string[], options?: CommandOptions): Promise<CommandResult>;
  stream(command: string, args: readonly string[], options?: CommandOptions): CommandStream;
  /** Probe a binary without throwing; used by capability detection. */
  which(command: string): Promise<string | null>;
}

export interface ShellRunOptions extends Omit<CommandOptions, 'args' | 'input'> {
  /** Absolute shell path or an allowlisted name resolved by the implementation. */
  shell?: string;
  stdin?: string;
}

/**
 * Trusted-owner escape hatch. The command string is executed by a shell and
 * must never be exposed to untrusted users. Currently used by scheduled tasks
 * only. Interactive shells use the PTY module instead.
 */
export interface ShellRunner {
  runShell(command: string, options?: ShellRunOptions): Promise<CommandResult>;
  streamShell(command: string, options?: ShellRunOptions): CommandStream;
}
