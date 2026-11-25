import { Readable } from 'node:stream';
import type { FastifyBaseLogger } from 'fastify';
import {
  isPanelError,
  PanelError,
  systemSnapshotSchema,
  type EdgeJob,
  type Machine,
  type SystemSnapshot,
} from '@mpanel/shared';
import type { MachineHttpRequest, MachineHttpResponse } from '../machines/types.js';
import type { EdgeJobStore, EdgeMachinePort } from './types.js';

/**
 * Core-driven edge job dispatcher and snapshot refresher
 * (docs/api-contract.md §5.4 "语义").
 *
 * - pending jobs are executed serially per machine in `createdAt` order;
 * - offline nodes keep their jobs pending (no retry accounting);
 * - network/5xx failures are retried at most once, business 4xx fail directly;
 * - results are truncated to 16 KiB and marked `{ truncated: true }`;
 * - online edge nodes are snapshotted immediately, then every 5 minutes.
 */

export const EDGE_DISPATCH_INTERVAL_MS = 10_000;
export const EDGE_SNAPSHOT_REFRESH_MS = 5 * 60_000;
const SNAPSHOT_RETRY_MS = 60_000;
const JOB_TIMEOUT_MS = 120_000;
const MAX_RESULT_BYTES = 16 * 1024;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_CHARS = 500;

export interface EdgeDispatcherDeps {
  machines: EdgeMachinePort;
  jobs: EdgeJobStore;
  logger: FastifyBaseLogger;
  dispatchIntervalMs?: number;
  snapshotRefreshMs?: number;
}

export interface EdgeDispatcher {
  start(): void;
  stop(): Promise<void>;
  /** Runs one dispatcher pass (snapshots + pending jobs); exported for diagnostics. */
  runOnce(): Promise<void>;
  refreshSnapshot(machineId: string): Promise<SystemSnapshot | null>;
}

interface EnvelopeLike {
  ok?: unknown;
  data?: unknown;
  error?: { message?: unknown };
}

export function createEdgeDispatcher(deps: EdgeDispatcherDeps): EdgeDispatcher {
  const dispatchIntervalMs = deps.dispatchIntervalMs ?? EDGE_DISPATCH_INTERVAL_MS;
  const snapshotRefreshMs = deps.snapshotRefreshMs ?? EDGE_SNAPSHOT_REFRESH_MS;
  const logger = deps.logger;

  const online = new Set<string>();
  const lastSnapshotOk = new Map<string, number>();
  const lastSnapshotAttempt = new Map<string, number>();
  /** In-memory retry counter per job id (max 1 retry). */
  const retries = new Map<string, number>();

  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let stopping = false;
  let current: Promise<void> | null = null;

  const start = (): void => {
    if (timer !== undefined || stopping) return;
    timer = setInterval(() => {
      void runOnce();
    }, dispatchIntervalMs);
    timer.unref?.();
    void runOnce();
  };

  const stop = async (): Promise<void> => {
    stopping = true;
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
    const active = current;
    if (active !== null) {
      await active.catch(() => undefined);
    }
  };

  const runOnce = async (): Promise<void> => {
    if (running || stopping) return;
    running = true;
    current = (async () => {
      try {
        await refreshDueSnapshots();
      } catch (error) {
        logger.warn({ error: messageOf(error) }, '边缘快照刷新失败');
      }
      try {
        await runPendingJobs();
      } catch (error) {
        logger.warn({ error: messageOf(error) }, '边缘作业调度失败');
      }
    })();
    try {
      await current;
    } finally {
      running = false;
      current = null;
    }
  };

  const refreshDueSnapshots = async (): Promise<void> => {
    const machines = await deps.machines.listAll();
    const now = Date.now();
    for (const machine of machines) {
      if (machine.edge !== true) continue;
      if (machine.status !== 'online') {
        online.delete(machine.id);
        lastSnapshotOk.delete(machine.id);
        lastSnapshotAttempt.delete(machine.id);
        continue;
      }
      const isNewOnline = !online.has(machine.id);
      online.add(machine.id);
      const lastOk = lastSnapshotOk.get(machine.id) ?? 0;
      const lastAttempt = lastSnapshotAttempt.get(machine.id) ?? 0;
      const due = isNewOnline || now - lastOk >= snapshotRefreshMs;
      if (!due || now - lastAttempt < SNAPSHOT_RETRY_MS) continue;
      lastSnapshotAttempt.set(machine.id, now);
      await refreshSnapshot(machine.id);
    }
  };

  const refreshSnapshot = async (machineId: string): Promise<SystemSnapshot | null> => {
    let machine: Machine;
    try {
      machine = await deps.machines.get(machineId);
    } catch {
      return null;
    }
    if (machine.edge !== true || machine.status !== 'online') return null;
    lastSnapshotAttempt.set(machineId, Date.now());
    try {
      const response = await deps.machines.request(machineId, {
        method: 'GET',
        path: '/api/v1/system/snapshot',
        headers: { accept: 'application/json', 'x-mpanel-request-id': snapshotRequestId(machineId) },
        body: null,
        requestId: snapshotRequestId(machineId),
        signal: AbortSignal.timeout(JOB_TIMEOUT_MS),
      });
      const text = (await readBody(response.body, MAX_BODY_BYTES)).toString('utf8');
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`worker 返回 HTTP ${response.status}`);
      }
      const parsed = systemSnapshotSchema.safeParse(extractData(text));
      if (!parsed.success) {
        throw new Error('worker 返回的 snapshot 不符合契约 schema');
      }
      await deps.machines.updateSnapshot(machineId, parsed.data);
      lastSnapshotOk.set(machineId, Date.now());
      return parsed.data;
    } catch (error) {
      // 失败保留上一份快照；lastError 由机器隧道/健康探测维护，这里只记录日志。
      logger.warn({ machineId, error: messageOf(error) }, '边缘节点快照采集失败');
      return null;
    }
  };

  const runPendingJobs = async (): Promise<void> => {
    const jobs = await deps.jobs.list();
    const pending = jobs
      .filter((job) => job.status === 'pending')
      .sort(compareJobs);
    if (pending.length === 0) return;

    const byMachine = new Map<string, EdgeJob[]>();
    for (const job of pending) {
      const list = byMachine.get(job.machineId);
      if (list === undefined) byMachine.set(job.machineId, [job]);
      else list.push(job);
    }

    for (const [machineId, machineJobs] of byMachine) {
      let machine: Machine;
      try {
        machine = await deps.machines.get(machineId);
      } catch {
        await failOrphanJobs(machineJobs, '机器不存在');
        continue;
      }
      if (machine.edge !== true) continue;
      for (const job of machineJobs) {
        if (stopping) return;
        const latest = await deps.jobs.get(job.id);
        if (latest === undefined || latest.status !== 'pending') continue;
        const currentMachine = await safeGetMachine(machineId);
        if (currentMachine === null || currentMachine.edge !== true || currentMachine.status !== 'online') {
          // 离线：本机器剩余作业保持 pending，不计入重试；继续处理其他机器。
          break;
        }
        await executeJob(latest);
      }
    }
  };

  const executeJob = async (job: EdgeJob): Promise<void> => {
    const startedAt = new Date().toISOString();
    await deps.jobs.update(job.id, {
      status: 'running',
      startedAt,
      finishedAt: null,
      httpStatus: null,
      result: null,
      error: null,
    });

    let response: MachineHttpResponse;
    try {
      response = await deps.machines.request(job.machineId, buildJobRequest(job));
    } catch (error) {
      await handleExecutionError(job, error);
      return;
    }

    let text: string;
    try {
      text = (await readBody(response.body, MAX_BODY_BYTES)).toString('utf8');
    } catch (error) {
      await handleExecutionError(job, error);
      return;
    }

    const status = response.status;
    if (status >= 200 && status < 300) {
      const envelope = parseEnvelope(text);
      const data = envelope !== null && envelope.ok === true ? envelope.data : fallbackResult(text);
      const finishedAt = new Date().toISOString();
      await deps.jobs.update(job.id, {
        status: 'succeeded',
        httpStatus: status,
        finishedAt,
        result: truncateResult(data),
        error: null,
      });
      retries.delete(job.id);
      if (job.kind === 'snapshot') {
        const parsed = systemSnapshotSchema.safeParse(data);
        if (parsed.success) {
          await deps.machines.updateSnapshot(job.machineId, parsed.data).catch((error: unknown) => {
            logger.warn(
              { machineId: job.machineId, jobId: job.id, error: messageOf(error) },
              '边缘快照作业写入 machine.snapshot 失败',
            );
          });
          lastSnapshotOk.set(job.machineId, Date.now());
        }
      }
      return;
    }

    if (status >= 400 && status < 500) {
      const envelope = parseEnvelope(text);
      const message =
        envelope !== null && envelope.ok === false && typeof envelope.error?.message === 'string'
          ? envelope.error.message
          : `worker 返回 HTTP ${status}`;
      await deps.jobs.update(job.id, {
        status: 'failed',
        httpStatus: status,
        finishedAt: new Date().toISOString(),
        result: null,
        error: message.slice(0, MAX_ERROR_CHARS),
      });
      retries.delete(job.id);
      return;
    }

    await retryOrFail(job, `worker 返回 HTTP ${status}`, status);
  };

  const handleExecutionError = async (job: EdgeJob, error: unknown): Promise<void> => {
    const message = messageOf(error);
    // 作业映射/参数错误属于业务错误，不重试。
    if (isPanelError(error) && error.code === 'BAD_REQUEST') {
      retries.delete(job.id);
      await deps.jobs.update(job.id, {
        status: 'failed',
        httpStatus: null,
        finishedAt: new Date().toISOString(),
        result: null,
        error: message,
      });
      return;
    }
    // 节点离线/隧道断开：置回 pending，不计入重试次数。
    if (isPanelError(error) && error.code === 'UNAVAILABLE') {
      await revertToPending(job, message);
      return;
    }
    const machine = await safeGetMachine(job.machineId);
    if (machine === null || machine.status !== 'online') {
      await revertToPending(job, message);
      return;
    }
    await retryOrFail(job, message, null);
  };

  const revertToPending = async (job: EdgeJob, message: string): Promise<void> => {
    await deps.jobs
      .update(job.id, {
        status: 'pending',
        startedAt: null,
        finishedAt: null,
        httpStatus: null,
        result: null,
        error: message.slice(0, MAX_ERROR_CHARS),
      })
      .catch(() => undefined);
  };

  const retryOrFail = async (
    job: EdgeJob,
    message: string,
    httpStatus: number | null,
  ): Promise<void> => {
    const attempts = retries.get(job.id) ?? 0;
    if (attempts < 1) {
      retries.set(job.id, attempts + 1);
      await deps.jobs.update(job.id, {
        status: 'pending',
        startedAt: null,
        finishedAt: null,
        httpStatus: null,
        result: null,
        error: message.slice(0, MAX_ERROR_CHARS),
      });
      return;
    }
    retries.delete(job.id);
    await deps.jobs.update(job.id, {
      status: 'failed',
      httpStatus,
      finishedAt: new Date().toISOString(),
      result: null,
      error: message.slice(0, MAX_ERROR_CHARS),
    });
  };

  const failOrphanJobs = async (jobs: EdgeJob[], message: string): Promise<void> => {
    for (const job of jobs) {
      const latest = await deps.jobs.get(job.id).catch(() => undefined);
      if (latest === undefined || latest.status !== 'pending') continue;
      await deps.jobs
        .update(job.id, {
          status: 'failed',
          finishedAt: new Date().toISOString(),
          error: message.slice(0, MAX_ERROR_CHARS),
        })
        .catch(() => undefined);
    }
  };

  const safeGetMachine = async (machineId: string): Promise<Machine | null> => {
    try {
      return await deps.machines.get(machineId);
    } catch {
      return null;
    }
  };

  return { start, stop, runOnce, refreshSnapshot };
}

/* -------------------------------------------------------------------- */
/* Job request mapping                                                   */
/* -------------------------------------------------------------------- */

function buildJobRequest(job: EdgeJob): MachineHttpRequest {
  const requestId = `edge-job-${job.id}`;
  const base = {
    headers: {
      accept: 'application/json',
      'x-mpanel-request-id': requestId,
    } as Record<string, string>,
    requestId,
    signal: AbortSignal.timeout(JOB_TIMEOUT_MS),
  };
  switch (job.kind) {
    case 'snapshot':
      return { ...base, method: 'GET', path: '/api/v1/system/snapshot', body: null };
    case 'run-task': {
      const taskId = requiredPayloadString(job, 'taskId');
      return {
        ...base,
        method: 'POST',
        path: `/api/v1/tasks/${encodeURIComponent(taskId)}/run`,
        body: null,
      };
    }
    case 'apply-site': {
      const siteId = requiredPayloadString(job, 'siteId');
      // worker 只有 POST /sites/apply（docs/api-contract.md §6.2）；§5.4 的
      // “POST /sites/:id/apply” 在 worker 侧不存在，见文档注记。
      const payload = Buffer.from(JSON.stringify({ siteIds: [siteId] }), 'utf8');
      return {
        ...base,
        method: 'POST',
        path: '/api/v1/sites/apply',
        headers: {
          ...base.headers,
          'content-type': 'application/json',
          'content-length': String(payload.length),
        },
        body: Readable.from([payload]),
      };
    }
    default:
      throw new PanelError('BAD_REQUEST', '未知的边缘作业类型', { kind: job.kind });
  }
}

function requiredPayloadString(job: EdgeJob, field: string): string {
  const value = job.payload[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new PanelError('BAD_REQUEST', `边缘作业缺少 payload.${field}`, {
      jobId: job.id,
      field,
    });
  }
  return value;
}

/* -------------------------------------------------------------------- */
/* Helpers                                                              */
/* -------------------------------------------------------------------- */

function compareJobs(left: EdgeJob, right: EdgeJob): number {
  const byCreated = left.createdAt.localeCompare(right.createdAt);
  return byCreated !== 0 ? byCreated : left.id.localeCompare(right.id);
}

function snapshotRequestId(machineId: string): string {
  return `edge-snapshot-${machineId}-${Date.now()}`;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, MAX_ERROR_CHARS);
  return String(error).slice(0, MAX_ERROR_CHARS);
}

function parseEnvelope(text: string): EnvelopeLike | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as EnvelopeLike;
    return typeof record.ok === 'boolean' ? record : null;
  } catch {
    return null;
  }
}

/** Envelope `{ok:true,data}` → data; otherwise the raw JSON (or the text preview). */
function extractData(text: string): unknown {
  const envelope = parseEnvelope(text);
  if (envelope !== null && envelope.ok === true) return envelope.data;
  return fallbackResult(text);
}

function fallbackResult(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text.length > MAX_RESULT_BYTES ? text.slice(0, MAX_RESULT_BYTES) : text;
  }
}

/** JSON result; over 16 KiB it becomes `{ truncated: true, sizeBytes, preview }`. */
export function truncateResult(data: unknown): unknown {
  let text: string;
  try {
    text = JSON.stringify(data);
  } catch {
    return { truncated: true, reason: 'unserializable' };
  }
  if (text === undefined) return null;
  const sizeBytes = Buffer.byteLength(text, 'utf8');
  if (sizeBytes <= MAX_RESULT_BYTES) return data;
  return {
    truncated: true,
    sizeBytes,
    preview: truncateUtf8(text, MAX_RESULT_BYTES - 128),
  };
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let result = '';
  let bytes = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    result += char;
  }
  return result;
}

async function readBody(stream: NodeJS.ReadableStream, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === 'string'
        ? Buffer.from(chunk, 'utf8')
        : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > limit) {
      (stream as { destroy?: (error?: Error) => void }).destroy?.();
      throw new PanelError('UPSTREAM_ERROR', '边缘作业响应体过大', { limitBytes: limit });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}
