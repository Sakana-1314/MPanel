import { existsSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { absoluteHostPathSchema, fileRootNameSchema } from '@mpanel/shared';

/**
 * Worker 配置：环境变量 + `$MPANEL_HOME/config.json` 合并，环境变量优先，
 * 命令行参数再优先。非法配置抛出 ConfigError（CLI 退出码 2），绝不静默回退。
 */
export interface WorkerConfig {
  home: string;
  transport: 'http' | 'stdio' | 'reverse-ws';
  /** Default 127.0.0.1. */
  host: string;
  /** Default 8787; 0 means a random port. */
  port: number;
  /** MPANEL_TOKEN; required for serve. */
  token: string;
  /** MPANEL_PUBLIC_URL; used for absolute ticket/redeem URLs. */
  publicUrl?: string;
  corsOrigins: string[];
  dbxOrigin?: string;
  logLevel: string;
  caddy: {
    bin: string;
    configDir: string;
    dataDir: string;
    /** file_server.root allowlist. */
    sitesRoots: string[];
    backupDir: string;
    stagingDir: string;
    adminAddress?: string;
  };
  docker: {
    bin: string;
    composeBin?: string;
    socket?: string;
  };
  databases: {
    pgDumpBin: string;
    pgRestoreBin: string;
    psqlBin: string;
    redisCliBin: string;
    backupDir: string;
  };
  files: {
    roots: { name: string; path: string }[];
    trashDir: string;
    maxUploadBytes: number;
  };
  tasks: {
    shell?: string;
    historyLimit: number;
  };
  security: {
    secretKey?: string;
    keyFile: string;
  };
  redeemRateLimit: {
    windowSec: number;
    max: number;
  };
  /** reverse-ws registration URL. */
  coreUrl?: string;
  machineId?: string;
  machineSecret?: string;
  /** MPANEL_EDGE_KEY: self-service enrollment secret (edge mode). */
  edgeKey?: string;
  insecureCoreTls: boolean;
  /** 实际读取的配置文件路径（不存在也表示候选路径），诊断用。 */
  configFile: string;
}

export const CONFIG_EXIT_CODE = 2;

export class ConfigError extends Error {
  readonly exitCode = CONFIG_EXIT_CODE;
  readonly issues: string[];

  constructor(issues: string[]) {
    const list = issues.length > 0 ? issues : ['未知配置错误'];
    super(`配置无效：\n${list.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = list;
  }
}

export function isConfigError(value: unknown): value is ConfigError {
  return value instanceof ConfigError;
}

interface JsonObject {
  [key: string]: unknown;
}

interface CliOverrides {
  home?: string;
  transport?: string;
  listen?: string;
  host?: string;
  port?: string;
  logLevel?: string;
  token?: string;
}

const TRANSPORTS = new Set(['http', 'stdio', 'reverse-ws']);
const LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error', 'fatal', 'silent']);
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function toAbsolute(input: string, base?: string): string {
  const expanded = expandHome(input.trim());
  return path.resolve(base ?? process.cwd(), expanded);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getPath(source: unknown, keys: readonly string[]): unknown {
  let current: unknown = source;
  for (const key of keys) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBooleanFlag(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value !== 'string') return undefined;
  const lowered = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(lowered)) return true;
  if (['0', 'false', 'no', 'off', ''].includes(lowered)) return false;
  return undefined;
}

function parseCliFlags(argv: readonly string[]): CliOverrides {
  const overrides: CliOverrides = {};
  const takeValue = (index: number, inline: string | undefined, key: string): [string | undefined, number] => {
    if (inline !== undefined && inline.length > 0) return [inline, index];
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('-')) return [next, index + 1];
    void key;
    return [undefined, index];
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined || !token.startsWith('--')) continue;
    const eq = token.indexOf('=');
    const name = eq >= 0 ? token.slice(2, eq) : token.slice(2);
    const inline = eq >= 0 ? token.slice(eq + 1) : undefined;
    switch (name) {
      case 'home': {
        const [value, next] = takeValue(index, inline, name);
        if (value !== undefined) overrides.home = value;
        index = next;
        break;
      }
      case 'transport': {
        const [value, next] = takeValue(index, inline, name);
        if (value !== undefined) overrides.transport = value;
        index = next;
        break;
      }
      case 'listen': {
        const [value, next] = takeValue(index, inline, name);
        if (value !== undefined) overrides.listen = value;
        index = next;
        break;
      }
      case 'host': {
        const [value, next] = takeValue(index, inline, name);
        if (value !== undefined) overrides.host = value;
        index = next;
        break;
      }
      case 'port': {
        const [value, next] = takeValue(index, inline, name);
        if (value !== undefined) overrides.port = value;
        index = next;
        break;
      }
      case 'log-level': {
        const [value, next] = takeValue(index, inline, name);
        if (value !== undefined) overrides.logLevel = value;
        index = next;
        break;
      }
      case 'token': {
        const [value, next] = takeValue(index, inline, name);
        if (value !== undefined) overrides.token = value;
        index = next;
        break;
      }
      default:
        break;
    }
  }
  return overrides;
}

function readConfigFile(configFile: string, issues: string[]): JsonObject {
  if (!existsSync(configFile)) return {};
  let raw: string;
  try {
    raw = readFileSync(configFile, 'utf8');
  } catch (error) {
    issues.push(`无法读取配置文件 ${configFile}：${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
  if (raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed)) {
      issues.push(`配置文件 ${configFile} 必须是 JSON 对象`);
      return {};
    }
    return parsed;
  } catch (error) {
    issues.push(
      `配置文件 ${configFile} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
    return {};
  }
}

function envOrUndefined(env: NodeJS.ProcessEnv, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function pickString(
  cliValue: string | undefined,
  envValue: string | undefined,
  fileValue: unknown,
): string | undefined {
  if (cliValue !== undefined) return cliValue;
  if (envValue !== undefined) return envValue;
  return asString(fileValue);
}

function pickBoolean(
  envValue: string | undefined,
  fileValue: unknown,
): string | boolean | undefined {
  if (envValue !== undefined) return envValue;
  return typeof fileValue === 'boolean' || typeof fileValue === 'string' ? fileValue : undefined;
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function parseBoolean(
  raw: string | boolean | undefined,
  label: string,
  issues: string[],
): boolean {
  if (raw === undefined) return false;
  const value = asBooleanFlag(raw);
  if (value === undefined) {
    issues.push(`${label} 必须是 true/false/1/0（当前值：${String(raw)}）`);
    return false;
  }
  return value;
}

function parseInteger(
  raw: string | number | undefined,
  label: string,
  min: number,
  max: number,
  fallback: number,
  issues: string[],
): number {
  if (raw === undefined) return fallback;
  const value = typeof raw === 'number' ? raw : Number(raw.trim());
  if (!Number.isInteger(value) || value < min || value > max) {
    issues.push(`${label} 必须是 ${min}-${max} 的整数（当前值：${String(raw)}）`);
    return fallback;
  }
  return value;
}

function splitList(raw: string | undefined, separator: RegExp): string[] {
  if (raw === undefined) return [];
  return raw
    .split(separator)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function isValidAbsoluteHostPath(value: string): boolean {
  if (!path.isAbsolute(value)) return false;
  return absoluteHostPathSchema.safeParse(value).success;
}

function parseOrigins(
  raw: unknown,
  label: string,
  issues: string[],
): string[] {
  let values: string[] = [];
  if (typeof raw === 'string') {
    values = splitList(raw, /[,\s]+/);
  } else if (Array.isArray(raw)) {
    values = raw.filter((item): item is string => typeof item === 'string').map((item) => item.trim());
  } else if (raw !== undefined) {
    issues.push(`${label} 必须是逗号分隔字符串或字符串数组`);
    return [];
  }
  const result: string[] = [];
  for (const value of values) {
    if (value === '*') {
      result.push('*');
      continue;
    }
    if (CONTROL_CHARS.test(value)) {
      issues.push(`${label} 包含控制字符：${JSON.stringify(value)}`);
      continue;
    }
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      issues.push(`${label} 的 origin 不合法：${value}（示例 http://localhost:5173）`);
      continue;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      issues.push(`${label} 只允许 http/https origin：${value}`);
      continue;
    }
    if (parsed.username.length > 0 || parsed.password.length > 0) {
      issues.push(`${label} 不允许包含用户名/密码：${value}`);
      continue;
    }
    if (parsed.pathname !== '/' && parsed.pathname !== '') {
      issues.push(`${label} 只能是 origin，不能带路径：${value}`);
      continue;
    }
    const origin = `${parsed.protocol}//${parsed.host}`;
    if (!result.includes(origin)) result.push(origin);
  }
  return result;
}

function parseListen(
  raw: string,
  issues: string[],
): { host?: string; port?: number } {
  const value = raw.trim();
  if (value.length === 0) {
    issues.push('MPANEL_LISTEN 不能为空（示例 127.0.0.1:8787）');
    return {};
  }
  if (/^\d+$/.test(value)) {
    return { host: '127.0.0.1', port: parseInteger(value, 'MPANEL_LISTEN 端口', 0, 65535, 8787, issues) };
  }
  const ipv6 = /^\[([^\]]+)\]:(\d+)$/.exec(value);
  if (ipv6 !== null) {
    return {
      host: ipv6[1],
      port: parseInteger(ipv6[2], 'MPANEL_LISTEN 端口', 0, 65535, 8787, issues),
    };
  }
  const separator = value.lastIndexOf(':');
  if (separator <= 0 || separator === value.length - 1) {
    issues.push(`MPANEL_LISTEN 格式必须是 host:port（当前值：${value}）`);
    return {};
  }
  const host = value.slice(0, separator);
  const portText = value.slice(separator + 1);
  if (!/^\d+$/.test(portText)) {
    issues.push(`MPANEL_LISTEN 端口必须是整数（当前值：${portText}）`);
    return {};
  }
  return {
    host,
    port: parseInteger(portText, 'MPANEL_LISTEN 端口', 0, 65535, 8787, issues),
  };
}

function normalizeHost(host: string, issues: string[]): string {
  const value = host.trim();
  if (value.length === 0 || CONTROL_CHARS.test(value) || /\s/.test(value)) {
    issues.push(`监听地址不合法：${JSON.stringify(host)}`);
    return '127.0.0.1';
  }
  return value;
}

function parseFileRoots(
  raw: unknown,
  label: string,
  issues: string[],
): { name: string; path: string }[] {
  const entries: { name: string; path: string }[] = [];
  const pushEntry = (name: string, rootPath: string): void => {
    const trimmedName = name.trim();
    const trimmedPath = rootPath.trim();
    if (fileRootNameSchema.safeParse(trimmedName).success === false) {
      issues.push(
        `${label} 的名称不合法：${JSON.stringify(trimmedName)}（1-32 位字母数字，可含 _ . -）`,
      );
      return;
    }
    const absolute = toAbsolute(trimmedPath);
    if (!isValidAbsoluteHostPath(absolute)) {
      issues.push(`${label} 的路径必须是绝对路径（当前值：${trimmedPath}）`);
      return;
    }
    if (entries.some((entry) => entry.name === trimmedName)) {
      issues.push(`${label} 存在重复名称：${trimmedName}`);
      return;
    }
    entries.push({ name: trimmedName, path: absolute });
  };

  if (raw === undefined) return entries;
  if (typeof raw === 'string') {
    for (const item of splitList(raw, /,/)) {
      const separator = item.indexOf('=');
      if (separator <= 0) {
        issues.push(`${label} 每项必须是 name=absolutePath（当前值：${item}）`);
        continue;
      }
      pushEntry(item.slice(0, separator), item.slice(separator + 1));
    }
    return entries;
  }
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string') {
        const separator = item.indexOf('=');
        if (separator <= 0) {
          issues.push(`${label} 每项必须是 name=absolutePath（当前值：${item}）`);
          continue;
        }
        pushEntry(item.slice(0, separator), item.slice(separator + 1));
        continue;
      }
      if (isObject(item)) {
        const name = asString(item.name);
        const rootPath = asString(item.path);
        if (name === undefined || rootPath === undefined) {
          issues.push(`${label} 的对象项必须包含 name 与 path`);
          continue;
        }
        pushEntry(name, rootPath);
        continue;
      }
      issues.push(`${label} 的数组项必须是字符串或 {name,path}`);
    }
    return entries;
  }
  issues.push(`${label} 必须是 name=path[,name=path] 或数组`);
  return entries;
}

function parseSiteRoots(
  raw: unknown,
  label: string,
  issues: string[],
): string[] {
  let values: string[] = [];
  if (typeof raw === 'string') {
    values = splitList(raw, /,/);
  } else if (Array.isArray(raw)) {
    values = raw.filter((item): item is string => typeof item === 'string');
  } else if (raw !== undefined) {
    issues.push(`${label} 必须是逗号分隔的绝对路径`);
    return [];
  }
  const roots: string[] = [];
  for (const item of values) {
    // 兼容 name=path 形式；路径本身也可能包含 =，只取第一个。
    const candidate = item.includes('=') ? item.slice(item.indexOf('=') + 1) : item;
    const absolute = toAbsolute(candidate);
    if (!isValidAbsoluteHostPath(absolute)) {
      issues.push(`${label} 的路径必须是绝对路径（当前值：${candidate}）`);
      continue;
    }
    if (!roots.includes(absolute)) roots.push(absolute);
  }
  return roots;
}

function parseRateLimit(
  raw: unknown,
  label: string,
  issues: string[],
): { windowSec: number; max: number } {
  const fallback = { windowSec: 60, max: 10 };
  if (raw === undefined) return fallback;
  if (isObject(raw)) {
    const max = parseInteger(
      typeof raw.max === 'number' || typeof raw.max === 'string' ? raw.max : undefined,
      `${label}.max`,
      1,
      100_000,
      fallback.max,
      issues,
    );
    const windowSec = parseInteger(
      typeof raw.windowSec === 'number' || typeof raw.windowSec === 'string'
        ? raw.windowSec
        : undefined,
      `${label}.windowSec`,
      1,
      86_400,
      fallback.windowSec,
      issues,
    );
    return { windowSec, max };
  }
  if (typeof raw === 'string') {
    const match = /^(\d+)\s*\/\s*(\d+)\s*([smh]?)$/i.exec(raw.trim());
    if (match === null) {
      issues.push(`${label} 格式必须是 max/window（如 10/60s，当前值：${raw}）`);
      return fallback;
    }
    const max = parseInteger(match[1], `${label} 的 max`, 1, 100_000, fallback.max, issues);
    const amount = parseInteger(match[2], `${label} 的窗口`, 1, 86_400, fallback.windowSec, issues);
    const unit = (match[3] ?? 's').toLowerCase();
    const windowSec = unit === 'h' ? amount * 3600 : unit === 'm' ? amount * 60 : amount;
    if (windowSec > 86_400) {
      issues.push(`${label} 的窗口不能超过 86400 秒`);
      return fallback;
    }
    return { windowSec, max };
  }
  issues.push(`${label} 必须是 "max/window" 字符串或 {max,windowSec} 对象`);
  return fallback;
}

function validateSecretKey(raw: string | undefined, label: string, issues: string[]): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim();
  const material = /^[0-9a-fA-F]{64}$/.test(value)
    ? Buffer.from(value, 'hex')
    : Buffer.from(value, 'base64');
  if (material.length !== 32) {
    issues.push(`${label} 必须是 32 字节密钥（base64 或 64 位十六进制）`);
    return undefined;
  }
  return value;
}

function parseUrl(
  raw: string | undefined,
  label: string,
  allowedProtocols: readonly string[],
  issues: string[],
): string | undefined {
  if (raw === undefined) return undefined;
  if (CONTROL_CHARS.test(raw)) {
    issues.push(`${label} 包含控制字符`);
    return undefined;
  }
  try {
    const parsed = new URL(raw);
    if (!allowedProtocols.includes(parsed.protocol)) {
      issues.push(`${label} 协议必须是 ${allowedProtocols.join('/')}（当前值：${raw}）`);
      return undefined;
    }
    return raw;
  } catch {
    issues.push(`${label} 不是合法 URL（当前值：${raw}）`);
    return undefined;
  }
}

export function loadWorkerConfig(
  env: NodeJS.ProcessEnv = process.env,
  argv: readonly string[] = [],
): WorkerConfig {
  const issues: string[] = [];
  const cli = parseCliFlags(argv);

  const homeRaw =
    cli.home ?? envOrUndefined(env, ['MPANEL_HOME']) ?? os.homedir();
  const home = toAbsolute(homeRaw);
  if (CONTROL_CHARS.test(home)) {
    issues.push('MPANEL_HOME 不能包含控制字符');
  }
  const configFile = path.join(home, 'config.json');
  const fileConfig = readConfigFile(configFile, issues);

  const transportRaw = pickString(
    cli.transport,
    envOrUndefined(env, ['MPANEL_TRANSPORT']),
    fileConfig.transport,
  ) ?? 'http';
  const transport = TRANSPORTS.has(transportRaw) ? (transportRaw as WorkerConfig['transport']) : 'http';
  if (!TRANSPORTS.has(transportRaw)) {
    issues.push(
      `MPANEL_TRANSPORT 必须是 http、stdio 或 reverse-ws（当前值：${transportRaw}）`,
    );
  }

  // 监听地址优先级：--listen/MPANEL_LISTEN > config.listen > config.host/port 作为基底；
  // 然后 --host/--port 与 MPANEL_HOST/MPANEL_PORT 可单独覆盖基底字段（环境变量优先于文件）。
  let host = '127.0.0.1';
  let port = 8787;
  if (typeof fileConfig.listen === 'string' && fileConfig.listen.trim().length > 0) {
    const parsed = parseListen(fileConfig.listen, issues);
    if (parsed.host !== undefined) host = parsed.host;
    if (parsed.port !== undefined) port = parsed.port;
  } else {
    const fileHost = asString(fileConfig.host);
    if (fileHost !== undefined) host = fileHost;
    const filePort = typeof fileConfig.port === 'number' || typeof fileConfig.port === 'string'
      ? String(fileConfig.port)
      : undefined;
    port = parseInteger(filePort, 'MPANEL_PORT', 0, 65535, 8787, issues);
  }
  const envListen = cli.listen ?? envOrUndefined(env, ['MPANEL_LISTEN']);
  if (envListen !== undefined) {
    const parsed = parseListen(envListen, issues);
    if (parsed.host !== undefined) host = parsed.host;
    if (parsed.port !== undefined) port = parsed.port;
  }
  const hostOverride = cli.host ?? envOrUndefined(env, ['MPANEL_HOST']);
  if (hostOverride !== undefined) host = hostOverride;
  const portOverride = cli.port ?? envOrUndefined(env, ['MPANEL_PORT']);
  if (portOverride !== undefined) {
    port = parseInteger(portOverride, 'MPANEL_PORT', 0, 65535, 8787, issues);
  }
  host = normalizeHost(host, issues);

  const token = pickString(
    cli.token,
    envOrUndefined(env, ['MPANEL_TOKEN']),
    fileConfig.token,
  ) ?? '';
  if (token.length > 512) {
    issues.push('MPANEL_TOKEN 不能超过 512 字符');
  }
  if (CONTROL_CHARS.test(token)) {
    issues.push('MPANEL_TOKEN 不能包含控制字符');
  }

  const publicUrl = parseUrl(
    pickString(undefined, envOrUndefined(env, ['MPANEL_PUBLIC_URL']), fileConfig.publicUrl),
    'MPANEL_PUBLIC_URL',
    ['http:', 'https:'],
    issues,
  );
  const dbxOrigin = parseUrl(
    pickString(undefined, envOrUndefined(env, ['MPANEL_DBX_ORIGIN']), fileConfig.dbxOrigin),
    'MPANEL_DBX_ORIGIN',
    ['http:', 'https:'],
    issues,
  );
  const corsEnv = envOrUndefined(env, ['MPANEL_CORS_ORIGINS']);
  const corsFile = fileConfig.corsOrigins;
  const corsValue: unknown = corsEnv !== undefined ? corsEnv : corsFile;
  let corsOrigins = parseOrigins(corsValue, 'MPANEL_CORS_ORIGINS', issues);
  if (dbxOrigin !== undefined) {
    const origin = new URL(dbxOrigin).origin;
    if (!corsOrigins.includes('*') && !corsOrigins.includes(origin)) {
      corsOrigins = [...corsOrigins, origin];
    }
  }

  const logLevelRaw = pickString(
    cli.logLevel,
    envOrUndefined(env, ['MPANEL_LOG_LEVEL']),
    fileConfig.logLevel,
  ) ?? 'info';
  const logLevel = LOG_LEVELS.has(logLevelRaw.toLowerCase())
    ? logLevelRaw.toLowerCase()
    : 'info';
  if (!LOG_LEVELS.has(logLevelRaw.toLowerCase())) {
    issues.push(`MPANEL_LOG_LEVEL 必须是 debug/info/warn/error/fatal/silent（当前值：${logLevelRaw}）`);
  }

  const caddyBin = pickString(
    undefined,
    envOrUndefined(env, ['MPANEL_CADDY_BIN', 'CADDY_BIN']),
    getPath(fileConfig, ['caddy', 'bin']) ?? fileConfig.caddyBin,
  ) ?? 'caddy';
  const caddyConfigDirRaw = pickString(
    undefined,
    envOrUndefined(env, ['MPANEL_CADDY_CONFIG_DIR', 'MPANEL_CADDY_CONFIG', 'CADDY_CONFIG']),
    getPath(fileConfig, ['caddy', 'configDir']) ?? fileConfig.caddyConfigDir,
  );
  const caddyDataDirRaw = pickString(
    undefined,
    envOrUndefined(env, ['MPANEL_CADDY_DATA_DIR', 'CADDY_DATA']),
    getPath(fileConfig, ['caddy', 'dataDir']) ?? fileConfig.caddyDataDir,
  );
  const caddyConfigDir =
    caddyConfigDirRaw === undefined ? path.join(home, 'caddy') : toAbsolute(caddyConfigDirRaw);
  const caddyDataDir =
    caddyDataDirRaw === undefined ? path.join(home, 'caddy', 'data') : toAbsolute(caddyDataDirRaw);
  if (!isValidAbsoluteHostPath(caddyConfigDir)) {
    issues.push(`Caddy 配置目录必须是绝对路径（当前值：${caddyConfigDirRaw ?? caddyConfigDir}）`);
  }
  if (!isValidAbsoluteHostPath(caddyDataDir)) {
    issues.push(`Caddy 数据目录必须是绝对路径（当前值：${caddyDataDirRaw ?? caddyDataDir}）`);
  }
  const caddyBackupDir = toAbsolute(
    pickString(
      undefined,
      envOrUndefined(env, ['MPANEL_CADDY_BACKUP_DIR']),
      getPath(fileConfig, ['caddy', 'backupDir']),
    ) ?? path.join(home, 'backups', 'caddy'),
  );
  const caddyStagingDir = toAbsolute(
    pickString(
      undefined,
      envOrUndefined(env, ['MPANEL_CADDY_STAGING_DIR']),
      getPath(fileConfig, ['caddy', 'stagingDir']),
    ) ?? path.join(home, 'caddy', 'staging'),
  );
  const caddyAdmin = pickString(
    undefined,
    envOrUndefined(env, ['MPANEL_CADDY_ADMIN', 'CADDY_ADMIN']),
    getPath(fileConfig, ['caddy', 'adminAddress']) ?? fileConfig.caddyAdmin,
  );
  if (caddyAdmin !== undefined && (CONTROL_CHARS.test(caddyAdmin) || /\s/.test(caddyAdmin))) {
    issues.push(`MPANEL_CADDY_ADMIN 不合法（当前值：${caddyAdmin}）`);
  }

  const filesRootsRaw =
    envOrUndefined(env, ['MPANEL_FILES_ROOTS', 'MPANEL_FILE_ROOTS']) ??
    getPath(fileConfig, ['files', 'roots']) ??
    fileConfig.filesRoots;
  let filesRoots = parseFileRoots(filesRootsRaw, 'MPANEL_FILES_ROOTS', issues);
  if (filesRoots.length === 0) {
    filesRoots = [{ name: 'files', path: path.join(home, 'files') }];
  }
  const defaultSitesRoot = path.join(home, 'sites');
  let sitesRoots = parseSiteRoots(
    envOrUndefined(env, ['MPANEL_SITES_ROOTS']) ??
      getPath(fileConfig, ['caddy', 'sitesRoots']) ??
      fileConfig.sitesRoots,
    'MPANEL_SITES_ROOTS',
    issues,
  );
  for (const root of filesRoots) {
    if (!sitesRoots.includes(root.path)) sitesRoots.push(root.path);
  }
  if (!sitesRoots.includes(defaultSitesRoot)) sitesRoots.push(defaultSitesRoot);

  const dockerBin = pickString(
    undefined,
    envOrUndefined(env, ['MPANEL_DOCKER_BIN', 'DOCKER_BIN']),
    getPath(fileConfig, ['docker', 'bin']) ?? fileConfig.dockerBin,
  ) ?? 'docker';
  const dockerComposeBin = pickString(
    undefined,
    envOrUndefined(env, ['MPANEL_DOCKER_COMPOSE_BIN']),
    getPath(fileConfig, ['docker', 'composeBin']) ?? fileConfig.dockerComposeBin,
  );
  const dockerSocket = asString(getPath(fileConfig, ['docker', 'socket']));

  const pgDumpBin = pickString(
    undefined,
    envOrUndefined(env, ['MPANEL_PG_DUMP_BIN', 'PG_DUMP_BIN']),
    getPath(fileConfig, ['databases', 'pgDumpBin']) ?? fileConfig.pgDumpBin,
  ) ?? 'pg_dump';
  const pgRestoreBin = pickString(
    undefined,
    envOrUndefined(env, ['MPANEL_PG_RESTORE_BIN', 'PG_RESTORE_BIN']),
    getPath(fileConfig, ['databases', 'pgRestoreBin']) ?? fileConfig.pgRestoreBin,
  ) ?? 'pg_restore';
  const psqlBin = pickString(
    undefined,
    envOrUndefined(env, ['MPANEL_PSQL_BIN', 'PSQL_BIN']),
    getPath(fileConfig, ['databases', 'psqlBin']) ?? fileConfig.psqlBin,
  ) ?? 'psql';
  const redisCliBin = pickString(
    undefined,
    envOrUndefined(env, ['MPANEL_REDIS_CLI_BIN', 'REDIS_CLI_BIN']),
    getPath(fileConfig, ['databases', 'redisCliBin']) ?? fileConfig.redisCliBin,
  ) ?? 'redis-cli';
  const databaseBackupDir = toAbsolute(
    pickString(
      undefined,
      envOrUndefined(env, ['MPANEL_DATABASE_BACKUP_DIR']),
      getPath(fileConfig, ['databases', 'backupDir']),
    ) ?? path.join(home, 'backups', 'databases'),
  );

  const trashDir = toAbsolute(
    pickString(
      undefined,
      envOrUndefined(env, ['MPANEL_TRASH_DIR']),
      getPath(fileConfig, ['files', 'trashDir']),
    ) ?? path.join(home, 'trash'),
  );
  const maxUploadBytes = parseInteger(
    pickString(
      undefined,
      envOrUndefined(env, ['MPANEL_MAX_UPLOAD_BYTES']),
      scalarText(getPath(fileConfig, ['files', 'maxUploadBytes']) ?? fileConfig.maxUploadBytes),
    ),
    'MPANEL_MAX_UPLOAD_BYTES',
    1024,
    2 ** 31 - 1,
    100 * 1024 * 1024,
    issues,
  );

  const taskShell = pickString(
    undefined,
    envOrUndefined(env, ['MPANEL_TASK_SHELL']),
    getPath(fileConfig, ['tasks', 'shell']) ?? fileConfig.taskShell,
  );
  const taskHistoryLimit = parseInteger(
    pickString(
      undefined,
      envOrUndefined(env, ['MPANEL_TASK_HISTORY_LIMIT']),
      scalarText(getPath(fileConfig, ['tasks', 'historyLimit']) ?? fileConfig.taskHistoryLimit),
    ),
    'MPANEL_TASK_HISTORY_LIMIT',
    1,
    100_000,
    1000,
    issues,
  );

  const secretKey = validateSecretKey(
    pickString(
      undefined,
      envOrUndefined(env, ['MPANEL_SECRET_KEY']),
      getPath(fileConfig, ['security', 'secretKey']) ?? fileConfig.secretKey,
    ),
    'MPANEL_SECRET_KEY',
    issues,
  );
  const keyFile = toAbsolute(
    pickString(
      undefined,
      envOrUndefined(env, ['MPANEL_SECRET_KEY_FILE']),
      getPath(fileConfig, ['security', 'keyFile']),
    ) ?? path.join(home, 'secrets.key'),
  );

  const redeemRateLimit = parseRateLimit(
    envOrUndefined(env, ['MPANEL_REDEEM_RATE_LIMIT']) ?? fileConfig.redeemRateLimit,
    'MPANEL_REDEEM_RATE_LIMIT',
    issues,
  );

  const coreUrl = parseUrl(
    pickString(
      undefined,
      envOrUndefined(env, ['MPANEL_CORE_URL']),
      fileConfig.coreUrl,
    ),
    'MPANEL_CORE_URL',
    ['http:', 'https:', 'ws:', 'wss:'],
    issues,
  );
  const machineId = pickString(
    undefined,
    envOrUndefined(env, ['MPANEL_MACHINE_ID']),
    fileConfig.machineId,
  );
  if (machineId !== undefined && (machineId.length > 128 || CONTROL_CHARS.test(machineId))) {
    issues.push('MPANEL_MACHINE_ID 不能超过 128 字符或包含控制字符');
  }
  const machineSecret = pickString(
    undefined,
    envOrUndefined(env, ['MPANEL_MACHINE_SECRET']),
    fileConfig.machineSecret,
  );
  if (machineSecret !== undefined && machineSecret.length > 512) {
    issues.push('MPANEL_MACHINE_SECRET 不能超过 512 字符');
  }
  if (machineSecret !== undefined && CONTROL_CHARS.test(machineSecret)) {
    issues.push('MPANEL_MACHINE_SECRET 不能包含控制字符');
  }
  const edgeKey = pickString(
    undefined,
    envOrUndefined(env, ['MPANEL_EDGE_KEY']),
    fileConfig.edgeKey,
  );
  if (edgeKey !== undefined && edgeKey.length > 512) {
    issues.push('MPANEL_EDGE_KEY 不能超过 512 字符');
  }
  if (edgeKey !== undefined && CONTROL_CHARS.test(edgeKey)) {
    issues.push('MPANEL_EDGE_KEY 不能包含控制字符');
  }
  const insecureCoreTls = parseBoolean(
    pickBoolean(
      envOrUndefined(env, ['MPANEL_CORE_INSECURE']),
      fileConfig.insecureCoreTls,
    ),
    'MPANEL_CORE_INSECURE',
    issues,
  );

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }

  return {
    home,
    transport,
    host,
    port,
    token,
    ...(publicUrl === undefined ? {} : { publicUrl }),
    corsOrigins,
    ...(dbxOrigin === undefined ? {} : { dbxOrigin }),
    logLevel,
    caddy: {
      bin: caddyBin,
      configDir: caddyConfigDir,
      dataDir: caddyDataDir,
      sitesRoots,
      backupDir: caddyBackupDir,
      stagingDir: caddyStagingDir,
      ...(caddyAdmin === undefined ? {} : { adminAddress: caddyAdmin }),
    },
    docker: {
      bin: dockerBin,
      ...(dockerComposeBin === undefined ? {} : { composeBin: dockerComposeBin }),
      ...(dockerSocket === undefined ? {} : { socket: dockerSocket }),
    },
    databases: {
      pgDumpBin,
      pgRestoreBin,
      psqlBin,
      redisCliBin,
      backupDir: databaseBackupDir,
    },
    files: {
      roots: filesRoots,
      trashDir,
      maxUploadBytes,
    },
    tasks: {
      ...(taskShell === undefined ? {} : { shell: taskShell }),
      historyLimit: taskHistoryLimit,
    },
    security: {
      ...(secretKey === undefined ? {} : { secretKey }),
      keyFile,
    },
    redeemRateLimit,
    ...(coreUrl === undefined ? {} : { coreUrl }),
    ...(machineId === undefined ? {} : { machineId }),
    ...(machineSecret === undefined ? {} : { machineSecret }),
    ...(edgeKey === undefined ? {} : { edgeKey }),
    insecureCoreTls,
    configFile,
  };
}

export function defaultHomeDir(): string {
  return path.join(os.homedir(), '.mpanel');
}

/**
 * serve 前置校验：token 必填；reverse-ws 还需要 coreUrl 与 machineSecret。
 * 诊断命令（doctor）不调用本函数，便于在配置未完成时查看现状。
 */
export function assertServableConfig(config: WorkerConfig): void {
  const issues: string[] = [];
  if (config.token.length === 0) {
    issues.push(
      'MPANEL_TOKEN 未配置：serve 需要静态访问令牌，可运行 `mpanel-worker token generate --write` 生成并写入配置',
    );
  }
  if (config.transport === 'reverse-ws') {
    if (config.edgeKey !== undefined) {
      // 边缘模式：machineSecret 由入网换取，token 由 edge.json 复用或本地生成。
      if (config.coreUrl === undefined) {
        issues.push('MPANEL_CORE_URL 未配置：边缘入网需要 core 的 HTTP(S) 基地址');
      }
    } else {
      if (config.coreUrl === undefined) {
        issues.push('MPANEL_CORE_URL 未配置：reverse-ws 传输需要 core 的地址');
      }
      if (config.machineSecret === undefined) {
        issues.push('MPANEL_MACHINE_SECRET 未配置：reverse-ws 传输需要 core 下发的机器 secret');
      }
    }
  }
  if (issues.length > 0) throw new ConfigError(issues);
}

/** 配置对象转诊断文本；token/secret 一律脱敏。 */
export function describeConfig(config: WorkerConfig): string {
  const tokenState =
    config.token.length === 0 ? '未配置' : `已配置（${config.token.length} 字符，已隐藏）`;
  const lines = [
    `主目录              ${config.home}`,
    `配置文件            ${config.configFile}`,
    `传输                ${config.transport}`,
    `监听地址            ${config.host}:${config.port}`,
    `访问令牌            ${tokenState}`,
    `日志级别            ${config.logLevel}`,
    `CORS origins        ${config.corsOrigins.length === 0 ? '（未配置，浏览器跨域被拒绝）' : config.corsOrigins.join(', ')}`,
    `文件根              ${config.files.roots.map((root) => `${root.name}=${root.path}`).join(', ')}`,
    `上传上限            ${config.files.maxUploadBytes} 字节`,
    `Caddy 二进制        ${config.caddy.bin}`,
    `Caddy 配置/数据     ${config.caddy.configDir} / ${config.caddy.dataDir}`,
    `站点根白名单        ${config.caddy.sitesRoots.join(', ')}`,
    `Docker 二进制       ${config.docker.bin}${config.docker.composeBin === undefined ? '' : `（compose: ${config.docker.composeBin}）`}`,
    `数据库工具          pg_dump=${config.databases.pgDumpBin}, psql=${config.databases.psqlBin}, pg_restore=${config.databases.pgRestoreBin}, redis-cli=${config.databases.redisCliBin}`,
    `Core URL            ${config.coreUrl ?? '（未配置）'}`,
    `机器 ID             ${config.machineId ?? '（未配置）'}`,
    `机器 secret         ${config.machineSecret === undefined ? '（未配置）' : '已配置（已隐藏）'}`,
    `边缘模式            ${config.edgeKey === undefined ? '未启用' : '启用（MPANEL_EDGE_KEY 已配置，已隐藏）'}`,
    `忽略 Core TLS 校验  ${config.insecureCoreTls ? '是（仅开发环境）' : '否'}`,
  ];
  return lines.join('\n');
}
