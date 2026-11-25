import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { mkdir, readdir, readFile, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  availableCapability,
  badRequest,
  isPanelError,
  PanelError,
  STACK_NAME_PATTERN,
  unavailableCapability,
  type CapabilityStatus,
  type CommandOptions,
  type CommandResult,
  type CommandRunner,
  type ContainerDetail,
  type ContainerMount,
  type ContainerPort,
  type ContainerStats,
  type ContainerSummary,
  type ExecRequest,
  type ExecResult,
  type ImageSummary,
  type ModuleLogger,
  type StackSummary,
} from '@mpanel/shared';
import type { WorkerConfig } from '../../config.js';

/** 内部归一化后的日志参数（HTTP query 的字符串形式由路由层用 zod 转换）。 */
export interface ContainerLogsOptions {
  follow?: boolean;
  tail?: number;
  since?: string;
  timestamps?: boolean;
  stdout?: boolean;
  stderr?: boolean;
  /** 客户端断开时中止流；实现会立即杀掉 docker logs 子进程。 */
  signal?: AbortSignal;
}

export interface DockerLogEntry {
  stream: 'stdout' | 'stderr';
  data: string;
  ts?: string;
}

export interface ManagedStackFile {
  name: string;
  path: string;
  updatedAt: string;
}

export interface DockerClient {
  probe(): Promise<CapabilityStatus>;
  listContainers(q: { all?: boolean; status?: string; q?: string }): Promise<ContainerSummary[]>;
  inspect(id: string): Promise<ContainerDetail>;
  start(id: string): Promise<void>;
  stop(id: string, timeoutSec?: number): Promise<void>;
  restart(id: string, timeoutSec?: number): Promise<void>;
  remove(id: string, opts: { force?: boolean; removeVolumes?: boolean }): Promise<void>;
  logs(id: string, opts: ContainerLogsOptions): AsyncIterable<DockerLogEntry>;
  stats(id: string): Promise<ContainerStats>;
  exec(id: string, req: ExecRequest): Promise<ExecResult>;
  pruneContainers(): Promise<{ deleted: number; reclaimedBytes: number }>;
  listImages(q: { all?: boolean; dangling?: boolean; q?: string }): Promise<ImageSummary[]>;
  pull(ref: string): Promise<ImageSummary>;
  removeImage(id: string, force?: boolean): Promise<void>;
  pruneImages(opts: { danglingOnly?: boolean }): Promise<{ deleted: number; reclaimedBytes: number }>;
  composeLs(): Promise<StackSummary[]>;
  composeUp(
    name: string,
    opts: { build?: boolean; forceRecreate?: boolean },
  ): Promise<{ output: string }>;
  composeDown(
    name: string,
    opts: { removeVolumes?: boolean; removeImages?: boolean },
  ): Promise<{ output: string }>;
  composeRestart(name: string): Promise<{ output: string }>;
  composePull(name: string): Promise<{ output: string }>;
  composeConfig(yamlPath: string): Promise<CommandResult>;
  /** stacks 服务专用：受控的 compose 文件访问面（只允许 $MPANEL_HOME/stacks）。 */
  composePathFor(name: string): string;
  composeDirectory(name: string): string;
  composeFileLimitBytes(): number;
  readManagedCompose(name: string): Promise<{ path: string; yaml: string } | null>;
  writeManagedCompose(name: string, yaml: string): Promise<{ path: string }>;
  validateComposeYaml(name: string, yaml: string): Promise<void>;
  managedStackDirectories(): Promise<ManagedStackFile[]>;
  removeStackDirectory(name: string): Promise<void>;
}

const CONTAINER_REF_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const IMAGE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]{0,511}$/;
const SINCE_PATTERN = /^[A-Za-z0-9:.+\-]{1,64}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const MAX_OUTPUT_DETAIL = 4000;
const MAX_COMPOSE_BYTES = 1_048_576;
const MIB = 1024 * 1024;
/** setTimeout 可表示的最大值（2^31-1 ms），用于近似“不超时”的 follow 日志。 */
const FOLLOW_STREAM_TIMEOUT_MS = 2_147_483_647;

const CONTAINER_STATUSES = new Set([
  'created',
  'restarting',
  'running',
  'removing',
  'paused',
  'exited',
  'dead',
]);

const DOCKER_UNAVAILABLE_HINT =
  '请安装 Docker CLI 并启动 daemon（Linux: sudo systemctl start docker；Windows/macOS: 启动 Docker Desktop），或设置 MPANEL_DOCKER_BIN 指向 docker 可执行文件。';
const COMPOSE_UNAVAILABLE_HINT =
  '请安装 Docker Compose v2（docker compose 插件或 docker-compose），或设置 MPANEL_DOCKER_COMPOSE_BIN 指向 compose 可执行文件。';

/* ------------------------------------------------------------------ */
/* 通用小工具                                                          */
/* ------------------------------------------------------------------ */

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function truncateText(
  value: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { text: value, truncated: false };
  const buffer = Buffer.from(value, 'utf8').subarray(0, maxBytes);
  let text = buffer.toString('utf8');
  // 截断点可能落在多字节字符中间；替换字符会让字节数反弹，逐字回退确保 <= maxBytes。
  while (text.length > 0 && Buffer.byteLength(text, 'utf8') > maxBytes) {
    text = text.slice(0, -1);
  }
  return { text, truncated: true };
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** 容器 id/name 只接受合法字符集，且始终作为独立 argv 传入。 */
export function assertContainerReference(id: string): void {
  if (!isValidContainerReference(id)) {
    throw badRequest('容器 id/名称不合法', { field: 'id' });
  }
}

export function isValidContainerReference(id: string): boolean {
  return typeof id === 'string' && CONTAINER_REF_PATTERN.test(id);
}

/** 镜像引用（名称:tag、sha256 id、registry:port/path@digest）。 */
export function assertImageReference(ref: string): void {
  if (
    typeof ref !== 'string' ||
    ref.length === 0 ||
    ref.length > 512 ||
    !IMAGE_REF_PATTERN.test(ref) ||
    /^\s*-/.test(ref)
  ) {
    throw badRequest('镜像引用不合法', { field: 'reference' });
  }
}

export function assertStackName(name: string): void {
  if (typeof name !== 'string' || !STACK_NAME_PATTERN.test(name)) {
    throw badRequest('栈名称不合法', { field: 'name' });
  }
}

export function assertSince(value: string): void {
  if (!SINCE_PATTERN.test(value)) {
    throw badRequest('since 参数不合法', { field: 'since' });
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function epochIso(): string {
  return new Date(0).toISOString();
}

/** 把 docker 的多种时间格式（"2024-01-02 03:04:05 +0000 UTC"、RFC3339Nano）规范成 ISO。 */
export function parseDockerDate(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return epochIso();
  let candidate = value.trim();
  // 去掉 "2024-01-02 03:04:05 +0000 UTC" 末尾的时区简称。
  candidate = candidate.replace(/\s+[A-Za-z]{2,6}$/, '');
  candidate = candidate.replace(
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?\s*([+-]\d{2}:?\d{2}|Z)?$/,
    (
      _match: string,
      date: string,
      time: string,
      fraction: string | undefined,
      offset: string | undefined,
    ) => `${date}T${time}${fraction ? fraction.slice(0, 4) : ''}${offset ?? 'Z'}`,
  );
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : epochIso();
}

/** 解析 docker 的人类可读容量（B/kB/MB/MiB/GiB/TiB）。 */
export function parseSizeBytes(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value);
  if (typeof value !== 'string') return 0;
  const match = /^\s*([0-9]+(?:\.[0-9]+)?)\s*([a-zA-Z]{0,3})\s*$/.exec(value);
  if (!match) return 0;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return 0;
  const unit = (match[2] ?? '').toLowerCase();
  const factors: Record<string, number> = {
    '': 1,
    b: 1,
    kb: 1000,
    kib: 1024,
    mb: 1000 ** 2,
    mib: 1024 ** 2,
    gb: 1000 ** 3,
    gib: 1024 ** 3,
    tb: 1000 ** 4,
    tib: 1024 ** 4,
    pb: 1000 ** 5,
    pib: 1024 ** 5,
  };
  const factor = factors[unit] ?? 1;
  return Math.max(0, Math.round(amount * factor));
}

function parsePercent(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value);
  if (typeof value !== 'string') return 0;
  const parsed = Number.parseFloat(value.replace('%', '').trim());
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function splitPair(value: unknown): [string, string] {
  if (typeof value !== 'string') return ['', ''];
  const index = value.indexOf('/');
  if (index < 0) return [value.trim(), ''];
  return [value.slice(0, index).trim(), value.slice(index + 1).trim()];
}

/** `docker ps` 的 Labels 是逗号拼接字符串；也兼容 inspect 的对象形式。 */
export function parseLabelsField(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (record) {
    const out: Record<string, string> = {};
    for (const [key, entry] of Object.entries(record)) {
      if (typeof entry === 'string') out[key] = entry;
      else if (entry !== null && entry !== undefined) out[key] = String(entry);
    }
    return out;
  }
  if (typeof value !== 'string' || value.trim() === '') return {};
  const out: Record<string, string> = {};
  for (const pair of value.split(',')) {
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    out[pair.slice(0, index).trim()] = pair.slice(index + 1);
  }
  return out;
}

function parseNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim().replace(/^\/+/, ''))
      .filter((entry) => entry.length > 0);
  }
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((entry) => entry.trim().replace(/^\/+/, ''))
    .filter((entry) => entry.length > 0);
}

function toPort(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : undefined;
}

function parsePortSpec(value: string): { port: number; type: ContainerPort['type'] } | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const slash = trimmed.lastIndexOf('/');
  const portPart = slash >= 0 ? trimmed.slice(0, slash) : trimmed;
  const protocol = slash >= 0 ? trimmed.slice(slash + 1).toLowerCase() : 'tcp';
  const type: ContainerPort['type'] =
    protocol === 'udp' || protocol === 'sctp' ? protocol : 'tcp';
  const first = portPart.split('-')[0] ?? '';
  const port = toPort(first);
  return port === undefined ? undefined : { port, type };
}

function parseHostBinding(value: string): { ip?: string; port?: number } {
  const trimmed = value.trim();
  if (trimmed === '') return {};
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    const ip = end > 0 ? trimmed.slice(1, end) : undefined;
    const rest = end > 0 ? trimmed.slice(end + 1) : '';
    return { ...(ip ? { ip } : {}), port: toPort(rest.replace(/^:/, '')) };
  }
  const index = trimmed.lastIndexOf(':');
  if (index < 0) return { port: toPort(trimmed) };
  const ip = trimmed.slice(0, index);
  return { ...(ip ? { ip } : {}), port: toPort(trimmed.slice(index + 1)) };
}

/** 解析 `docker ps` 的 Ports 字符串，或 inspect 的对象/数组形式。 */
export function parsePortBindings(raw: unknown): ContainerPort[] {
  const result: ContainerPort[] = [];
  const seen = new Set<string>();
  const push = (port: ContainerPort): void => {
    const key = `${port.ip ?? ''}|${port.publicPort ?? ''}|${port.privatePort}|${port.type}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push(port);
  };

  if (Array.isArray(raw)) {
    for (const item of raw) {
      const record = asRecord(item);
      if (!record) continue;
      const privatePort = toPort(String(record.PrivatePort ?? ''));
      if (privatePort === undefined) continue;
      const publicPort = toPort(String(record.PublicPort ?? ''));
      const protocol = String(record.Type ?? 'tcp').toLowerCase();
      const type: ContainerPort['type'] =
        protocol === 'udp' || protocol === 'sctp' ? protocol : 'tcp';
      const ip = asString(record.IP) ?? asString(record.Ip);
      push({
        ...(ip ? { ip } : {}),
        privatePort,
        ...(publicPort === undefined ? {} : { publicPort }),
        type,
      });
    }
    return result;
  }

  if (typeof raw !== 'string' || raw.trim() === '') return result;
  for (const chunk of raw.split(',')) {
    const entry = chunk.trim();
    if (entry === '') continue;
    const arrow = entry.lastIndexOf('->');
    if (arrow < 0) {
      const spec = parsePortSpec(entry);
      if (spec) push({ privatePort: spec.port, type: spec.type });
      continue;
    }
    const left = entry.slice(0, arrow);
    const right = entry.slice(arrow + 2);
    const spec = parsePortSpec(right);
    if (!spec) continue;
    const binding = parseHostBinding(left);
    push({
      ...(binding.ip ? { ip: binding.ip } : {}),
      privatePort: spec.port,
      ...(binding.port === undefined ? {} : { publicPort: binding.port }),
      type: spec.type,
    });
  }
  return result;
}

function parseInspectPorts(raw: unknown): ContainerPort[] {
  const record = asRecord(raw);
  if (!record) return [];
  const collected: ContainerPort[] = [];
  const seen = new Set<string>();
  for (const [key, bindings] of Object.entries(record)) {
    const spec = parsePortSpec(key);
    if (!spec) continue;
    if (!Array.isArray(bindings) || bindings.length === 0) {
      const dedupe = `${spec.port}|${spec.type}`;
      if (!seen.has(dedupe)) {
        seen.add(dedupe);
        collected.push({ privatePort: spec.port, type: spec.type });
      }
      continue;
    }
    for (const binding of bindings) {
      const host = asRecord(binding);
      if (!host) continue;
      const ip = asString(host.HostIp);
      const publicPort = toPort(String(host.HostPort ?? ''));
      const dedupe = `${ip ?? ''}|${publicPort ?? ''}|${spec.port}|${spec.type}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      collected.push({
        ...(ip ? { ip } : {}),
        privatePort: spec.port,
        ...(publicPort === undefined ? {} : { publicPort }),
        type: spec.type,
      });
    }
  }
  return collected;
}

function parseJsonRows(stdout: string): Record<string, unknown>[] {
  const trimmed = stdout.trim();
  if (trimmed === '') return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (entry): entry is Record<string, unknown> => asRecord(entry) !== undefined,
        );
      }
    } catch {
      // 落到逐行解析。
    }
  }
  if (!trimmed.includes('\n')) {
    try {
      const single: unknown = JSON.parse(trimmed);
      const record = asRecord(single);
      if (record) return [record];
    } catch {
      // 落到逐行解析。
    }
  }
  const rows: Record<string, unknown>[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const text = line.trim();
    if (text === '') continue;
    try {
      const parsed: unknown = JSON.parse(text);
      const record = asRecord(parsed);
      if (record) rows.push(record);
    } catch {
      // 不同 docker 版本可能混入非 JSON 警告行，忽略。
    }
  }
  return rows;
}

function firstOutputLine(value: string): string {
  const line = value.trim().split(/\r?\n/)[0] ?? '';
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

/* ------------------------------------------------------------------ */
/* 分页游标（不透明、客户端不得解析）                                  */
/* ------------------------------------------------------------------ */

export interface CursorState {
  k: string;
  id: string;
}

export function encodeCursor(state: CursorState): string {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): CursorState | null {
  if (cursor === undefined || cursor === '') return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    const record = asRecord(parsed);
    if (record && typeof record.k === 'string' && typeof record.id === 'string') {
      return { k: record.k, id: record.id };
    }
  } catch {
    // 统一在下面抛出。
  }
  throw badRequest('分页 cursor 无效', { field: 'cursor' });
}

export function paginateDescending<T>(
  items: T[],
  cursor: CursorState | null,
  keyOf: (item: T) => string,
  idOf: (item: T) => string,
  limit: number,
): { items: T[]; nextCursor: string | null } {
  const filtered =
    cursor === null
      ? items
      : items.filter((item) => {
          const key = keyOf(item);
          return key < cursor.k || (key === cursor.k && idOf(item) > cursor.id);
        });
  const page = filtered.slice(0, limit);
  const last = page[page.length - 1];
  const hasMore = filtered.length > limit && last !== undefined;
  return {
    items: page,
    nextCursor: hasMore ? encodeCursor({ k: keyOf(last), id: idOf(last) }) : null,
  };
}

export function paginateAscending<T>(
  items: T[],
  cursor: CursorState | null,
  keyOf: (item: T) => string,
  limit: number,
): { items: T[]; nextCursor: string | null } {
  const filtered = cursor === null ? items : items.filter((item) => keyOf(item) > cursor.k);
  const page = filtered.slice(0, limit);
  const last = page[page.length - 1];
  const hasMore = filtered.length > limit && last !== undefined;
  return {
    items: page,
    nextCursor: hasMore ? encodeCursor({ k: keyOf(last), id: keyOf(last) }) : null,
  };
}

/* ------------------------------------------------------------------ */
/* 客户端实现                                                          */
/* ------------------------------------------------------------------ */

interface ProbeCache {
  at: number;
  status: CapabilityStatus;
}

interface ComposeCache {
  at: number;
  ok: boolean;
  reason?: string;
}

type StreamName = 'stdout' | 'stderr';

export function createDockerClient(
  config: WorkerConfig,
  runner: CommandRunner,
  logger: ModuleLogger,
): DockerClient {
  return new DockerClientImpl(config, runner, logger);
}

class DockerClientImpl implements DockerClient {
  private readonly bin: string;
  private readonly composeBin?: string;
  private readonly stackRoot: string;
  private probeCache?: ProbeCache;
  private composeCache?: ComposeCache;
  private readonly probeTtlMs = 5000;

  constructor(
    private readonly config: WorkerConfig,
    private readonly runner: CommandRunner,
    private readonly logger: ModuleLogger,
  ) {
    this.bin = config.docker.bin;
    this.composeBin = config.docker.composeBin;
    this.stackRoot = resolve(config.home, 'stacks');
  }

  /* ---------------------------- 能力探测 ---------------------------- */

  /** 配置了 socket 时，把 --host 作为 docker 全局参数（composeBin 直连时由用户自行配置）。 */
  private globalArgs(): string[] {
    const socket = this.config.docker.socket;
    return socket !== undefined && socket.trim() !== '' ? ['--host', socket.trim()] : [];
  }

  async probe(): Promise<CapabilityStatus> {
    const now = Date.now();
    if (this.probeCache && now - this.probeCache.at < this.probeTtlMs) {
      return this.probeCache.status;
    }
    const status = await this.probeUncached();
    this.probeCache = { at: now, status };
    return status;
  }

  private async probeUncached(): Promise<CapabilityStatus> {
    let resolved: string | null = null;
    try {
      resolved = await this.runner.which(this.bin);
    } catch (error) {
      this.logger.debug('docker which 探测失败', {
        bin: this.bin,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (resolved === null) {
      return unavailableCapability(`未找到 docker 可执行文件: ${this.bin}`, {
        bin: this.bin,
        ...(this.config.docker.socket ? { socket: this.config.docker.socket } : {}),
        hint: DOCKER_UNAVAILABLE_HINT,
      });
    }

    let result: CommandResult;
    try {
      result = await this.runner.run(
        this.bin,
        [...this.globalArgs(), 'version', '--format', '{{json .Server.Version}}'],
        { timeoutMs: 8000, maxBufferBytes: MIB },
      );
    } catch (error) {
      return unavailableCapability(
        `执行 docker version 失败: ${error instanceof Error ? error.message : String(error)}`,
        {
          bin: resolved,
          hint: DOCKER_UNAVAILABLE_HINT,
          reason: error instanceof Error ? error.message : String(error),
        },
      );
    }

    if (result.code !== 0) {
      const output = `${result.stderr}\n${result.stdout}`.trim();
      const daemonDown =
        /cannot connect to the docker daemon|error during connect|is the docker daemon running|docker daemon is not running|docker_engine/i.test(
          output,
        );
      return unavailableCapability(
        daemonDown
          ? `无法连接 Docker daemon${output ? `: ${firstOutputLine(output)}` : ''}`
          : `docker version 检查失败${output ? `: ${firstOutputLine(output)}` : ''}`,
        {
          bin: resolved,
          ...(this.config.docker.socket ? { socket: this.config.docker.socket } : {}),
          ...(output ? { output: truncateText(output, MAX_OUTPUT_DETAIL).text } : {}),
          hint: DOCKER_UNAVAILABLE_HINT,
        },
      );
    }

    const raw = result.stdout.trim();
    let version: string | undefined;
    if (raw !== '' && raw !== 'null') {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed === 'string') version = parsed;
        else if (parsed !== null) version = String(parsed);
      } catch {
        version = raw.replace(/^"|"$/g, '');
      }
    }
    return availableCapability(version, {
      bin: resolved,
      ...(this.config.docker.socket ? { socket: this.config.docker.socket } : {}),
    });
  }

  private async ensureAvailable(): Promise<void> {
    const status = await this.probe();
    if (status.available) return;
    const reason = status.reason ?? 'Docker 不可用';
    throw new PanelError('UNAVAILABLE', reason, {
      capability: 'docker',
      reason,
      hint: DOCKER_UNAVAILABLE_HINT,
    });
  }

  /* ---------------------------- 命令执行 ---------------------------- */

  private async runDocker(args: string[], options?: CommandOptions): Promise<CommandResult> {
    try {
      return await this.runner.run(this.bin, [...this.globalArgs(), ...args], {
        timeoutMs: 120_000,
        maxBufferBytes: 8 * MIB,
        ...(options ?? {}),
      });
    } catch (error) {
      throw commandSpawnError(this.bin, error, '执行 docker 命令');
    }
  }

  private async runCommand(
    command: string,
    args: string[],
    options: CommandOptions | undefined,
    label: string,
  ): Promise<CommandResult> {
    try {
      return await this.runner.run(command, args, {
        timeoutMs: 120_000,
        maxBufferBytes: 8 * MIB,
        ...(options ?? {}),
      });
    } catch (error) {
      throw commandSpawnError(command, error, label);
    }
  }

  private dockerFailure(result: CommandResult, label: string): PanelError {
    const output = `${result.stderr}\n${result.stdout}`.trim();
    const lower = output.toLowerCase();
    if (
      lower.includes('no such container') ||
      lower.includes('no such object') ||
      lower.includes('no such image')
    ) {
      return new PanelError('NOT_FOUND', `${label}失败：目标不存在`, {
        output: truncateText(output, MAX_OUTPUT_DETAIL).text,
      });
    }
    if (
      lower.includes('cannot connect to the docker daemon') ||
      lower.includes('error during connect') ||
      lower.includes('is the docker daemon running') ||
      lower.includes('docker daemon is not running')
    ) {
      return new PanelError('UNAVAILABLE', `${label}失败：无法连接 Docker daemon`, {
        capability: 'docker',
        reason: firstOutputLine(output),
        hint: DOCKER_UNAVAILABLE_HINT,
      });
    }
    return new PanelError('UPSTREAM_ERROR', `${label}失败`, {
      exitCode: result.code,
      ...(result.timedOut ? { timedOut: true } : {}),
      output: truncateText(output, MAX_OUTPUT_DETAIL).text,
    });
  }

  private ensureResult(result: CommandResult, label: string): CommandResult {
    if (result.code !== 0) throw this.dockerFailure(result, label);
    return result;
  }

  /* ---------------------------- 容器列表 ---------------------------- */

  async listContainers(q: {
    all?: boolean;
    status?: string;
    q?: string;
  }): Promise<ContainerSummary[]> {
    await this.ensureAvailable();
    const args = ['ps', '--no-trunc', '--format', 'json'];
    if (q.all === true) args.splice(1, 0, '-a');
    if (q.status !== undefined) {
      const status = q.status.trim();
      if (!CONTAINER_STATUSES.has(status)) {
        throw badRequest('无效的容器状态过滤', { field: 'status', status });
      }
      args.push('--filter', `status=${status}`);
    }
    const result = this.ensureResult(await this.runDocker(args), '列出容器');
    const rows = parseJsonRows(result.stdout);
    if (rows.length === 0 && result.stdout.trim() !== '') {
      this.logger.warn('docker ps 输出无法解析为 JSON', {
        sample: truncateText(result.stdout, 400).text,
      });
    }
    const filtered = q.q?.trim().toLowerCase();
    const containers: ContainerSummary[] = [];
    for (const row of rows) {
      const summary = mapPsRow(row);
      if (!summary) continue;
      if (!matchesContainerQuery(summary, filtered)) continue;
      containers.push(summary);
    }
    return containers;
  }

  async inspect(id: string): Promise<ContainerDetail> {
    assertContainerReference(id);
    await this.ensureAvailable();
    const result = await this.runDocker(['inspect', '--type', 'container', id]);
    if (result.code !== 0) throw this.dockerFailure(result, `检查容器 ${id}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new PanelError('UPSTREAM_ERROR', 'docker inspect 输出不是合法 JSON', {
        output: truncateText(result.stdout, MAX_OUTPUT_DETAIL).text,
      });
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new PanelError('NOT_FOUND', `容器 ${id} 不存在`, { id });
    }
    const record = asRecord(parsed[0]);
    if (!record) {
      throw new PanelError('UPSTREAM_ERROR', 'docker inspect 返回结构异常', { id });
    }
    return mapInspectDetail(record);
  }

  /* ---------------------------- 生命周期 ---------------------------- */

  async start(id: string): Promise<void> {
    assertContainerReference(id);
    await this.ensureAvailable();
    this.ensureResult(await this.runDocker(['start', id]), `启动容器 ${id}`);
  }

  async stop(id: string, timeoutSec?: number): Promise<void> {
    assertContainerReference(id);
    await this.ensureAvailable();
    const args = ['stop'];
    if (timeoutSec !== undefined) args.push('--time', String(timeoutSec));
    args.push(id);
    this.ensureResult(await this.runDocker(args), `停止容器 ${id}`);
  }

  async restart(id: string, timeoutSec?: number): Promise<void> {
    assertContainerReference(id);
    await this.ensureAvailable();
    const args = ['restart'];
    if (timeoutSec !== undefined) args.push('--time', String(timeoutSec));
    args.push(id);
    this.ensureResult(await this.runDocker(args), `重启容器 ${id}`);
  }

  async remove(id: string, opts: { force?: boolean; removeVolumes?: boolean }): Promise<void> {
    assertContainerReference(id);
    await this.ensureAvailable();
    const args = ['rm'];
    if (opts.force === true) args.push('--force');
    if (opts.removeVolumes === true) args.push('--volumes');
    args.push(id);
    this.ensureResult(await this.runDocker(args), `删除容器 ${id}`);
  }

  async pruneContainers(): Promise<{ deleted: number; reclaimedBytes: number }> {
    await this.ensureAvailable();
    const result = this.ensureResult(
      await this.runDocker(['container', 'prune', '--force']),
      '清理已停止容器',
    );
    return parsePruneSummary(result.stdout, 'container');
  }

  /* ------------------------------- 日志 ------------------------------ */

  logs(id: string, opts: ContainerLogsOptions): AsyncIterable<DockerLogEntry> {
    return this.logEntries(id, opts);
  }

  private async *logEntries(
    id: string,
    opts: ContainerLogsOptions,
  ): AsyncGenerator<DockerLogEntry> {
    assertContainerReference(id);
    const signal = opts.signal;
    if (isAborted(signal)) return;
    if (opts.since !== undefined) assertSince(opts.since);
    if (
      opts.tail !== undefined &&
      (!Number.isInteger(opts.tail) || opts.tail < 0 || opts.tail > 10_000)
    ) {
      throw badRequest('tail 参数必须是 0..10000 的整数', { field: 'tail' });
    }
    await this.ensureAvailable();

    const args = ['logs'];
    if (opts.follow === true) args.push('--follow');
    if (opts.timestamps === true) args.push('--timestamps');
    if (opts.tail !== undefined) args.push('--tail', String(opts.tail));
    if (opts.since !== undefined) args.push('--since', opts.since);
    args.push(id);

    let stream: ReturnType<CommandRunner['stream']>;
    try {
      stream = this.runner.stream(this.bin, [...this.globalArgs(), ...args], {
        // CommandRunner 的 timeoutMs 没有“禁用”语义；follow 流用 32 位上限（约 24 天），
        // 避免默认 120s 把长连接日志掐断。
        timeoutMs: opts.follow === true ? FOLLOW_STREAM_TIMEOUT_MS : 120_000,
      });
    } catch (error) {
      throw commandSpawnError(this.bin, error, '读取容器日志');
    }

    const wantStdout = opts.stdout !== false;
    const wantStderr = opts.stderr !== false;
    const queue: DockerLogEntry[] = [];
    let finished = false;
    let cancelled = false;
    let failure: PanelError | undefined;
    let notify: (() => void) | undefined;
    const wake = (): void => {
      const resume = notify;
      notify = undefined;
      resume?.();
    };

    const onAbort = (): void => {
      cancelled = true;
      try {
        stream.kill('SIGTERM');
      } catch {
        // 进程可能已经退出。
      }
      finished = true;
      wake();
    };
    if (isAborted(signal)) {
      onAbort();
    } else {
      signal?.addEventListener('abort', onAbort, { once: true });
    }

    const emit = (line: string, name: StreamName): void => {
      if (name === 'stdout' && !wantStdout) return;
      if (name === 'stderr' && !wantStderr) return;
      let data = line;
      let ts: string | undefined;
      if (opts.timestamps === true) {
        const match = /^(\d{4}-\d{2}-\d{2}T\S+)\s([\s\S]*)$/.exec(line);
        if (match) {
          ts = match[1];
          data = match[2] ?? '';
        }
      }
      queue.push({ stream: name, data, ...(ts ? { ts } : {}) });
      wake();
    };

    const pump = async (source: AsyncIterable<Uint8Array>, name: StreamName): Promise<void> => {
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      try {
        for await (const chunk of source) {
          buffer += decoder.decode(chunk, { stream: true });
          let index = buffer.indexOf('\n');
          while (index >= 0) {
            const line = buffer.slice(0, index).replace(/\r$/, '');
            buffer = buffer.slice(index + 1);
            emit(`${line}\n`, name);
            index = buffer.indexOf('\n');
          }
        }
        buffer += decoder.decode();
        if (buffer.length > 0) emit(buffer, name);
      } catch (error) {
        if (!cancelled) failure ??= commandSpawnError(this.bin, error, '读取容器日志');
      }
    };

    const completion = (async (): Promise<void> => {
      await Promise.all([pump(stream.stdout, 'stdout'), pump(stream.stderr, 'stderr')]);
      let result: CommandResult | undefined;
      try {
        result = await stream.completion;
      } catch (error) {
        if (!cancelled) failure ??= commandSpawnError(this.bin, error, '读取容器日志');
      }
      if (result !== undefined && !cancelled && result.code !== 0) {
        if (result.timedOut) {
          failure ??= new PanelError('UPSTREAM_ERROR', '读取容器日志超时', { timedOut: true });
        } else if (result.code !== null) {
          failure ??= this.dockerFailure(result, `读取容器 ${id} 日志`);
        } else if (result.signal === null) {
          // 未超时、未主动取消、也没有信号：子进程根本没起来。
          failure ??= new PanelError('UPSTREAM_ERROR', 'docker logs 子进程启动失败', {
            stderr: truncateText(result.stderr, MAX_OUTPUT_DETAIL).text,
          });
        }
      }
      finished = true;
      wake();
    })();

    try {
      for (;;) {
        if (failure !== undefined) throw failure;
        const entry = queue.shift();
        if (entry !== undefined) {
          yield entry;
          continue;
        }
        if (finished) return;
        await new Promise<void>((resolveWait) => {
          notify = resolveWait;
        });
      }
    } finally {
      cancelled = true;
      signal?.removeEventListener('abort', onAbort);
      try {
        stream.kill('SIGTERM');
      } catch (error) {
        this.logger.debug('终止 docker logs 子进程失败', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      wake();
      void completion.catch(() => undefined);
    }
  }

  /* ------------------------------- 统计 ------------------------------ */

  async stats(id: string): Promise<ContainerStats> {
    assertContainerReference(id);
    await this.ensureAvailable();
    const result = await this.runDocker(['stats', '--no-stream', '--format', 'json', id], {
      timeoutMs: 30_000,
    });
    if (result.code !== 0) throw this.dockerFailure(result, `读取容器 ${id} 统计`);
    const rows = parseJsonRows(result.stdout);
    const row = rows[0];
    if (!row) {
      throw new PanelError('UPSTREAM_ERROR', `未获取到容器 ${id} 的统计信息`, { id });
    }

    const [memoryUsage, memoryLimit] = splitPair(row.MemUsage);
    const [networkRx, networkTx] = splitPair(row.NetIO);
    const [blockRead, blockWrite] = splitPair(row.BlockIO);
    const memoryUsageBytes = parseSizeBytes(memoryUsage);
    const memoryLimitBytes = parseSizeBytes(memoryLimit);
    const statedMemoryPercent = parsePercent(row.MemPerc);
    const computedMemoryPercent =
      memoryLimitBytes > 0 ? (memoryUsageBytes / memoryLimitBytes) * 100 : 0;
    const pids = Number.parseInt(String(row.PIDs ?? '0'), 10);

    return {
      cpuPercent: parsePercent(row.CPUPerc),
      memoryUsageBytes,
      memoryLimitBytes,
      memoryPercent: statedMemoryPercent > 0 ? statedMemoryPercent : computedMemoryPercent,
      networkRxBytes: parseSizeBytes(networkRx),
      networkTxBytes: parseSizeBytes(networkTx),
      blockReadBytes: parseSizeBytes(blockRead),
      blockWriteBytes: parseSizeBytes(blockWrite),
      pids: Number.isFinite(pids) && pids >= 0 ? pids : 0,
      readAt: new Date().toISOString(),
    };
  }

  /* ------------------------------- exec ------------------------------ */

  async exec(id: string, req: ExecRequest): Promise<ExecResult> {
    assertContainerReference(id);
    assertExecRequest(req);
    await this.ensureAvailable();
    const timeoutMs = req.timeoutMs ?? 30_000;
    const args = ['exec'];
    if (req.workdir !== undefined) args.push('--workdir', req.workdir);
    if (req.user !== undefined) args.push('--user', req.user);
    args.push(id, ...req.command);

    const startedAt = Date.now();
    const result = await this.runDocker(args, {
      timeoutMs,
      maxBufferBytes: MIB,
    });
    if (result.code !== 0) {
      const output = `${result.stderr}\n${result.stdout}`.toLowerCase();
      if (output.includes('no such container') || output.includes('no such object')) {
        throw new PanelError('NOT_FOUND', `容器 ${id} 不存在`, { id });
      }
    }
    return {
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs > 0 ? result.durationMs : Date.now() - startedAt,
      truncated: result.truncated || result.timedOut,
    };
  }

  /* ------------------------------- 镜像 ------------------------------ */

  async listImages(q: { all?: boolean; dangling?: boolean; q?: string }): Promise<ImageSummary[]> {
    await this.ensureAvailable();
    const args = ['images', '--no-trunc', '--format', 'json'];
    if (q.all === true) args.splice(1, 0, '-a');
    if (q.dangling === true) args.push('--filter', 'dangling=true');
    const result = this.ensureResult(await this.runDocker(args), '列出镜像');
    const rows = parseJsonRows(result.stdout);
    if (rows.length === 0 && result.stdout.trim() !== '') {
      this.logger.warn('docker images 输出无法解析为 JSON', {
        sample: truncateText(result.stdout, 400).text,
      });
    }
    const images = groupImageRows(rows);
    const query = q.q?.trim().toLowerCase();
    if (query === undefined || query === '') return images;
    return images.filter(
      (image) =>
        image.id.toLowerCase().includes(query) ||
        image.repoTags.some((tag) => tag.toLowerCase().includes(query)) ||
        image.repoDigests.some((digest) => digest.toLowerCase().includes(query)),
    );
  }

  async pull(ref: string): Promise<ImageSummary> {
    assertImageReference(ref);
    await this.ensureAvailable();
    this.ensureResult(
      await this.runDocker(['pull', ref], {
        timeoutMs: 620_000,
        maxBufferBytes: 16 * MIB,
      }),
      `拉取镜像 ${ref}`,
    );
    return this.inspectImage(ref);
  }

  private async inspectImage(ref: string): Promise<ImageSummary> {
    const result = await this.runDocker(['image', 'inspect', ref], { timeoutMs: 30_000 });
    if (result.code !== 0) throw this.dockerFailure(result, `检查镜像 ${ref}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new PanelError('UPSTREAM_ERROR', 'docker image inspect 输出不是合法 JSON', {
        output: truncateText(result.stdout, MAX_OUTPUT_DETAIL).text,
      });
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new PanelError('NOT_FOUND', `镜像 ${ref} 不存在`, { reference: ref });
    }
    const record = asRecord(parsed[0]);
    if (!record) {
      throw new PanelError('UPSTREAM_ERROR', 'docker image inspect 返回结构异常', {
        reference: ref,
      });
    }
    return mapInspectImage(record);
  }

  async removeImage(id: string, force?: boolean): Promise<void> {
    assertImageReference(id);
    await this.ensureAvailable();
    const args = ['rmi'];
    if (force === true) args.push('--force');
    args.push(id);
    this.ensureResult(await this.runDocker(args), `删除镜像 ${id}`);
  }

  async pruneImages(opts: { danglingOnly?: boolean }): Promise<{
    deleted: number;
    reclaimedBytes: number;
  }> {
    await this.ensureAvailable();
    const args = ['image', 'prune', '--force'];
    if (opts.danglingOnly === false) args.push('--all');
    const result = this.ensureResult(await this.runDocker(args), '清理镜像');
    return parsePruneSummary(result.stdout, 'image');
  }

  /* ------------------------------ Compose ----------------------------- */

  private composeCommand(): { command: string; prefix: string[] } {
    // docker compose 与 docker-compose v1/v2 都接受 --host 全局参数。
    const globals = this.globalArgs();
    if (this.composeBin !== undefined && this.composeBin.trim() !== '') {
      return { command: this.composeBin, prefix: globals };
    }
    return { command: this.bin, prefix: [...globals, 'compose'] };
  }

  private async ensureCompose(): Promise<void> {
    const now = Date.now();
    if (this.composeCache && now - this.composeCache.at < this.probeTtlMs) {
      if (this.composeCache.ok) return;
      throw new PanelError('UNAVAILABLE', this.composeCache.reason ?? 'Docker Compose 不可用', {
        capability: 'docker',
        reason: this.composeCache.reason,
        hint: COMPOSE_UNAVAILABLE_HINT,
      });
    }
    const { command, prefix } = this.composeCommand();
    let ok = false;
    let reason: string | undefined;
    try {
      const result = await this.runCommand(
        command,
        [...prefix, 'version'],
        { timeoutMs: 10_000, maxBufferBytes: MIB },
        '检查 Docker Compose',
      );
      ok = result.code === 0;
      if (!ok) {
        const output = `${result.stderr}\n${result.stdout}`.trim();
        reason = output ? firstOutputLine(output) : 'docker compose version 返回非零退出码';
      }
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    this.composeCache = { at: now, ok, ...(reason ? { reason } : {}) };
    if (!ok) {
      throw new PanelError('UNAVAILABLE', `Docker Compose 不可用${reason ? `: ${reason}` : ''}`, {
        capability: 'docker',
        reason,
        hint: COMPOSE_UNAVAILABLE_HINT,
      });
    }
  }

  private managedComposePath(name: string): string {
    assertStackName(name);
    const directory = resolve(this.stackRoot, name);
    const file = resolve(directory, 'compose.yaml');
    if (!isInside(this.stackRoot, directory) || !isInside(this.stackRoot, file)) {
      throw badRequest('非法的栈目录', { name });
    }
    return file;
  }

  private async requireComposeFile(name: string): Promise<string> {
    const file = this.managedComposePath(name);
    try {
      const info = await stat(file);
      if (!info.isFile()) {
        throw new PanelError('NOT_FOUND', `栈 ${name} 的 compose 文件不存在`, { name });
      }
    } catch (error) {
      if (isPanelError(error)) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new PanelError('NOT_FOUND', `栈 ${name} 的 compose 文件不存在`, { name });
      }
      throw fsFailure(error, `读取栈 ${name} 的 compose 文件`);
    }
    await this.assertRealInside(file);
    return file;
  }

  /** 对已存在的目标做 realpath 复核，防止 stacks 下的符号链接把路径带出允许根。 */
  private async assertRealInside(target: string): Promise<void> {
    let rootReal: string;
    try {
      rootReal = await realpath(this.stackRoot);
    } catch {
      return;
    }
    let real: string;
    try {
      real = await realpath(target);
    } catch {
      return;
    }
    if (real !== rootReal && !isInside(rootReal, real)) {
      throw badRequest('Compose 路径越界（符号链接指向允许根之外）', { path: target });
    }
  }

  private async assertRealDirectory(directory: string): Promise<void> {
    let rootReal: string;
    try {
      rootReal = await realpath(this.stackRoot);
    } catch {
      return;
    }
    let real: string | null;
    try {
      real = await realpath(directory);
    } catch {
      real = null;
    }
    if (real !== null && real !== rootReal && !isInside(rootReal, real)) {
      throw badRequest('栈目录越界（符号链接指向允许根之外）', { path: directory });
    }
  }

  private composeArgs(file: string, name: string, rest: string[]): string[] {
    return ['-f', file, '-p', name, ...rest];
  }

  private composeOutput(result: CommandResult, label: string): { output: string } {
    if (result.code !== 0) throw this.dockerFailure(result, label);
    const pieces = [result.stdout.trim(), result.stderr.trim()].filter((piece) => piece !== '');
    return { output: truncateText(pieces.join('\n'), 65_536).text };
  }

  async composeLs(): Promise<StackSummary[]> {
    const containers = await this.listContainers({ all: true });
    const projects = new Map<
      string,
      {
        counts: Map<string, number>;
        configFiles: Set<string>;
        total: number;
        running: number;
        updatedAt: string | null;
      }
    >();
    for (const container of containers) {
      const labels = container.labels;
      const project = labels['com.docker.compose.project'] ?? container.composeProject ?? '';
      if (project === '') continue;
      if (!STACK_NAME_PATTERN.test(project)) {
        this.logger.warn('忽略名称不符合栈命名规则的 compose 项目', { project });
        continue;
      }
      let entry = projects.get(project);
      if (!entry) {
        entry = {
          counts: new Map<string, number>(),
          configFiles: new Set<string>(),
          total: 0,
          running: 0,
          updatedAt: null,
        };
        projects.set(project, entry);
      }
      entry.total += 1;
      const state = container.state === '' ? 'unknown' : container.state;
      entry.counts.set(state, (entry.counts.get(state) ?? 0) + 1);
      if (state === 'running') entry.running += 1;
      for (const key of [
        'com.docker.compose.project.config_files',
        'com.docker.compose.config_files',
      ]) {
        const raw = labels[key];
        if (raw === undefined || raw.trim() === '') continue;
        for (const file of raw.split(',')) {
          const trimmed = file.trim();
          if (trimmed !== '') entry.configFiles.add(trimmed);
        }
      }
      if (entry.configFiles.size === 0) {
        const workingDir =
          labels['com.docker.compose.project.working_dir'] ??
          labels['com.docker.compose.working_dir'];
        if (workingDir !== undefined && workingDir.trim() !== '') {
          entry.configFiles.add(workingDir.trim());
        }
      }
      if (entry.updatedAt === null || container.created > entry.updatedAt) {
        entry.updatedAt = container.created;
      }
    }

    const order = ['running', 'paused', 'restarting', 'created', 'exited', 'dead', 'removing'];
    const stacks: StackSummary[] = [];
    for (const [name, entry] of projects) {
      const status = order
        .filter((state) => (entry.counts.get(state) ?? 0) > 0)
        .map((state) => `${state}(${entry.counts.get(state) ?? 0})`)
        .concat(
          [...entry.counts.keys()]
            .filter((state) => !order.includes(state))
            .sort()
            .map((state) => `${state}(${entry.counts.get(state) ?? 0})`),
        )
        .join(', ');
      stacks.push({
        name,
        status: status === '' ? 'stopped' : status,
        configFiles: [...entry.configFiles],
        containerCount: entry.total,
        runningCount: entry.running,
        updatedAt: entry.updatedAt,
      });
    }
    stacks.sort((left, right) => left.name.localeCompare(right.name));
    return stacks;
  }

  async composeUp(
    name: string,
    opts: { build?: boolean; forceRecreate?: boolean },
  ): Promise<{ output: string }> {
    assertStackName(name);
    await this.ensureAvailable();
    await this.ensureCompose();
    const file = await this.requireComposeFile(name);
    const rest = ['up', '-d'];
    if (opts.build === true) rest.push('--build');
    if (opts.forceRecreate === true) rest.push('--force-recreate');
    const { command, prefix } = this.composeCommand();
    const result = await this.runCommand(
      command,
      [...prefix, ...this.composeArgs(file, name, rest)],
      { timeoutMs: 620_000, maxBufferBytes: 8 * MIB },
      `启动栈 ${name}`,
    );
    return this.composeOutput(result, `启动栈 ${name}`);
  }

  async composeDown(
    name: string,
    opts: { removeVolumes?: boolean; removeImages?: boolean },
  ): Promise<{ output: string }> {
    assertStackName(name);
    await this.ensureAvailable();
    await this.ensureCompose();
    const file = await this.requireComposeFile(name);
    const rest = ['down'];
    if (opts.removeVolumes === true) rest.push('--volumes');
    if (opts.removeImages === true) rest.push('--rmi', 'all');
    const { command, prefix } = this.composeCommand();
    const result = await this.runCommand(
      command,
      [...prefix, ...this.composeArgs(file, name, rest)],
      { timeoutMs: 300_000, maxBufferBytes: 8 * MIB },
      `停止栈 ${name}`,
    );
    return this.composeOutput(result, `停止栈 ${name}`);
  }

  async composeRestart(name: string): Promise<{ output: string }> {
    assertStackName(name);
    await this.ensureAvailable();
    await this.ensureCompose();
    const file = await this.requireComposeFile(name);
    const { command, prefix } = this.composeCommand();
    const result = await this.runCommand(
      command,
      [...prefix, ...this.composeArgs(file, name, ['restart'])],
      { timeoutMs: 180_000, maxBufferBytes: 8 * MIB },
      `重启栈 ${name}`,
    );
    return this.composeOutput(result, `重启栈 ${name}`);
  }

  async composePull(name: string): Promise<{ output: string }> {
    assertStackName(name);
    await this.ensureAvailable();
    await this.ensureCompose();
    const file = await this.requireComposeFile(name);
    const { command, prefix } = this.composeCommand();
    const result = await this.runCommand(
      command,
      [...prefix, ...this.composeArgs(file, name, ['pull'])],
      { timeoutMs: 620_000, maxBufferBytes: 8 * MIB },
      `拉取栈 ${name} 镜像`,
    );
    return this.composeOutput(result, `拉取栈 ${name} 镜像`);
  }

  async composeConfig(yamlPath: string): Promise<CommandResult> {
    const absolute = resolve(yamlPath);
    if (!isInside(this.stackRoot, absolute)) {
      throw badRequest('Compose 文件路径不在允许的目录内', { path: yamlPath });
    }
    await this.assertRealInside(absolute);
    await this.ensureCompose();
    const { command, prefix } = this.composeCommand();
    return this.runCommand(
      command,
      [...prefix, '-f', absolute, 'config'],
      { timeoutMs: 60_000, maxBufferBytes: 4 * MIB },
      '校验 Compose 文件',
    );
  }

  /* -------------------- 受控 compose 文件访问（stacks） ---------------- */

  composePathFor(name: string): string {
    return this.managedComposePath(name);
  }

  composeDirectory(name: string): string {
    return dirname(this.managedComposePath(name));
  }

  composeFileLimitBytes(): number {
    return MAX_COMPOSE_BYTES;
  }

  async readManagedCompose(name: string): Promise<{ path: string; yaml: string } | null> {
    const file = this.managedComposePath(name);
    try {
      const info = await stat(file);
      if (!info.isFile()) return null;
      if (info.size > MAX_COMPOSE_BYTES) {
        throw badRequest('Compose 文件超过 1 MiB 上限', {
          path: file,
          sizeBytes: info.size,
        });
      }
      await this.assertRealInside(file);
      return { path: file, yaml: await readFile(file, 'utf8') };
    } catch (error) {
      if (isPanelError(error)) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw fsFailure(error, `读取栈 ${name} 的 compose 文件`);
    }
  }

  async writeManagedCompose(name: string, yaml: string): Promise<{ path: string }> {
    const file = this.managedComposePath(name);
    const directory = dirname(file);
    try {
      await mkdir(directory, { recursive: true });
      await this.assertRealDirectory(directory);
      const temporary = join(directory, `.compose-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, yaml, { encoding: 'utf8', mode: 0o600 });
        await rename(temporary, file);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
      return { path: file };
    } catch (error) {
      throw fsFailure(error, `写入栈 ${name} 的 compose 文件`);
    }
  }

  /** 先写临时文件并执行 `docker compose config`，校验通过后才允许落盘。 */
  async validateComposeYaml(name: string, yaml: string): Promise<void> {
    const directory = this.composeDirectory(name);
    const temporary = join(directory, `.validate-${randomUUID()}.yaml`);
    let verified = false;
    try {
      await mkdir(directory, { recursive: true });
      await this.assertRealDirectory(directory);
      await writeFile(temporary, yaml, { encoding: 'utf8', mode: 0o600 });
      const result = await this.composeConfig(temporary);
      if (result.timedOut) {
        throw new PanelError('UPSTREAM_ERROR', 'Compose 文件校验超时', { name });
      }
      if (result.code !== 0) {
        const output = `${result.stderr}\n${result.stdout}`.trim();
        throw badRequest('Compose 文件校验失败', {
          name,
          output: truncateText(output, MAX_OUTPUT_DETAIL).text,
        });
      }
      verified = true;
    } catch (error) {
      throw fsFailure(error, `校验栈 ${name} 的 compose 文件`);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
      if (!verified) {
        // 校验失败时不要留下空的栈目录（rmdir 只删空目录）。
        await rmdir(directory).catch(() => undefined);
      }
    }
  }

  async managedStackDirectories(): Promise<ManagedStackFile[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.stackRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw fsFailure(error, '读取栈目录');
    }
    const stacks: ManagedStackFile[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!STACK_NAME_PATTERN.test(entry.name)) continue;
      const file = join(this.stackRoot, entry.name, 'compose.yaml');
      try {
        const info = await stat(file);
        if (!info.isFile()) continue;
        await this.assertRealInside(file);
        stacks.push({ name: entry.name, path: file, updatedAt: info.mtime.toISOString() });
      } catch {
        continue;
      }
    }
    return stacks;
  }

  async removeStackDirectory(name: string): Promise<void> {
    const directory = this.composeDirectory(name);
    if (!isInside(this.stackRoot, directory)) {
      throw badRequest('非法的栈目录', { name });
    }
    await this.assertRealDirectory(directory);
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      throw fsFailure(error, `删除栈 ${name} 的目录`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 映射与解析                                                          */
/* ------------------------------------------------------------------ */

function mapPsRow(row: Record<string, unknown>): ContainerSummary | null {
  const id = asString(row.ID) ?? asString(row.Id);
  if (id === undefined || id === '') return null;
  const labels = parseLabelsField(row.Labels);
  const created = asString(row.CreatedAt) ?? asString(row.Created) ?? asString(row.CreatedSince);
  const imageId = asString(row.ImageID);
  const command = asString(row.Command);
  return {
    id,
    names: parseNames(row.Names),
    image: asString(row.Image) ?? '',
    ...(imageId !== undefined ? { imageId } : {}),
    ...(command !== undefined ? { command } : {}),
    created: parseDockerDate(created),
    state: asString(row.State) ?? '',
    status: asString(row.Status) ?? asString(row.State) ?? '',
    ports: parsePortBindings(row.Ports),
    labels,
    composeProject: labels['com.docker.compose.project'] ?? null,
    composeService: labels['com.docker.compose.service'] ?? null,
  };
}

function matchesContainerQuery(summary: ContainerSummary, query: string | undefined): boolean {
  if (query === undefined || query === '') return true;
  if (summary.id.toLowerCase().includes(query)) return true;
  if (summary.image.toLowerCase().includes(query)) return true;
  if (summary.names.some((name) => name.toLowerCase().includes(query))) return true;
  if (summary.composeProject?.toLowerCase().includes(query) === true) return true;
  if (summary.composeService?.toLowerCase().includes(query) === true) return true;
  return false;
}

function mapInspectDetail(raw: Record<string, unknown>): ContainerDetail {
  const config = asRecord(raw.Config) ?? {};
  const hostConfig = asRecord(raw.HostConfig) ?? {};
  const state = asRecord(raw.State) ?? {};
  const networkSettings = asRecord(raw.NetworkSettings) ?? {};
  const labels = parseLabelsField(config.Labels);
  const rawName = asString(raw.Name);
  const names = rawName !== undefined ? [rawName.replace(/^\/+/, '')] : [];
  const stateStatus = asString(state.Status) ?? '';
  const healthRecord = asRecord(state.Health);
  const health = healthRecord ? (asString(healthRecord.Status) ?? null) : null;

  const configCmd = Array.isArray(config.Cmd)
    ? config.Cmd.filter((entry): entry is string => typeof entry === 'string').join(' ')
    : undefined;
  const path = asString(raw.Path);
  const rawArgs = Array.isArray(raw.Args)
    ? raw.Args.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const command =
    configCmd !== undefined && configCmd !== ''
      ? configCmd
      : path !== undefined
        ? `${path}${rawArgs.length > 0 ? ` ${rawArgs.join(' ')}` : ''}`
        : undefined;

  const mounts: ContainerMount[] = [];
  if (Array.isArray(raw.Mounts)) {
    for (const entry of raw.Mounts) {
      const record = asRecord(entry);
      if (!record) continue;
      const destination = asString(record.Destination) ?? '';
      if (destination === '') continue;
      const source = asString(record.Source);
      const mode = asString(record.Mode);
      mounts.push({
        type: asString(record.Type) ?? 'bind',
        ...(source !== undefined ? { source } : {}),
        destination,
        ...(mode !== undefined ? { mode } : {}),
        rw: record.RW !== false,
      });
    }
  }

  const env = Array.isArray(config.Env)
    ? config.Env.filter((entry): entry is string => typeof entry === 'string')
    : [];

  const restartPolicyName = asString(asRecord(hostConfig.RestartPolicy)?.Name);
  const restartPolicy =
    restartPolicyName === undefined || restartPolicyName === '' ? 'no' : restartPolicyName;
  const imageId = asString(raw.Image);
  const platform = asString(raw.Platform);
  const networkMode = asString(hostConfig.NetworkMode);

  return {
    id: asString(raw.Id) ?? '',
    names,
    image: asString(config.Image) ?? '',
    ...(imageId !== undefined ? { imageId } : {}),
    ...(command !== undefined ? { command } : {}),
    created: parseDockerDate(raw.Created),
    state: stateStatus,
    status: stateStatus,
    ports: parseInspectPorts(networkSettings.Ports),
    labels,
    composeProject: labels['com.docker.compose.project'] ?? null,
    composeService: labels['com.docker.compose.service'] ?? null,
    env,
    mounts,
    restartPolicy,
    ...(platform !== undefined ? { platform } : {}),
    ...(networkMode !== undefined ? { networkMode } : {}),
    health,
  };
}

function groupImageRows(rows: Record<string, unknown>[]): ImageSummary[] {
  const byId = new Map<
    string,
    {
      repoTags: Set<string>;
      repoDigests: Set<string>;
      sizeBytes: number;
      createdAt: string;
      labels: Record<string, string>;
    }
  >();
  for (const row of rows) {
    const id = asString(row.ID) ?? asString(row.Id);
    if (id === undefined || id === '') continue;
    const repository = asString(row.Repository) ?? '';
    const tag = asString(row.Tag) ?? '';
    const digest = asString(row.Digest) ?? '';
    const labels = parseLabelsField(row.Labels);
    const createdAt = parseDockerDate(row.CreatedAt ?? row.Created);
    const sizeBytes = parseSizeBytes(row.Size ?? row.VirtualSize);

    let entry = byId.get(id);
    if (!entry) {
      entry = {
        repoTags: new Set<string>(),
        repoDigests: new Set<string>(),
        sizeBytes: 0,
        createdAt,
        labels: {},
      };
      byId.set(id, entry);
    }
    if (repository !== '' && repository !== '<none>') {
      if (tag !== '' && tag !== '<none>') entry.repoTags.add(`${repository}:${tag}`);
      else entry.repoTags.add(repository);
    }
    if (digest !== '' && digest !== '<none>') entry.repoDigests.add(digest);
    entry.sizeBytes = Math.max(entry.sizeBytes, sizeBytes);
    if (entry.createdAt === epochIso() || createdAt < entry.createdAt) {
      entry.createdAt = createdAt;
    }
    Object.assign(entry.labels, labels);
  }

  const images: ImageSummary[] = [];
  for (const [id, entry] of byId) {
    images.push({
      id,
      repoTags: [...entry.repoTags],
      repoDigests: [...entry.repoDigests],
      sizeBytes: entry.sizeBytes,
      createdAt: entry.createdAt,
      labels: entry.labels,
      dangling: entry.repoTags.size === 0,
    });
  }
  return images;
}

function mapInspectImage(raw: Record<string, unknown>): ImageSummary {
  const repoTags = Array.isArray(raw.RepoTags)
    ? raw.RepoTags.filter(
        (entry): entry is string =>
          typeof entry === 'string' && entry !== '' && entry !== '<none>:<none>',
      )
    : [];
  const repoDigests = Array.isArray(raw.RepoDigests)
    ? raw.RepoDigests.filter(
        (entry): entry is string => typeof entry === 'string' && entry !== '<none>',
      )
    : [];
  const config = asRecord(raw.Config) ?? {};
  const size = asFiniteNumber(raw.Size);
  return {
    id: asString(raw.Id) ?? '',
    repoTags,
    repoDigests,
    sizeBytes: size !== undefined ? Math.max(0, size) : parseSizeBytes(raw.Size),
    createdAt: parseDockerDate(raw.Created),
    labels: parseLabelsField(config.Labels ?? raw.Labels),
    dangling: repoTags.length === 0,
  };
}

function parsePruneSummary(
  stdout: string,
  kind: 'container' | 'image',
): { deleted: number; reclaimedBytes: number } {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim());
  let deleted = 0;
  for (const line of lines) {
    if (kind === 'image') {
      if (/^deleted:/i.test(line)) deleted += 1;
    } else if (/^[0-9a-f]{12,64}$/i.test(line)) {
      deleted += 1;
    }
  }
  const match = /Total reclaimed space:\s*([0-9.]+\s*[A-Za-z]+)/i.exec(stdout);
  const reclaimedBytes = match ? parseSizeBytes(match[1]) : 0;
  return { deleted, reclaimedBytes };
}

export function assertExecRequest(req: ExecRequest): void {
  const command = req.command;
  if (!Array.isArray(command) || command.length === 0) {
    throw badRequest('exec 命令不能为空', { field: 'command' });
  }
  if (command.length > 64) {
    throw badRequest('exec 命令参数过多（最多 64 个）', { field: 'command' });
  }
  let total = 0;
  for (const part of command) {
    if (typeof part !== 'string' || part.length === 0) {
      throw badRequest('exec 命令参数不能为空字符串', { field: 'command' });
    }
    if (part.length > 4096) {
      throw badRequest('exec 单个参数过长（最多 4096 字符）', { field: 'command' });
    }
    if (CONTROL_CHARS.test(part)) {
      throw badRequest('exec 命令参数包含控制字符', { field: 'command' });
    }
    total += part.length + 1;
  }
  if (total > 65_536) {
    throw badRequest('exec 命令总长度超过 64 KiB', { field: 'command' });
  }
  if (req.timeoutMs !== undefined) {
    if (!Number.isInteger(req.timeoutMs) || req.timeoutMs < 100 || req.timeoutMs > 300_000) {
      throw badRequest('timeoutMs 必须是 100..300000 的整数', { field: 'timeoutMs' });
    }
  }
  if (req.workdir !== undefined) {
    if (
      req.workdir.length === 0 ||
      req.workdir.length > 4096 ||
      CONTROL_CHARS.test(req.workdir)
    ) {
      throw badRequest('workdir 不合法', { field: 'workdir' });
    }
  }
  if (req.user !== undefined) {
    if (!/^[A-Za-z0-9_.-]{1,64}(?::[A-Za-z0-9_.-]{1,64})?$/.test(req.user)) {
      throw badRequest('user 不合法', { field: 'user' });
    }
  }
}

function commandSpawnError(command: string, error: unknown, label: string): PanelError {
  if (isPanelError(error)) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') {
    return new PanelError('UNAVAILABLE', `未找到可执行文件: ${command}`, {
      capability: 'docker',
      reason: `ENOENT: ${command}`,
      hint: DOCKER_UNAVAILABLE_HINT,
    });
  }
  return new PanelError('UPSTREAM_ERROR', `${label}失败`, {
    message: error instanceof Error ? error.message : String(error),
  });
}

/** 文件系统错误统一映射为 UPSTREAM_ERROR，避免把未捕获异常变成 500。 */
function fsFailure(error: unknown, label: string): PanelError {
  if (isPanelError(error)) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return new PanelError('UPSTREAM_ERROR', `${label}失败`, {
    ...(code === undefined ? {} : { code }),
    message: error instanceof Error ? error.message : String(error),
  });
}
