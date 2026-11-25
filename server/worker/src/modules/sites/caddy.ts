/**
 * Caddy 适配器：能力探测、`caddy validate` 与 `caddy reload`（或 admin API /load）。
 *
 * 所有外部命令都经 CommandRunner 以 argv 数组执行，绝不拼接 shell 字符串。
 * 命令不可用/失败时返回结构化结果，由上层转换为 UNAVAILABLE / UPSTREAM_ERROR。
 */
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  availableCapability,
  unavailableCapability,
} from '@mpanel/shared';
import type { CapabilityStatus, CommandResult, CommandRunner } from '@mpanel/shared';
import type { WorkerConfig } from '../../config.js';

const PROBE_TIMEOUT_MS = 5_000;
const VALIDATE_TIMEOUT_MS = 20_000;
const RELOAD_TIMEOUT_MS = 30_000;
const OUTPUT_LIMIT = 8_000;

export const CADDY_HINT = '安装 Caddy 或设置 MPANEL_CADDY_BIN 指向 caddy 可执行文件后重试';

export interface CaddyClient {
  probe(): Promise<CapabilityStatus>;
  validate(configPath: string): Promise<CommandResult>;
  reload(configPath: string): Promise<CommandResult>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emptyResult(command: string, args: string[], error: string): CommandResult {
  return {
    command,
    args,
    code: 1,
    signal: null,
    stdout: '',
    stderr: error.slice(0, OUTPUT_LIMIT),
    durationMs: 0,
    truncated: error.length > OUTPUT_LIMIT,
    timedOut: false,
  };
}

async function safeRun(
  runner: CommandRunner,
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<CommandResult> {
  try {
    return await runner.run(command, args, { timeoutMs, maxBufferBytes: OUTPUT_LIMIT });
  } catch (error) {
    return emptyResult(command, args, messageOf(error));
  }
}

function parseVersion(stdout: string): string | undefined {
  const line = stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find((value) => value.length > 0);
  if (!line) return undefined;
  const match = /v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/.exec(line);
  return match ? match[0] : line.slice(0, 80);
}

function adminBaseUrl(address: string): string {
  let value = address.trim();
  if (value.startsWith(':')) value = `127.0.0.1${value}`;
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  return value.replace(/\/+$/, '');
}

/**
 * 通过 admin API /load 重载配置。Caddy 默认 admin 端点只监听 loopback；
 * 该路径在 Caddy 以服务方式运行时比 CLI 更可靠。
 */
async function reloadViaAdminApi(address: string, configPath: string): Promise<CommandResult> {
  const started = Date.now();
  const command = 'caddy-admin-api';
  const args = [configPath];
  let body: string;
  try {
    body = await readFile(configPath, 'utf8');
  } catch (error) {
    return emptyResult(command, args, `读取 Caddyfile 失败：${messageOf(error)}`);
  }
  const url = `${adminBaseUrl(address)}/load`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'text/caddyfile' },
      body,
      signal: AbortSignal.timeout(RELOAD_TIMEOUT_MS),
    });
    const text = await response.text();
    return {
      command,
      args,
      code: response.ok ? 0 : 1,
      signal: null,
      stdout: response.ok ? text.slice(0, OUTPUT_LIMIT) : '',
      stderr: response.ok ? '' : (text || `HTTP ${response.status}`).slice(0, OUTPUT_LIMIT),
      durationMs: Date.now() - started,
      truncated: text.length > OUTPUT_LIMIT,
      timedOut: false,
    };
  } catch (error) {
    return {
      ...emptyResult(command, args, `admin API 调用失败：${messageOf(error)}`),
      durationMs: Date.now() - started,
    };
  }
}

export function createCaddyClient(config: WorkerConfig, runner: CommandRunner): CaddyClient {
  const bin = config.caddy.bin;

  return {
    async probe(): Promise<CapabilityStatus> {
      let resolved: string | null = null;
      try {
        resolved = await runner.which(bin);
      } catch (error) {
        return unavailableCapability(`Caddy 探测失败：${messageOf(error)}`, { bin, hint: CADDY_HINT });
      }
      if (!resolved && path.isAbsolute(bin)) {
        // which 可能只查 PATH；绝对路径再直接确认一次。
        try {
          await access(bin);
          resolved = bin;
        } catch {
          resolved = null;
        }
      }
      if (!resolved) {
        return unavailableCapability(`未找到 Caddy 可执行文件：${bin}`, { bin, hint: CADDY_HINT });
      }
      const result = await safeRun(runner, bin, ['version'], PROBE_TIMEOUT_MS);
      if (result.code !== 0) {
        const output = (result.stderr || result.stdout).trim().slice(0, 500);
        return unavailableCapability(
          result.timedOut
            ? `caddy version 超时（${PROBE_TIMEOUT_MS}ms）`
            : `caddy version 执行失败（exit=${String(result.code)}）${output ? `：${output}` : ''}`,
          { bin, path: resolved, hint: CADDY_HINT },
        );
      }
      return availableCapability(parseVersion(result.stdout), {
        bin,
        path: resolved,
        dataDir: config.caddy.dataDir,
      });
    },

    async validate(configPath: string): Promise<CommandResult> {
      return safeRun(
        runner,
        bin,
        ['validate', '--config', configPath, '--adapter', 'caddyfile'],
        VALIDATE_TIMEOUT_MS,
      );
    },

    async reload(configPath: string): Promise<CommandResult> {
      if (config.caddy.adminAddress) {
        return reloadViaAdminApi(config.caddy.adminAddress, configPath);
      }
      return safeRun(
        runner,
        bin,
        ['reload', '--config', configPath, '--adapter', 'caddyfile'],
        RELOAD_TIMEOUT_MS,
      );
    },
  };
}

/** 截断命令输出用于 error.details.output，避免把整段日志塞进响应。 */
export function summarizeCommandOutput(result: CommandResult, limit = 4_000): string {
  const merged = [result.stdout, result.stderr]
    .filter((value) => value.trim().length > 0)
    .join('\n')
    .trim();
  if (merged.length === 0) return `exit=${String(result.code)}`;
  return merged.length > limit ? `${merged.slice(0, limit)}\n…（输出已截断）` : merged;
}
