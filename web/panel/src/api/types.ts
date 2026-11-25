/**
 * Hand-written mirror of docs/api-contract.md §15.
 * The web bundle must never import @mpanel/shared; keep this file in sync with
 * the API contract (scripts/check.mjs verifies every `// TypeName` exists here).
 */

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNAVAILABLE'
  | 'UPSTREAM_ERROR'
  | 'INTERNAL';

export type ApiEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: ErrorCode; message: string; details?: unknown } };

export interface PageQuery {
  limit?: number;
  cursor?: string;
}

export interface ListResult<T> {
  available: boolean;
  reason?: string;
  items: T[];
  nextCursor?: string | null;
  total?: number;
}

/* --------------------------------- System -------------------------------- */

export interface CapabilityStatus {
  available: boolean;
  version?: string;
  reason?: string;
  details?: Record<string, unknown>;
}

export interface Capabilities {
  caddy: CapabilityStatus;
  docker: CapabilityStatus;
  postgres: CapabilityStatus;
  redis: CapabilityStatus;
  pty: CapabilityStatus;
}

export interface WorkerDescriptor {
  name: string;
  version: string;
  apiVersion: number;
  protocolVersion: number;
  nodeVersion: string;
  platform: string;
  arch: string;
  capabilities?: Record<string, unknown>;
}

export interface SystemInfo {
  role: 'worker' | 'core';
  name: string;
  version: string;
  apiVersion: 1;
  protocolVersion: 1;
  nodeVersion: string;
  platform: string;
  arch: string;
  hostname: string;
  startedAt: string;
  uptimeSec: number;
  capabilities: Capabilities;
  worker?: WorkerDescriptor;
  features: { dbxHandoff: boolean; websocket: boolean; pty: boolean };
  paths?: {
    home: string;
    caddyConfig?: string;
    caddyData?: string;
    filesRoots?: string[];
    backups?: string;
    stacks?: string;
  };
}

export interface MachineCounts {
  total: number;
  online: number;
  offline: number;
  starting: number;
  degraded: number;
  error: number;
}

export interface SystemOverview {
  core: SystemInfo;
  machines: MachineCounts;
  workers: Machine[];
  generatedAt: string;
}

/** worker `GET /system/snapshot` 返回的节点快照（docs/api-contract.md §5.4）。 */
export interface SystemSnapshot {
  collectedAt: string;
  hostname: string;
  platform: string;
  arch: string;
  release: string;
  nodeVersion: string;
  workerVersion: string;
  uptimeSec: number;
  cpuCount: number;
  /** Windows 为 null。 */
  loadavg: [number, number, number] | null;
  memTotalBytes: number;
  memFreeBytes: number;
  diskTotalBytes: number | null;
  diskFreeBytes: number | null;
  ips: string[];
  transport: string;
  pty: boolean;
}

/** worker `GET /system/metrics` 返回的实时整机指标（docs/api-contract.md §5.5）。 */
export interface SystemMetrics {
  collectedAt: string;
  /** 200ms 采样的整机使用率（0–100）；采样失败为 null。 */
  cpuPercent: number | null;
  cpuCount: number;
  /** Windows 为 null。 */
  loadavg: [number, number, number] | null;
  memTotalBytes: number;
  memFreeBytes: number;
  diskTotalBytes: number | null;
  diskFreeBytes: number | null;
  uptimeSec: number;
}

/* -------------------------------- Machines ------------------------------- */

export type MachineTransport = 'stdio' | 'http' | 'reverse-ws';
export type MachineStatus = 'online' | 'offline' | 'starting' | 'degraded' | 'error';
export type MachineDesiredState = 'running' | 'stopped';

export interface Machine {
  id: string;
  name: string;
  transport: MachineTransport;
  status: MachineStatus;
  enabled: boolean;
  desiredState: MachineDesiredState;
  endpoint: string | null;
  hasToken: boolean;
  worker: WorkerDescriptor | null;
  capabilities: Capabilities | null;
  lastSeenAt: string | null;
  lastError: string | null;
  reconnectAttempts?: number;
  createdAt: string;
  updatedAt: string;
  /** 由 edge key 自助入网（docs/api-contract.md §5.4）。 */
  edge: boolean;
  /** 边缘分组；普通机器也可能有 group。 */
  group: string | null;
  /** 入网来源的 edge key id。 */
  edgeKeyId: string | null;
  /** core 定期刷新的节点快照；从未采集时为 null。 */
  snapshot: SystemSnapshot | null;
}

/* ---------------------------------- Edge --------------------------------- */

export interface EdgeKey {
  id: string;
  name: string;
  group: string | null;
  expiresAt: string | null;
  /** 0 = 不限次数。 */
  maxUses: number;
  uses: number;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export type EdgeJobKind = 'snapshot' | 'run-task' | 'apply-site';
export type EdgeJobStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'canceled';

export interface EdgeJob {
  id: string;
  machineId: string;
  kind: EdgeJobKind;
  payload: Record<string, unknown>;
  status: EdgeJobStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  httpStatus: number | null;
  /** 响应 data 的 JSON，超过 16KB 截断并标记 truncated。 */
  result: unknown;
  error: string | null;
}

/** POST /edge/enroll 的请求体（免登录，凭 key）。 */
export interface EdgeEnrollRequest {
  key: string;
  name?: string;
  platform: string;
  arch: string;
  version: string;
}

/** POST /edge/enroll 的响应：secret 只出现一次。 */
export interface EdgeEnrollResult {
  machine: Machine;
  secret: string;
  wsUrl: string;
}

export interface EdgeKeyCreateInput {
  name: string;
  group?: string;
  /** 有效期（秒）；不传表示不过期。 */
  ttlSec?: number;
  /** 0 或不传表示不限使用次数。 */
  maxUses?: number;
}

export interface EdgeKeyCreateResult {
  key: EdgeKey;
  /** 只在创建响应中出现一次。 */
  secret: string;
}

export interface EdgeJobCreateInput {
  machineId: string;
  kind: EdgeJobKind;
  payload?: Record<string, unknown>;
}

export interface MachineHealth {
  machineId: string;
  status: MachineStatus;
  lastSeenAt: string | null;
  latencyMs?: number | null;
  consecutiveFailures: number;
  lastError?: string | null;
  checkedAt: string;
}

export type MachineCreateInput =
  | { name: string; enabled?: boolean; transport: 'http'; url: string; token: string }
  | {
      name: string;
      enabled?: boolean;
      transport: 'stdio';
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      token: string;
    }
  | { name: string; enabled?: boolean; transport: 'reverse-ws' };

export interface MachineEnrollment {
  machineId: string;
  url: string;
  secret: string;
  workerEnv: Record<string, string>;
}

export interface MachineCreateResult {
  machine: Machine;
  enrollment?: MachineEnrollment;
}

export interface MachineUpdateInput {
  name?: string;
  enabled?: boolean;
  url?: string;
  token?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface MachineTestResult {
  reachable: boolean;
  latencyMs?: number | null;
  info?: SystemInfo | null;
  error?: string;
}

/* ---------------------------------- Sites -------------------------------- */

export type SiteStatus = 'draft' | 'pending' | 'applied' | 'error' | 'disabled';

export interface ReverseProxyHandler {
  type: 'reverse_proxy';
  upstreams: string[];
  loadBalance?: 'round_robin' | 'random' | 'least_conn' | 'uri_hash';
  headers?: Record<string, string>;
  websocket?: boolean;
  tlsSkipVerify?: boolean;
  healthUri?: string;
}

export interface FileServerHandler {
  type: 'file_server';
  root: string;
  indexNames?: string[];
  browse?: boolean;
  spa?: boolean;
  precompressed?: ('gzip' | 'zstd')[];
}

export interface RedirectHandler {
  type: 'redirect';
  to: string;
  permanent?: boolean;
  preserveQuery?: boolean;
}

export type SiteHandler = ReverseProxyHandler | FileServerHandler | RedirectHandler;

export interface SiteConfig {
  domains: string[];
  listen?: string[];
  handler: SiteHandler;
  tls?: { mode: 'auto' | 'internal' | 'off'; email?: string };
  headers?: Record<string, string>;
  encode?: ('gzip' | 'zstd')[];
  log?: boolean;
}

export interface Site {
  id: string;
  name: string;
  enabled: boolean;
  config: SiteConfig;
  revision: number;
  appliedRevision: number | null;
  status: SiteStatus;
  lastApply: {
    at: string;
    ok: boolean;
    revision: number;
    error?: string;
    caddyfileHash?: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface SitePreviewResult {
  caddyfile: string;
  warnings: string[];
  validation: { ok: boolean; output: string } | null;
  validationUnavailableReason?: string;
}

export interface SiteApplyResult {
  revision: number;
  appliedAt: string;
  caddyfilePath: string;
  backupPath: string | null;
  reloaded: boolean;
  rolledBack: boolean;
  sites: { id: string; name: string; status: SiteStatus }[];
  warnings: string[];
  caddyOutput: string;
}

export interface SiteExportBundle {
  version: 1;
  exportedAt: string;
  sites: { name: string; enabled: boolean; config: SiteConfig }[];
}

export interface SiteImportResult {
  imported: number;
  skipped: number;
  errors: { index: number; name?: string; message: string }[];
}

/* ------------------------------ Certificates ----------------------------- */

export type CertificateStatus = 'valid' | 'expiring' | 'expired' | 'unknown';

export interface CertificateInfo {
  id: string;
  domains: string[];
  commonName: string | null;
  issuer: string;
  subject: string;
  notBefore: string;
  notAfter: string;
  daysRemaining: number;
  serialNumber: string;
  fingerprintSha256: string;
  keyType: string | null;
  source: 'local' | 'acme' | 'unknown';
  path: string;
  status: CertificateStatus;
}

/* -------------------------------- Databases ------------------------------ */

export interface DatabaseProfile {
  id: string;
  name: string;
  kind: 'postgres' | 'redis';
  host: string;
  port: number;
  username: string | null;
  database: string | null;
  tls: boolean;
  redisDb: number | null;
  hasPassword: boolean;
  lastCheck: {
    at: string;
    ok: boolean;
    latencyMs: number;
    serverVersion?: string;
    message?: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}

export interface DatabaseProfileCreateInput {
  name: string;
  kind: 'postgres' | 'redis';
  host: string;
  port?: number;
  username?: string;
  password?: string;
  database?: string;
  tls?: boolean;
  redisDb?: number;
}

export interface DatabaseProfileUpdateInput {
  name?: string;
  host?: string;
  port?: number;
  username?: string | null;
  password?: string | null;
  database?: string | null;
  tls?: boolean;
  redisDb?: number | null;
}

export interface DatabaseTestResult {
  ok: boolean;
  latencyMs: number;
  serverVersion?: string;
  message?: string;
}

export interface PostgresStats {
  kind: 'postgres';
  version: string;
  uptimeSec: number;
  connections: { total: number; active: number; idle: number; idleInTransaction: number };
  databaseSizeBytes: number;
  cacheHitRatio: number | null;
  transactionsPerSec?: number | null;
}

export interface RedisStats {
  kind: 'redis';
  version: string;
  uptimeSec: number;
  role: 'master' | 'replica' | 'sentinel' | 'unknown';
  connectedClients: number;
  usedMemoryBytes: number;
  maxMemoryBytes: number | null;
  opsPerSec: number | null;
  keyspace: { db: number; keys: number; expires: number }[];
}

export type DatabaseStats = PostgresStats | RedisStats;

export interface HandoffTicket {
  ticket: string;
  expiresAt: string;
  redeemUrl: string;
  kind: 'postgres' | 'redis';
}

export interface HandoffRedeemRequest {
  ticket: string;
}

export interface HandoffPayload {
  profileId: string;
  name: string;
  kind: 'postgres' | 'redis';
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  database: string | null;
  tls: boolean;
  redisDb: number | null;
  connectionString?: string;
}

export type BackupFormat = 'custom' | 'plain' | 'rdb' | 'logical';

export interface BackupRecord {
  id: string;
  profileId: string;
  kind: 'postgres' | 'redis';
  format: BackupFormat;
  label?: string | null;
  fileName: string;
  sizeBytes: number;
  status: 'running' | 'success' | 'failed';
  createdAt: string;
  finishedAt?: string | null;
  error?: string | null;
}

export interface DatabaseJob {
  id: string;
  profileId: string;
  type: 'backup' | 'restore';
  status: 'queued' | 'running' | 'success' | 'failed';
  backupId?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  progress?: string | null;
  error?: string | null;
}

/* ------------------------------- Containers ------------------------------ */

export interface ContainerPort {
  ip?: string;
  privatePort: number;
  publicPort?: number;
  type: 'tcp' | 'udp' | 'sctp';
}

export interface ContainerSummary {
  id: string;
  names: string[];
  image: string;
  imageId?: string;
  command?: string;
  created: string;
  state: string;
  status: string;
  ports: ContainerPort[];
  labels: Record<string, string>;
  composeProject?: string | null;
  composeService?: string | null;
}

export interface ContainerDetail extends ContainerSummary {
  env: string[];
  mounts: { type: string; source?: string; destination: string; mode?: string; rw: boolean }[];
  restartPolicy?: string;
  platform?: string;
  networkMode?: string;
  health?: string | null;
}

export interface ContainerStats {
  cpuPercent: number;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  memoryPercent: number;
  networkRxBytes: number;
  networkTxBytes: number;
  blockReadBytes: number;
  blockWriteBytes: number;
  pids: number;
  readAt: string;
}

export interface ContainerActionInput {
  timeoutSec?: number;
}

export interface ExecRequest {
  command: string[];
  timeoutMs?: number;
  workdir?: string;
  user?: string;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
}

export interface ImageSummary {
  id: string;
  repoTags: string[];
  repoDigests: string[];
  sizeBytes: number;
  createdAt: string;
  labels: Record<string, string>;
  dangling: boolean;
}

export interface ImagePullRequest {
  reference: string;
}

export interface ImagePruneRequest {
  danglingOnly?: boolean;
}

export interface StackSummary {
  name: string;
  status: string;
  configFiles: string[];
  containerCount: number;
  runningCount: number;
  updatedAt?: string | null;
}

export interface StackDetail extends StackSummary {
  composePath: string;
  composeYaml: string;
  containers: ContainerSummary[];
}

export interface StackCreateInput {
  name: string;
  composeYaml: string;
}

export interface StackUpdateInput {
  composeYaml: string;
}

export interface StackActionInput {
  build?: boolean;
  forceRecreate?: boolean;
  removeVolumes?: boolean;
  removeImages?: boolean;
}

/* ---------------------------------- Files -------------------------------- */

export type FileType = 'file' | 'directory' | 'symlink' | 'other';

export interface FileRoot {
  name: string;
  path: string;
  writable: boolean;
  freeBytes?: number | null;
  totalBytes?: number | null;
}

export interface FileItem {
  name: string;
  root: string;
  path: string;
  type: FileType;
  size: number;
  mtime: string;
  ctime: string;
  mode: string;
  readonly: boolean;
  isSymlink: boolean;
  targetType?: 'file' | 'directory' | 'symlink' | 'other' | null;
}

export interface FileListResult extends ListResult<FileItem> {
  root: string;
  path: string;
}

export interface FileSearchResult extends ListResult<FileItem> {
  query: string;
  truncated: boolean;
}

export interface FileReadResult {
  content: string;
  encoding: 'utf8' | 'base64';
  size: number;
  truncated: boolean;
  mtime: string;
  isBinary: boolean;
}

export interface FileWriteRequest {
  root: string;
  path: string;
  content: string;
  encoding?: 'utf8' | 'base64';
  create?: boolean;
  overwrite?: boolean;
  expectedMtime?: string;
}

export interface FileMkdirRequest {
  root: string;
  path: string;
  recursive?: boolean;
  mode?: string;
}

export interface FileRenameRequest {
  root: string;
  from: string;
  to: string;
  overwrite?: boolean;
}

export interface FileCopyRequest {
  root: string;
  from: string;
  to: string;
  overwrite?: boolean;
}

export interface FileChmodRequest {
  root: string;
  path: string;
  mode: string;
}

export interface FileDeleteQuery {
  root: string;
  path: string;
  permanent?: boolean;
}

export interface FileUploadQuery {
  root: string;
  path: string;
  overwrite?: boolean;
}

export interface FileDownloadQuery {
  root: string;
  path: string;
}

export interface FileSearchQuery {
  root: string;
  path?: string;
  q: string;
  mode?: 'name' | 'content';
  caseSensitive?: boolean;
  includeHidden?: boolean;
  limit?: number;
}

export interface TrashEntry {
  id: string;
  root: string;
  originalPath: string;
  trashedAt: string;
  sizeBytes: number;
  type: FileType;
}

export interface FileArchiveResult {
  path: string;
  format: 'zip' | 'tar' | 'tar.gz';
  sizeBytes: number;
  entries: number;
}

export interface FileExtractResult {
  destination: string;
  entries: number;
}

/* -------------------------------- Terminal ------------------------------- */

export interface TerminalSession {
  id: string;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  pty: boolean;
  status: 'running' | 'exited';
  exitCode: number | null;
  createdAt: string;
  lastActivityAt: string;
}

export interface TerminalCreateInput {
  shell?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
}

export interface ShellInfo {
  path: string;
  name: string;
}

export type TerminalClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ping' };

export type TerminalServerMessage =
  | { type: 'ready'; session: TerminalSession }
  | { type: 'output'; data: string }
  | { type: 'exit'; code: number | null; signal?: string | null }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' };

export interface ContainerLogsQuery {
  follow?: boolean;
  tail?: number;
  since?: string;
  timestamps?: boolean;
  stdout?: boolean;
  stderr?: boolean;
}

export type ContainerLogsClientMessage = { type: 'close' };

export type ContainerLogsServerMessage =
  | { type: 'log'; stream: 'stdout' | 'stderr'; data: string; ts?: string }
  | { type: 'end' }
  | { type: 'error'; code: string; message: string };

/* ---------------------------------- Tasks -------------------------------- */

export type TaskOverlap = 'skip' | 'allow';
export type TaskRunStatus = 'running' | 'success' | 'failed' | 'timeout' | 'skipped';

export interface TaskRunSummary {
  id: string;
  taskId: string;
  status: TaskRunStatus;
  triggeredBy: 'schedule' | 'manual';
  startedAt: string;
  finishedAt?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
}

export interface TaskRun extends TaskRunSummary {
  stdoutTail: string;
  stderrTail: string;
  truncated: boolean;
  logPath?: string | null;
}

export interface Task {
  id: string;
  name: string;
  description: string | null;
  schedule: string;
  timezone: string | null;
  command: string;
  cwd: string | null;
  env: Record<string, string>;
  enabled: boolean;
  timeoutSec: number;
  overlap: TaskOverlap;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
  lastRun: TaskRunSummary | null;
}

export interface TaskCreateInput {
  name: string;
  description?: string;
  schedule: string;
  timezone?: string;
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  enabled?: boolean;
  timeoutSec?: number;
  overlap?: TaskOverlap;
}

export interface TaskUpdateInput {
  name?: string;
  description?: string | null;
  schedule?: string;
  timezone?: string | null;
  command?: string;
  cwd?: string | null;
  env?: Record<string, string>;
  enabled?: boolean;
  timeoutSec?: number;
  overlap?: TaskOverlap;
}

export interface TaskRunNowResult {
  run: TaskRun;
}

export interface TaskNextRunsResult {
  nextRuns: { at: string }[];
}

/* ---------------------------------- Auth --------------------------------- */

export interface AuthUser {
  id: string;
  username: string;
  displayName: string | null;
  role: 'admin' | 'operator';
}

export interface AuthMe {
  authenticated: true;
  role: 'core' | 'worker';
  authType: 'session' | 'token';
  user?: AuthUser;
}

export interface LoginInput {
  username: string;
  password: string;
}

export interface LoginResult {
  user: AuthUser;
  expiresAt: string;
}

export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

export interface WsTicketRequest {
  path: string;
  machineId?: string;
}

export interface WsTicket {
  ticket: string;
  expiresAt: string;
  path: string;
  machineId?: string | null;
}

/* ------------------------------- Connections ----------------------------- */

/** 一条前端可切换的后端连接；`token`/`username` 只在内存中合并，绝不写入连接持久化。 */
export interface BackendConnection {
  id: string;
  name: string;
  kind: 'worker' | 'core';
  baseUrl: string;
  token?: string;
  username?: string;
  createdAt?: string;
}

export interface ConnectionSecret {
  connectionId: string;
  token: string;
  storage: 'session' | 'local';
}

export interface RuntimeConfig {
  appName?: string;
  dbxUrl?: string;
  defaultBackend?: { url: string; kind: 'worker' | 'core'; label?: string };
  backends?: { id?: string; url: string; kind: 'worker' | 'core'; label?: string }[];
  allowUserConnections?: boolean;
  /**
   * 由编译期 VITE_* 与 config.json 合并得到的连接种子。
   * config.json 是公开静态文件，种子里的 token 只可能来自编译期环境变量。
   */
  backendSeeds?: RuntimeBackendSeed[];
}

export interface RuntimeBackendSeed {
  id: string;
  name: string;
  kind: 'worker' | 'core';
  baseUrl: string;
  /** 仅来自 VITE_DEFAULT_BACKEND_TOKEN 等编译期变量。 */
  token?: string;
  username?: string;
}
