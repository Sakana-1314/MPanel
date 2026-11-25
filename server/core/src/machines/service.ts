import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import {
  capabilitiesSchema,
  isPanelError,
  machineCreateSchema,
  machineUpdateSchema,
  PanelError,
  systemInfoSchema,
  type Capabilities,
  type ListResult,
  type Machine,
  type MachineCounts,
  type MachineCreateInput,
  type MachineCreateResult,
  type MachineEnrollment,
  type MachineHealth,
  type MachineStatus,
  type MachineTestResult,
  type MachineTransport,
  type MachineUpdateInput,
  type SecretCipher,
  type SystemInfo,
  type SystemSnapshot,
  type WorkerDescriptor,
  type WsTicket,
} from '@mpanel/shared';
import type { Readable } from 'node:stream';
import type { CoreConfig } from '../config.js';
import type { AuthContext } from '../auth/types.js';
import {
  createCredentialCipher,
  generateMachineSecret,
  generateWorkerToken,
  hashMachineSecret,
} from './credentials.js';
import { createHealthMonitor, type HealthMonitor, type HealthStatusUpdate } from './health.js';
import { createMachineStore, type MachineStore } from './store.js';
import type {
  MachineHttpRequest,
  MachineHttpResponse,
  MachineRecord,
  MachineWsConnection,
  MachineWsOpenRequest,
} from './types.js';
import { createHttpTransportDriver } from '../transports/http.js';
import { createReverseWsTransportDriver, type ReverseWsTransportDriver } from '../transports/reverse-ws.js';
import { createStdioTransportDriver } from '../transports/stdio.js';
import type { TransportDriver, TransportDriverDeps, TransportEvents, TransportLogger } from '../transports/types.js';
import { toTransportLogger } from '../transports/types.js';

export type {
  MachineHttpRequest,
  MachineHttpResponse,
  MachineWsConnection,
  MachineWsOpenRequest,
} from './types.js';

export interface MachineService {
  list(query?: {
    status?: MachineStatus;
    transport?: MachineTransport;
    q?: string;
    limit?: number;
    cursor?: string;
  }): Promise<ListResult<Machine>>;
  /** Overview/aggregation; never paginated. */
  listAll(query?: {
    status?: MachineStatus;
    transport?: MachineTransport;
    q?: string;
  }): Promise<Machine[]>;
  get(id: string): Promise<Machine>;
  create(input: MachineCreateInput): Promise<MachineCreateResult>;
  update(id: string, input: MachineUpdateInput): Promise<Machine>;
  remove(id: string): Promise<void>;
  connect(id: string): Promise<Machine>;
  disconnect(id: string): Promise<Machine>;
  test(id: string): Promise<MachineTestResult>;
  health(id: string): Promise<MachineHealth>;
  rotateSecret(id: string): Promise<{ secret: string; workerEnv: Record<string, string> }>;
  request(id: string, req: MachineHttpRequest): Promise<MachineHttpResponse>;
  openWs(id: string, req: MachineWsOpenRequest): Promise<MachineWsConnection>;
  info(id: string): Promise<SystemInfo>;
  /** Validates /ws/worker machine secret; throws UNAUTHORIZED/FORBIDDEN. */
  authenticateReverseWs(req: import('node:http').IncomingMessage): Promise<Machine>;
  /** Hands an authenticated reverse-ws connection to its driver (hello/heartbeat/frame loop). */
  handleReverseWs(
    machineId: string,
    socket: import('ws').WebSocket,
    req: import('node:http').IncomingMessage,
  ): Promise<void>;
  shutdown(): Promise<void>;
}

/** overview 结果：机器计数 + 每台机器的在线状态与能力快照。 */
export interface MachineOverview {
  machines: MachineCounts;
  workers: Machine[];
  generatedAt: string;
}

/**
 * 便捷扩展（不是网关必须依赖的契约方法）：start/stop 是 connect/disconnect
 * 的别名，transportFor/authorizeMachine/agentSockets 供代理与诊断使用。
 */
export interface MachineServiceExtras {
  probeHealth(id: string): Promise<MachineHealth>;
  start(id: string): Promise<Machine>;
  stop(id: string): Promise<Machine>;
  /** `remove` 的别名，对齐任务使用的 delete 命名。 */
  delete(id: string): Promise<void>;
  overview(): Promise<MachineOverview>;
  transportFor(id: string): Promise<TransportDriver>;
  /**
   * 校验机器存在、启用且处于 running。app.ts 的网关 hook 会以
   * `(machineId, authContext)` 调用它，因此第二个参数同时接受 AuthContext。
   */
  authorizeMachine(
    id: string,
    opts?: { requireOnline?: boolean } | AuthContext,
  ): Promise<Machine>;
  agentSockets(): string[];
  /** docs/api-contract.md §5.4: PATCH /machines/:id { group }. */
  setGroup(id: string, group: string | null): Promise<Machine>;
  /** docs/api-contract.md §5.4: persist the latest node snapshot. */
  updateSnapshot(id: string, snapshot: SystemSnapshot | null): Promise<Machine>;
  /**
   * Edge enrollment entry point (docs/api-contract.md §5.4). Reuses the
   * reverse-ws credential machinery but keeps MachineCreateInput frozen.
   * `secret` is returned exactly once; only its SHA-256 hash is persisted.
   */
  createEdgeMachine(
    input: { name: string; group: string | null; edgeKeyId: string },
    wsUrl?: string,
  ): Promise<{ machine: Machine; secret: string; wsUrl: string }>;
}

export type MachineServiceFull = MachineService & MachineServiceExtras;

export type { WsTicket };

interface RuntimeState {
  status: MachineStatus;
  lastSeenAt: string | null;
  lastError: string | null;
  latencyMs?: number;
  consecutiveFailures: number;
  worker: WorkerDescriptor | null;
  capabilities: Capabilities | null;
  reconnectAttempts: number;
  dirty: boolean;
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const PROBE_TIMEOUT_MS = 10_000;
const RUNTIME_FLUSH_INTERVAL_MS = 30_000;

export async function createMachineService(
  config: CoreConfig,
  logger: FastifyBaseLogger,
): Promise<MachineServiceFull> {
  const service = new MachineServiceImpl(config, logger);
  await service.initialize();
  return service;
}

class MachineServiceImpl implements MachineServiceFull {
  private readonly store: MachineStore;
  private readonly cipher: SecretCipher;
  private readonly drivers: Record<MachineTransport, TransportDriver>;
  private readonly runtime = new Map<string, RuntimeState>();
  private readonly healthMonitor: HealthMonitor;
  private readonly config: CoreConfig;
  private readonly logger: TransportLogger;
  private flushTimer: NodeJS.Timeout | undefined;
  private flushing = false;
  private shutDown = false;

  constructor(config: CoreConfig, logger: FastifyBaseLogger) {
    this.config = config;
    this.logger = toTransportLogger(logger);
    const storeLogger = {
      warn: (message: string, details?: Record<string, unknown>): void => {
        logger.warn(details ?? {}, message);
      },
    };
    this.store = createMachineStore(path.join(config.home, 'state', 'machines.json'), storeLogger);
    this.cipher = createCredentialCipher(config.home, config.secretKey);

    const events: TransportEvents = {
      onStarting: (machineId) => this.applyStatus(machineId, { status: 'starting' }),
      onOnline: (machineId, payload) =>
        this.applyStatus(machineId, {
          status: 'online',
          lastSeenAt: new Date().toISOString(),
          ...(payload.latencyMs === undefined ? {} : { latencyMs: payload.latencyMs }),
        }, payload),
      onOffline: (machineId, error, status) =>
        this.applyStatus(machineId, { status: status ?? 'offline', error }),
    };

    const deps: TransportDriverDeps = {
      config,
      logger,
      events,
      credentials: {
        getToken: async (machine) => this.decryptToken(machine),
        getSecret: async () => {
          throw new PanelError('FORBIDDEN', 'reverse-ws machine secret 只保存哈希，无法读取', {
            hint: '通过 POST /api/v1/machines/:id/secret/rotate 重新下发一次性 secret',
          });
        },
      },
    };

    this.drivers = {
      http: createHttpTransportDriver(deps),
      stdio: createStdioTransportDriver(deps),
      'reverse-ws': createReverseWsTransportDriver(deps),
    };

    const healthSettings = readHealthSettings();
    this.healthMonitor = createHealthMonitor({
      store: this.store,
      machines: this,
      intervalMs: healthSettings.intervalMs,
      maxIntervalMs: healthSettings.maxIntervalMs,
      concurrency: healthSettings.concurrency,
      onStatus: (id, update) => this.applyStatus(id, update),
      logger: storeLogger,
    });
  }

  /** core 启动：恢复机器档案并尝试拉起已启用机器；任何失败都不阻止启动。 */
  async initialize(): Promise<void> {
    let records: MachineRecord[] = [];
    try {
      records = await this.store.list();
    } catch (error) {
      this.logger.error('读取机器档案失败', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    for (const record of records) {
      this.runtime.set(record.id, this.newRuntime(record));
    }
    for (const record of records) {
      if (!record.enabled || record.desiredState !== 'running') continue;
      try {
        const driver = this.drivers[record.transport];
        await driver.start(record);
        if (record.transport === 'http') {
          void this.performProbe(record, PROBE_TIMEOUT_MS);
        }
      } catch (error) {
        // 单台机器失败只记录，绝不阻断 core。
        this.logger.warn('机器启动失败', {
          machineId: record.id,
          transport: record.transport,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const timer = setInterval(() => {
      void this.flushRuntime();
    }, RUNTIME_FLUSH_INTERVAL_MS);
    timer.unref?.();
    this.flushTimer = timer;
    this.healthMonitor.start();
  }

  /* ------------------------------------------------------------------ */
  /* 查询                                                                */
  /* ------------------------------------------------------------------ */

  async list(query: {
    status?: MachineStatus;
    transport?: MachineTransport;
    q?: string;
    limit?: number;
    cursor?: string;
  } = {}): Promise<ListResult<Machine>> {
    const limit = normalizeLimit(query.limit);
    const offset = decodeCursor(query.cursor);
    let records: MachineRecord[];
    try {
      records = await this.store.list();
    } catch (error) {
      return {
        available: false,
        reason: error instanceof Error ? error.message : '机器存储不可读',
        items: [],
        nextCursor: null,
      };
    }
    const machines = this.filterAndSort(records, query);
    const page = machines.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return {
      available: true,
      items: page,
      nextCursor: nextOffset < machines.length ? encodeCursor(nextOffset) : null,
      total: machines.length,
    };
  }

  async listAll(query: {
    status?: MachineStatus;
    transport?: MachineTransport;
    q?: string;
  } = {}): Promise<Machine[]> {
    const records = await this.store.list();
    return this.filterAndSort(records, query);
  }

  async get(id: string): Promise<Machine> {
    const record = await this.requireRecord(id);
    return this.toMachine(record);
  }

  async health(id: string): Promise<MachineHealth> {
    const record = await this.requireRecord(id);
    const state = this.runtime.get(id);
    return {
      machineId: id,
      status: state?.status ?? record.status ?? 'offline',
      lastSeenAt: state?.lastSeenAt ?? record.lastSeenAt ?? null,
      latencyMs: state?.latencyMs ?? null,
      consecutiveFailures: state?.consecutiveFailures ?? 0,
      lastError: state?.lastError ?? record.lastError ?? null,
      checkedAt: new Date().toISOString(),
    };
  }

  /** 触发一次探测并返回最新健康快照。 */
  async probeHealth(id: string): Promise<MachineHealth> {
    const record = await this.requireRecord(id);
    await this.performProbe(record, PROBE_TIMEOUT_MS);
    return this.health(id);
  }

  async overview(): Promise<MachineOverview> {
    const workers = await this.listAll();
    return {
      machines: countStatuses(workers),
      workers,
      generatedAt: new Date().toISOString(),
    };
  }

  async test(id: string): Promise<MachineTestResult> {
    const record = await this.requireRecord(id);
    const outcome = await this.performProbe(record, PROBE_TIMEOUT_MS);
    return {
      reachable: outcome.reachable,
      latencyMs: outcome.latencyMs,
      info: outcome.info,
      ...(outcome.error === undefined ? {} : { error: outcome.error }),
    };
  }

  async info(id: string): Promise<SystemInfo> {
    const record = await this.requireRecord(id);
    const outcome = await this.performProbe(record, PROBE_TIMEOUT_MS);
    if (outcome.info === null) {
      throw new PanelError('UPSTREAM_ERROR', '无法读取 worker 的 system/info', {
        hint: '确认机器在线且 worker 版本与 API v1 兼容',
        machineId: id,
        ...(outcome.error === undefined ? {} : { reason: outcome.error }),
      });
    }
    return outcome.info;
  }

  /* ------------------------------------------------------------------ */
  /* 创建 / 更新 / 删除                                                  */
  /* ------------------------------------------------------------------ */

  async create(input: MachineCreateInput): Promise<MachineCreateResult> {
    const parsed = parseCreateInput(input);
    const now = new Date().toISOString();
    const id = newMachineId();

    let endpoint: string | null = null;
    let tokenCipher: string | null = null;
    let secretHash: string | null = null;
    let command: string | null = null;
    let args: string[] | null = null;
    let env: Record<string, string> | null = null;
    let enrollment: MachineEnrollment | undefined;

    if (parsed.transport === 'http') {
      endpoint = parsed.url.replace(/\/+$/, '');
      tokenCipher = this.cipher.encrypt(parsed.token);
    } else if (parsed.transport === 'stdio') {
      if (!this.config.allowStdio) {
        throw new PanelError('FORBIDDEN', 'core 未启用 stdio 传输', {
          hint: '设置 MPANEL_ALLOW_STDIO=1 并重启 core；stdio 机器等价于在 core 主机执行命令',
        });
      }
      command = parsed.command ?? process.execPath;
      const resolvedArgs =
        parsed.args ??
        (this.config.workerEntry.length > 0 ? [this.config.workerEntry] : undefined);
      if (resolvedArgs === undefined || resolvedArgs.length === 0) {
        throw new PanelError('BAD_REQUEST', 'stdio 机器缺少 worker 入口参数', {
          hint: '设置 MPANEL_WORKER_ENTRY 环境变量，或在创建时提供 args',
        });
      }
      args = [...resolvedArgs];
      env = parsed.env === undefined ? null : { ...parsed.env };
      tokenCipher = this.cipher.encrypt(parsed.token);
    } else {
      const secret = generateMachineSecret();
      const loopbackToken = generateWorkerToken();
      secretHash = hashMachineSecret(secret);
      tokenCipher = this.cipher.encrypt(loopbackToken);
      const coreUrl = coreWsWorkerUrl(this.config);
      endpoint = coreUrl;
      enrollment = {
        machineId: id,
        url: coreUrl,
        secret,
        workerEnv: {
          MPANEL_TRANSPORT: 'reverse-ws',
          MPANEL_CORE_URL: coreUrl,
          MPANEL_MACHINE_ID: id,
          MPANEL_MACHINE_SECRET: secret,
          MPANEL_TOKEN: loopbackToken,
        },
      };
    }

    const enabled = parsed.enabled ?? true;
    const record: MachineRecord = {
      id,
      name: parsed.name,
      transport: parsed.transport,
      enabled,
      desiredState: 'running',
      endpoint,
      tokenCipher,
      secretHash,
      command,
      args,
      env,
      status: enabled ? 'starting' : 'offline',
      lastSeenAt: null,
      lastError: null,
      edge: false,
      group: null,
      edgeKeyId: null,
      snapshot: null,
      createdAt: now,
      updatedAt: now,
    };

    await this.store.create(record);
    this.runtime.set(id, this.newRuntime(record));

    if (enabled) {
      void this.activate(record).catch((error: unknown) => {
        this.logger.warn('机器首次启动失败', {
          machineId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    return {
      machine: this.toMachine(record),
      ...(enrollment === undefined ? {} : { enrollment }),
    };
  }

  async update(id: string, input: MachineUpdateInput): Promise<Machine> {
    const parsed = parseUpdateInput(input);
    const record = await this.requireRecord(id);

    if (parsed.url !== undefined && record.transport !== 'http') {
      throw new PanelError('BAD_REQUEST', '只有 http 机器可以修改 url', {
        hint: '变更传输方式请新建机器',
        machineId: id,
      });
    }
    if (parsed.command !== undefined && record.transport !== 'stdio') {
      throw new PanelError('BAD_REQUEST', '只有 stdio 机器可以修改 command/args/env', {
        machineId: id,
      });
    }
    if ((parsed.args !== undefined || parsed.env !== undefined) && record.transport !== 'stdio') {
      throw new PanelError('BAD_REQUEST', '只有 stdio 机器可以修改 command/args/env', {
        machineId: id,
      });
    }
    if (parsed.token !== undefined && record.transport === 'reverse-ws') {
      throw new PanelError('BAD_REQUEST', 'reverse-ws 机器的 loopback token 不通过 PATCH 修改', {
        hint: '如需重发凭据请使用 POST /api/v1/machines/:id/secret/rotate',
        machineId: id,
      });
    }

    const patch: Partial<MachineRecord> = { updatedAt: new Date().toISOString() };
    if (parsed.name !== undefined) patch.name = parsed.name;
    if (parsed.enabled !== undefined) patch.enabled = parsed.enabled;
    if (parsed.url !== undefined) patch.endpoint = parsed.url.replace(/\/+$/, '');
    if (parsed.token !== undefined) patch.tokenCipher = this.cipher.encrypt(parsed.token);
    if (parsed.command !== undefined) patch.command = parsed.command;
    if (parsed.args !== undefined) patch.args = [...parsed.args];
    if (parsed.env !== undefined) patch.env = { ...parsed.env };
    if (parsed.group !== undefined) patch.group = parsed.group;

    const nextArgs = patch.args ?? record.args;
    if (
      record.transport === 'stdio' &&
      (nextArgs === null || nextArgs.length === 0) &&
      this.config.workerEntry.length === 0
    ) {
      throw new PanelError('BAD_REQUEST', 'stdio 机器缺少 worker 入口参数', {
        hint: '设置 MPANEL_WORKER_ENTRY 或提供 args',
        machineId: id,
      });
    }

    const updated = await this.store.update(id, patch);
    const wasRunning = record.enabled && record.desiredState === 'running';
    const needsRestart =
      parsed.token !== undefined ||
      parsed.url !== undefined ||
      parsed.command !== undefined ||
      parsed.args !== undefined ||
      parsed.env !== undefined;

    if (!updated.enabled) {
      await this.drivers[updated.transport].stop(id);
      this.setStatus(id, 'offline');
    } else if (wasRunning && needsRestart) {
      await this.drivers[updated.transport].stop(id);
      this.setStatus(id, 'starting');
      void this.activate(updated).catch((error: unknown) => {
        this.logger.warn('机器重启失败', {
          machineId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    } else if (updated.enabled && updated.desiredState === 'running' && !wasRunning) {
      void this.activate(updated).catch((error: unknown) => {
        this.logger.warn('机器启动失败', {
          machineId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }

    return this.toMachine(updated);
  }

  async remove(id: string): Promise<void> {
    const record = await this.requireRecord(id);
    try {
      await this.drivers[record.transport].stop(id);
    } catch (error) {
      this.logger.warn('删除机器时停止驱动失败', {
        machineId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await this.store.remove(id);
    this.runtime.delete(id);
  }

  /* ------------------------------------------------------------------ */
  /* 连接控制                                                            */
  /* ------------------------------------------------------------------ */

  async connect(id: string): Promise<Machine> {
    const record = await this.requireRecord(id);
    if (!record.enabled) {
      throw new PanelError('CONFLICT', '机器已禁用，无法连接', {
        hint: '先 PATCH enabled=true，再重试 connect',
        machineId: id,
      });
    }
    const updated =
      record.desiredState === 'running'
        ? record
        : await this.store.update(id, {
            desiredState: 'running',
            updatedAt: new Date().toISOString(),
          });
    const state = this.runtime.get(id);
    if (state !== undefined) {
      state.status = 'starting';
      state.lastError = null;
      state.dirty = true;
    }
    await this.activate(updated);
    return this.toMachine(updated);
  }

  async disconnect(id: string): Promise<Machine> {
    const record = await this.requireRecord(id);
    const updated = await this.store.update(id, {
      desiredState: 'stopped',
      updatedAt: new Date().toISOString(),
    });
    await this.drivers[record.transport].stop(id);
    this.setStatus(id, 'offline');
    return this.toMachine(updated);
  }

  async rotateSecret(id: string): Promise<{ secret: string; workerEnv: Record<string, string> }> {
    const record = await this.requireRecord(id);
    if (record.transport !== 'reverse-ws') {
      throw new PanelError('BAD_REQUEST', '只有 reverse-ws 机器支持 secret 轮换', {
        hint: 'http/stdio 机器请通过 PATCH token 轮换 worker token',
        machineId: id,
      });
    }
    const secret = generateMachineSecret();
    const updated = await this.store.update(id, {
      secretHash: hashMachineSecret(secret),
      updatedAt: new Date().toISOString(),
    });
    await this.drivers['reverse-ws'].stop(id);
    const token = this.decryptToken(updated);
    const coreUrl = coreWsWorkerUrl(this.config);
    try {
      await this.drivers['reverse-ws'].start(updated);
    } catch (error) {
      this.logger.warn('轮换 secret 后重新注册 reverse-ws 失败', {
        machineId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return {
      secret,
      workerEnv: {
        MPANEL_TRANSPORT: 'reverse-ws',
        MPANEL_CORE_URL: coreUrl,
        MPANEL_MACHINE_ID: id,
        MPANEL_MACHINE_SECRET: secret,
        MPANEL_TOKEN: token,
      },
    };
  }

  async start(id: string): Promise<Machine> {
    return this.connect(id);
  }

  async stop(id: string): Promise<Machine> {
    return this.disconnect(id);
  }

  async delete(id: string): Promise<void> {
    return this.remove(id);
  }

  /* ------------------------------------------------------------------ */
  /* 代理 / 传输                                                         */
  /* ------------------------------------------------------------------ */

  async request(id: string, req: MachineHttpRequest): Promise<MachineHttpResponse> {
    const record = await this.requireRunnable(id);
    try {
      const response = await this.drivers[record.transport].request(id, req);
      this.noteRequestOutcome(record, response.status);
      return response;
    } catch (error) {
      this.noteRequestError(id, error);
      throw this.normalizeError(error);
    }
  }

  async openWs(id: string, req: MachineWsOpenRequest): Promise<MachineWsConnection> {
    const record = await this.requireRunnable(id);
    try {
      const connection = await this.drivers[record.transport].openWs(id, req);
      this.noteRequestOutcome(record, 101);
      return connection;
    } catch (error) {
      this.noteRequestError(id, error);
      throw this.normalizeError(error);
    }
  }

  async transportFor(id: string): Promise<TransportDriver> {
    const record = await this.requireRecord(id);
    return this.drivers[record.transport];
  }

  async authorizeMachine(
    id: string,
    optsOrAuth: { requireOnline?: boolean } | AuthContext = {},
  ): Promise<Machine> {
    const opts =
      'requireOnline' in optsOrAuth
        ? optsOrAuth
        : ({} as { requireOnline?: boolean });
    const record = await this.requireRunnable(id);
    const machine = this.toMachine(record);
    if (opts.requireOnline === true && machine.status !== 'online') {
      throw new PanelError('UNAVAILABLE', '机器当前不在线', {
        hint: '等待机器上线（GET /api/v1/machines/:id/health），或 POST connect 重新连接',
        machineId: id,
        machineStatus: machine.status,
      });
    }
    return machine;
  }

  agentSockets(): string[] {
    const driver = this.drivers['reverse-ws'] as ReverseWsTransportDriver;
    return typeof driver.attachedMachineIds === 'function' ? driver.attachedMachineIds() : [];
  }

  /** docs/api-contract.md §5.4: only the group label changes; no reconnect. */
  async setGroup(id: string, group: string | null): Promise<Machine> {
    const updated = await this.store.update(id, {
      group,
      updatedAt: new Date().toISOString(),
    });
    return this.toMachine(updated);
  }

  async updateSnapshot(id: string, snapshot: SystemSnapshot | null): Promise<Machine> {
    const updated = await this.store.update(id, {
      snapshot,
      updatedAt: new Date().toISOString(),
    });
    return this.toMachine(updated);
  }

  async createEdgeMachine(
    input: { name: string; group: string | null; edgeKeyId: string },
    wsUrl?: string,
  ): Promise<{ machine: Machine; secret: string; wsUrl: string }> {
    const now = new Date().toISOString();
    const id = newMachineId();
    const secret = generateMachineSecret();
    const loopbackToken = generateWorkerToken();
    const coreUrl = wsUrl ?? coreWsWorkerUrl(this.config);
    const record: MachineRecord = {
      id,
      name: input.name,
      transport: 'reverse-ws',
      enabled: true,
      desiredState: 'running',
      endpoint: coreUrl,
      tokenCipher: this.cipher.encrypt(loopbackToken),
      secretHash: hashMachineSecret(secret),
      command: null,
      args: null,
      env: null,
      status: 'starting',
      lastSeenAt: null,
      lastError: null,
      edge: true,
      group: input.group,
      edgeKeyId: input.edgeKeyId,
      snapshot: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.create(record);
    this.runtime.set(id, this.newRuntime(record));
    void this.activate(record).catch((error: unknown) => {
      this.logger.warn('边缘机器首次启动失败', {
        machineId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return { machine: this.toMachine(record), secret, wsUrl: coreUrl };
  }

  /* ------------------------------------------------------------------ */
  /* reverse-ws 注册                                                     */
  /* ------------------------------------------------------------------ */

  async authenticateReverseWs(req: import('node:http').IncomingMessage): Promise<Machine> {
    let secret = extractBearer(req.headers.authorization);
    let queryMachineId: string | undefined;
    if (secret === undefined && this.config.allowWsQuerySecret) {
      const query = parseQuery(req.url ?? '');
      const candidate = query.get('secret') ?? undefined;
      if (candidate !== undefined && candidate.length > 0) {
        secret = candidate;
        queryMachineId = query.get('machineId') ?? undefined;
      }
    }
    if (secret === undefined) {
      throw new PanelError('UNAUTHORIZED', '缺少机器注册凭据', {
        hint: 'GET /ws/worker 必须携带 Authorization: Bearer <machine secret>',
      });
    }
    const record = await this.store.findBySecretHash(hashMachineSecret(secret));
    if (record === undefined) {
      throw new PanelError('UNAUTHORIZED', '机器 secret 无效', {
        hint: 'secret 已在创建或轮换时一次性下发；如已遗失请轮换',
      });
    }
    if (record.transport !== 'reverse-ws') {
      throw new PanelError('FORBIDDEN', '该机器不是 reverse-ws 传输');
    }
    if (queryMachineId !== undefined && queryMachineId !== record.id) {
      throw new PanelError('FORBIDDEN', 'secret 与 machineId 不匹配');
    }
    if (!record.enabled) {
      throw new PanelError('FORBIDDEN', '机器已禁用', { machineId: record.id });
    }
    if (record.desiredState !== 'running') {
      throw new PanelError('FORBIDDEN', '机器已被断开，拒绝重连', {
        hint: '在面板中 POST /api/v1/machines/:id/connect 后 worker 才能重新注册',
        machineId: record.id,
      });
    }
    return this.toMachine(record);
  }

  async handleReverseWs(
    machineId: string,
    socket: import('ws').WebSocket,
    req: import('node:http').IncomingMessage,
  ): Promise<void> {
    const record = await this.requireRecord(machineId);
    if (record.transport !== 'reverse-ws') {
      throw new PanelError('FORBIDDEN', '该机器不是 reverse-ws 传输', { machineId });
    }
    const driver = this.drivers['reverse-ws'];
    await driver.start(record);
    if (typeof driver.attach !== 'function') {
      throw new PanelError('INTERNAL', 'reverse-ws 驱动未实现 attach', { machineId });
    }
    await driver.attach(machineId, socket, req);
  }

  async shutdown(): Promise<void> {
    this.shutDown = true;
    this.healthMonitor.stop();
    if (this.flushTimer !== undefined) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
    let records: MachineRecord[] = [];
    try {
      records = await this.store.list();
    } catch {
      records = [];
    }
    for (const record of records) {
      try {
        await this.drivers[record.transport].stop(record.id);
      } catch (error) {
        this.logger.warn('关闭机器驱动失败', {
          machineId: record.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await this.flushRuntime();
    this.runtime.clear();
  }

  /* ------------------------------------------------------------------ */
  /* 内部实现                                                            */
  /* ------------------------------------------------------------------ */

  private async activate(record: MachineRecord): Promise<void> {
    const driver = this.drivers[record.transport];
    await driver.start(record);
    if (record.transport === 'http') {
      await this.performProbe(record, PROBE_TIMEOUT_MS);
    }
  }

  private async performProbe(
    record: MachineRecord,
    timeoutMs: number,
  ): Promise<{
    reachable: boolean;
    latencyMs: number | null;
    info: SystemInfo | null;
    error?: string;
  }> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await this.drivers[record.transport].request(record.id, {
        method: 'GET',
        path: '/api/v1/system/info',
        headers: { accept: 'application/json' },
        body: null,
        requestId: `probe-${record.id}-${Date.now()}`,
        signal: controller.signal,
      });
      const body = await readLimited(response.body, 2 * 1024 * 1024);
      const latencyMs = Date.now() - startedAt;
      if (response.status === 401 || response.status === 403) {
        const message = `worker 拒绝了机器令牌（HTTP ${response.status}）`;
        this.applyProbeFailure(record.id, message, 'error');
        return { reachable: false, latencyMs, info: null, error: message };
      }
      if (response.status < 200 || response.status >= 300) {
        const message = `worker 返回 HTTP ${response.status}`;
        this.applyProbeFailure(record.id, message);
        return { reachable: false, latencyMs, info: null, error: message };
      }
      const info = parseSystemInfo(body);
      if (info === null) {
        const message = 'worker 返回的 system/info 无法解析';
        this.applyProbeFailure(record.id, message);
        return { reachable: false, latencyMs, info: null, error: message };
      }
      this.applyProbeSuccess(record.id, info, latencyMs);
      return { reachable: true, latencyMs, info };
    } catch (error) {
      const message = isPanelError(error)
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
      this.applyProbeFailure(record.id, message);
      return { reachable: false, latencyMs: null, info: null, error: message };
    } finally {
      clearTimeout(timer);
    }
  }

  private applyProbeSuccess(machineId: string, info: SystemInfo, latencyMs: number): void {
    const state = this.runtime.get(machineId);
    if (state === undefined) return;
    state.status = 'online';
    state.lastSeenAt = new Date().toISOString();
    state.latencyMs = latencyMs;
    state.lastError = null;
    state.consecutiveFailures = 0;
    state.worker = info.worker ?? null;
    const parsed = capabilitiesSchema.safeParse(info.capabilities);
    state.capabilities = parsed.success ? parsed.data : null;
    state.reconnectAttempts = 0;
    state.dirty = true;
  }

  private applyProbeFailure(
    machineId: string,
    message: string,
    statusOverride?: MachineStatus,
  ): void {
    const state = this.runtime.get(machineId);
    if (state === undefined) return;
    state.consecutiveFailures += 1;
    state.lastError = message.slice(0, 500);
    state.status =
      statusOverride ??
      (state.status === 'error'
        ? 'error'
        : state.consecutiveFailures >= 3
          ? 'offline'
          : 'degraded');
    state.dirty = true;
  }

  private applyStatus(
    machineId: string,
    update: HealthStatusUpdate,
    payload?: { worker?: WorkerDescriptor; capabilities?: Capabilities | null; latencyMs?: number },
  ): void {
    if (this.shutDown) return;
    const state = this.runtime.get(machineId);
    if (state === undefined) return;
    if (update.status === 'online') {
      state.status = 'online';
      state.lastSeenAt = update.lastSeenAt ?? new Date().toISOString();
      if (update.latencyMs !== undefined) state.latencyMs = update.latencyMs;
      if (payload?.latencyMs !== undefined) state.latencyMs = payload.latencyMs;
      if (payload?.worker !== undefined) state.worker = payload.worker;
      if (payload?.capabilities !== undefined) state.capabilities = payload.capabilities;
      state.lastError = null;
      state.consecutiveFailures = 0;
      state.reconnectAttempts = 0;
    } else if (state.status === 'error' && update.status !== 'error') {
      // 鉴权/协议错误保持 error，直到一次成功探测清除。
      if (update.error !== undefined) state.lastError = update.error;
    } else {
      state.status = update.status;
      if (update.error !== undefined) state.lastError = update.error;
    }
    state.dirty = true;
  }

  private setStatus(machineId: string, status: MachineStatus): void {
    const state = this.runtime.get(machineId);
    if (state === undefined) return;
    state.status = status;
    state.dirty = true;
  }

  private noteRequestOutcome(record: MachineRecord, status: number): void {
    const state = this.runtime.get(record.id);
    if (state === undefined) return;
    if (status === 401 || status === 403) {
      state.status = 'error';
      state.lastError = `worker 拒绝了机器令牌（HTTP ${status}）`;
      state.consecutiveFailures += 1;
      state.dirty = true;
      return;
    }
    if (status >= 500) {
      state.consecutiveFailures += 1;
      if (state.status !== 'error') {
        state.status = state.consecutiveFailures >= 3 ? 'offline' : 'degraded';
      }
      state.dirty = true;
      return;
    }
    state.status = 'online';
    state.lastSeenAt = new Date().toISOString();
    state.consecutiveFailures = 0;
    state.lastError = null;
    state.dirty = true;
  }

  private noteRequestError(machineId: string, error: unknown): void {
    const state = this.runtime.get(machineId);
    if (state === undefined) return;
    if (isPanelError(error) && error.code === 'UNAVAILABLE') {
      if (state.status !== 'error') state.status = 'offline';
      state.lastError = error.message;
      state.dirty = true;
      return;
    }
    state.consecutiveFailures += 1;
    if (state.status !== 'error') {
      state.status = state.consecutiveFailures >= 3 ? 'offline' : 'degraded';
    }
    state.lastError = error instanceof Error ? error.message : String(error);
    state.dirty = true;
  }

  private normalizeError(error: unknown): Error {
    if (isPanelError(error)) return error;
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        return new PanelError('UPSTREAM_ERROR', '代理请求已取消或超时');
      }
      return new PanelError('UPSTREAM_ERROR', '转发到 worker 失败', {
        reason: error.message.slice(0, 300),
      });
    }
    return new PanelError('UPSTREAM_ERROR', '转发到 worker 失败', {
      reason: String(error).slice(0, 300),
    });
  }

  private filterAndSort(
    records: MachineRecord[],
    query: { status?: MachineStatus; transport?: MachineTransport; q?: string },
  ): Machine[] {
    const keyword = query.q === undefined ? undefined : query.q.trim().toLowerCase();
    const machines = records.map((record) => this.toMachine(record));
    return machines
      .filter((machine) => {
        if (query.status !== undefined && machine.status !== query.status) return false;
        if (query.transport !== undefined && machine.transport !== query.transport) return false;
        if (keyword !== undefined && keyword.length > 0) {
          return (
            machine.name.toLowerCase().includes(keyword) ||
            machine.id.toLowerCase().includes(keyword)
          );
        }
        return true;
      })
      .sort((left, right) => {
        const byCreated = left.createdAt.localeCompare(right.createdAt);
        return byCreated !== 0 ? byCreated : left.id.localeCompare(right.id);
      });
  }

  private toMachine(record: MachineRecord): Machine {
    const state = this.runtime.get(record.id);
    const machine: Machine = {
      id: record.id,
      name: record.name,
      transport: record.transport,
      status: state?.status ?? record.status ?? 'offline',
      enabled: record.enabled,
      desiredState: record.desiredState,
      endpoint: record.transport === 'stdio' ? null : record.endpoint,
      hasToken: record.tokenCipher !== null || record.secretHash !== null,
      worker: state?.worker ?? record.worker ?? null,
      capabilities: state?.capabilities ?? record.capabilities ?? null,
      lastSeenAt: state?.lastSeenAt ?? record.lastSeenAt ?? null,
      lastError: state?.lastError ?? record.lastError ?? null,
      reconnectAttempts: state?.reconnectAttempts ?? 0,
      edge: record.edge ?? false,
      group: record.group ?? null,
      edgeKeyId: record.edgeKeyId ?? null,
      snapshot: record.snapshot ?? null,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
    return machine;
  }

  private async requireRecord(id: string): Promise<MachineRecord> {
    const record = await this.store.get(id);
    if (record === undefined) {
      throw new PanelError('NOT_FOUND', '机器不存在', { machineId: id });
    }
    return record;
  }

  private async requireRunnable(id: string): Promise<MachineRecord> {
    const record = await this.requireRecord(id);
    const state = this.runtime.get(id);
    if (!record.enabled) {
      throw new PanelError('UNAVAILABLE', '机器已禁用', {
        hint: '在机器设置中启用该机器后重试',
        machineId: id,
        machineStatus: state?.status ?? 'offline',
      });
    }
    if (record.desiredState !== 'running') {
      throw new PanelError('UNAVAILABLE', '机器已断开', {
        hint: 'POST /api/v1/machines/:id/connect 重新连接后重试',
        machineId: id,
        machineStatus: state?.status ?? 'offline',
      });
    }
    // 已知离线（心跳/健康探测判定）时直接 503，避免 http 驱动反复等待连接超时。
    // error 状态仍允许请求，以便 worker 凭据错误被代理层统一转为 UPSTREAM_ERROR。
    if (state?.status === 'offline') {
      throw new PanelError('UNAVAILABLE', '机器当前不在线', {
        hint: '等待机器恢复（GET /api/v1/machines/:id/health），或 POST connect 重新连接',
        machineId: id,
        machineStatus: state.status,
      });
    }
    return record;
  }

  private decryptToken(machine: MachineRecord): string {
    if (machine.tokenCipher === null) {
      throw new PanelError('FORBIDDEN', '机器缺少 worker token', {
        hint: '通过 PATCH /api/v1/machines/:id 设置 token',
        machineId: machine.id,
      });
    }
    return this.cipher.decrypt(machine.tokenCipher);
  }

  private newRuntime(record: MachineRecord): RuntimeState {
    const active = record.enabled && record.desiredState === 'running';
    return {
      status: active ? 'starting' : 'offline',
      lastSeenAt: record.lastSeenAt,
      lastError: record.lastError,
      ...(record.lastLatencyMs === undefined ? {} : { latencyMs: record.lastLatencyMs }),
      consecutiveFailures: 0,
      worker: record.worker ?? null,
      capabilities: record.capabilities ?? null,
      reconnectAttempts: 0,
      dirty: false,
    };
  }

  private async flushRuntime(): Promise<void> {
    if (this.flushing || this.runtime.size === 0) return;
    const updates = new Map<string, Partial<MachineRecord>>();
    for (const [id, state] of this.runtime) {
      if (!state.dirty) continue;
      updates.set(id, {
        status: state.status,
        lastSeenAt: state.lastSeenAt,
        lastError: state.lastError,
        ...(state.latencyMs === undefined ? {} : { lastLatencyMs: state.latencyMs }),
        worker: state.worker,
        capabilities: state.capabilities,
      });
    }
    if (updates.size === 0) return;
    this.flushing = true;
    try {
      // 档案数量很小（每台机器一次原子写），顺序写避免并发 rename 竞争。
      for (const [id, patch] of updates) {
        try {
          await this.store.update(id, patch);
        } catch (error) {
          if (isPanelError(error) && error.code === 'NOT_FOUND') {
            // 机器在 flush 期间被删除：丢弃该条脏状态。
            const removed = this.runtime.get(id);
            if (removed !== undefined) removed.dirty = false;
            continue;
          }
          throw error;
        }
        const state = this.runtime.get(id);
        if (state !== undefined) state.dirty = false;
      }
    } catch (error) {
      this.logger.warn('机器健康状态落盘失败', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.flushing = false;
    }
  }
}

/* -------------------------------------------------------------------- */
/* 工具                                                                 */
/* -------------------------------------------------------------------- */

export interface CoreWsUrlConfig {
  publicUrl?: string;
  port: number;
}

/**
 * 推导 reverse-ws 注册地址：优先 `MPANEL_PUBLIC_URL`，否则使用请求来源或
 * 本机默认端口；路径统一以 `/ws/worker` 结尾，http(s) 自动转 ws(s)。
 */
export function coreWsWorkerUrl(config: CoreWsUrlConfig, origin?: string): string {
  const fallbackPort = config.port > 0 ? config.port : 8790;
  const raw = config.publicUrl ?? origin ?? `http://127.0.0.1:${fallbackPort}`;
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:') url.protocol = 'wss:';
    else if (url.protocol === 'http:') url.protocol = 'ws:';
    let pathname = url.pathname.replace(/\/+$/, '');
    if (!pathname.endsWith('/ws/worker')) pathname = `${pathname}/ws/worker`;
    url.pathname = pathname;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return raw;
  }
}

function newMachineId(): string {
  return `m_${randomBytes(9).toString('base64url')}`;
}

function normalizeLimit(limit?: number): number {
  if (limit === undefined) return DEFAULT_LIST_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new PanelError('BAD_REQUEST', 'limit 必须是 1 到 200 之间的整数', { limit });
  }
  return limit;
}

function encodeCursor(offset: number): string {
  return Buffer.from(`o:${offset}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor?: string): number {
  if (cursor === undefined || cursor.length === 0) return 0;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!text.startsWith('o:')) throw new Error('bad prefix');
    const value = Number(text.slice(2));
    if (!Number.isInteger(value) || value < 0) throw new Error('bad offset');
    return value;
  } catch {
    throw new PanelError('BAD_REQUEST', '分页游标无效', {
      hint: '使用上一页返回的 nextCursor 原样回传',
    });
  }
}

function countStatuses(machines: Machine[]): MachineCounts {
  const counts: MachineCounts = {
    total: machines.length,
    online: 0,
    offline: 0,
    starting: 0,
    degraded: 0,
    error: 0,
  };
  for (const machine of machines) {
    counts[machine.status] += 1;
  }
  return counts;
}

async function readLimited(stream: Readable, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > limit) {
      stream.destroy();
      throw new PanelError('UPSTREAM_ERROR', 'worker 响应体过大');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseSystemInfo(payload: Buffer): SystemInfo | null {
  try {
    const json = JSON.parse(payload.toString('utf8')) as unknown;
    if (typeof json !== 'object' || json === null) return null;
    const envelope = json as { ok?: unknown; data?: unknown };
    const candidate = envelope.ok === true ? envelope.data : json;
    const parsed = systemInfoSchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

type ParsedMachineCreate =
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

type ParsedMachineUpdate = {
  name?: string;
  enabled?: boolean;
  url?: string;
  token?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  group?: string | null;
};

function parseCreateInput(input: MachineCreateInput): ParsedMachineCreate {
  const result = machineCreateSchema.safeParse(input);
  if (!result.success) {
    throw new PanelError('BAD_REQUEST', '机器参数无效', {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    });
  }
  return result.data;
}

function parseUpdateInput(input: MachineUpdateInput): ParsedMachineUpdate {
  const result = machineUpdateSchema.safeParse(input);
  if (!result.success) {
    throw new PanelError('BAD_REQUEST', '机器参数无效', {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    });
  }
  return result.data;
}

function extractBearer(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1]?.trim();
}

function parseQuery(rawUrl: string): URLSearchParams {
  const index = rawUrl.indexOf('?');
  return new URLSearchParams(index >= 0 ? rawUrl.slice(index + 1) : '');
}

function readHealthSettings(): { intervalMs: number; maxIntervalMs: number; concurrency: number } {
  const intervalMs = readInt('MPANEL_MACHINE_HEALTH_INTERVAL_MS', 15_000, 1_000, 300_000);
  const maxIntervalMs = readInt('MPANEL_MACHINE_HEALTH_MAX_INTERVAL_MS', 60_000, intervalMs, 900_000);
  const concurrency = readInt('MPANEL_MACHINE_HEALTH_CONCURRENCY', 4, 1, 32);
  return { intervalMs, maxIntervalMs, concurrency };
}

function readInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return fallback;
  return value;
}
