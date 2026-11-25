import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import {
  edgeEnrollRequestSchema,
  edgeJobCreateSchema,
  edgeJobSchema,
  edgeJobStatusSchema,
  edgeKeyCreateSchema,
  PanelError,
  type EdgeEnrollRequest,
  type EdgeEnrollResult,
  type EdgeJob,
  type EdgeJobCreateInput,
  type EdgeJobStatus,
  type EdgeKey,
  type EdgeKeyCreateInput,
  type EdgeKeyCreateResult,
  type ListResult,
  type PageQuery,
  type SystemSnapshot,
} from '@mpanel/shared';
import type { CoreConfig } from '../config.js';
import type { AuditLog } from '../audit.js';
import { createRateLimiter } from '../auth/rate-limit.js';
import { newId } from '../store.js';
import { coreWsWorkerUrl } from '../machines/service.js';
import { hashMachineSecret } from '../machines/credentials.js';
import { createEdgeDispatcher, type EdgeDispatcher } from './dispatcher.js';
import { createEdgeJobStore, createEdgeKeyStore } from './store.js';
import type {
  EdgeAuditDetails,
  EdgeEnrollContext,
  EdgeJobStore,
  EdgeKeyRecord,
  EdgeKeyStore,
  EdgeMachinePort,
} from './types.js';

/** docs/api-contract.md §5.4 端点语义（仅 core）。 */
export interface EdgeService {
  createKey(input: EdgeKeyCreateInput): Promise<EdgeKeyCreateResult>;
  listKeys(query?: PageQuery): Promise<ListResult<EdgeKey>>;
  revokeKey(id: string): Promise<void>;
  /**
   * Validates the enrollment secret, creates the reverse-ws machine and
   * consumes one key use. The plaintext machine secret is returned once.
   */
  resolveEnrollment(input: EdgeEnrollRequest, context?: EdgeEnrollContext): Promise<EdgeEnrollResult>;
  /** Appends the `edge.enroll` audit entry (never throws). */
  recordEnroll(details: EdgeAuditDetails, result?: 'ok' | 'error', error?: unknown): Promise<void>;
  listJobs(query: {
    machineId?: string;
    status?: EdgeJobStatus;
    limit?: number;
    cursor?: string;
  }): Promise<ListResult<EdgeJob>>;
  createJob(input: EdgeJobCreateInput): Promise<EdgeJob>;
  getJob(id: string): Promise<EdgeJob>;
  deleteJob(id: string): Promise<void>;
  startDispatcher(): void;
  stopDispatcher(): Promise<void>;
  refreshSnapshot(machineId: string): Promise<SystemSnapshot | null>;
}

export interface EdgeServiceDeps {
  config: CoreConfig;
  machines: EdgeMachinePort;
  audit: AuditLog;
  logger: FastifyBaseLogger;
  /** Enrollment rate limit, default 10/min/IP (docs/api-contract.md §5.4). */
  enrollRateLimit?: { windowSec: number; max: number };
}

const DEFAULT_ENROLL_RATE_LIMIT = { windowSec: 60, max: 10 };
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

export function createEdgeService(deps: EdgeServiceDeps): EdgeService {
  const logger = deps.logger;
  const keys: EdgeKeyStore = createEdgeKeyStore(
    path.join(deps.config.home, 'state', 'edge-keys.json'),
  );
  const jobs: EdgeJobStore = createEdgeJobStore(
    path.join(deps.config.home, 'state', 'edge-jobs.json'),
  );
  const enrollLimiter = createRateLimiter(deps.enrollRateLimit ?? DEFAULT_ENROLL_RATE_LIMIT);
  const dispatcher: EdgeDispatcher = createEdgeDispatcher({
    machines: deps.machines,
    jobs,
    logger,
  });

  /** Serializes enrollment so maxUses accounting cannot race within core. */
  let enrollQueue: Promise<unknown> = Promise.resolve();
  const enqueueEnroll = <T>(task: () => Promise<T>): Promise<T> => {
    const run = enrollQueue.then(task, task);
    enrollQueue = run.catch(() => undefined);
    return run;
  };

  const createKey = async (input: EdgeKeyCreateInput): Promise<EdgeKeyCreateResult> => {
    const parsed = parseOrThrow(edgeKeyCreateSchema, input, '边缘密钥');
    const now = new Date();
    const secret = `ek_${randomBytes(24).toString('base64url')}`;
    const record: EdgeKeyRecord = {
      id: newId('edgekey'),
      name: parsed.name,
      group: parsed.group ?? null,
      expiresAt:
        parsed.ttlSec === undefined
          ? null
          : new Date(now.getTime() + parsed.ttlSec * 1000).toISOString(),
      maxUses: parsed.maxUses ?? 0,
      uses: 0,
      revokedAt: null,
      lastUsedAt: null,
      createdAt: now.toISOString(),
      secretHash: hashMachineSecret(secret),
    };
    await keys.create(record);
    await audit('edge.key.create', `edge-key:${record.id}`, 'ok', {
      name: record.name,
      group: record.group,
      maxUses: record.maxUses,
    });
    return { key: toPublicKey(record), secret };
  };

  const listKeys = async (query: PageQuery = {}): Promise<ListResult<EdgeKey>> => {
    const limit = normalizeLimit(query.limit);
    const offset = decodeCursor(query.cursor);
    const all = (await keys.list()).sort(compareByCreated);
    const page = all.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return {
      available: true,
      items: page.map(toPublicKey),
      nextCursor: nextOffset < all.length ? encodeCursor(nextOffset) : null,
      total: all.length,
    };
  };

  const revokeKey = async (id: string): Promise<void> => {
    const existing = await keys.get(id);
    if (existing === undefined) {
      throw new PanelError('NOT_FOUND', '边缘密钥不存在', { resource: 'edge-key', id });
    }
    if (existing.revokedAt === null) {
      await keys.update(id, { revokedAt: new Date().toISOString() });
    }
    await audit('edge.key.revoke', `edge-key:${id}`, 'ok');
  };

  const resolveEnrollment = async (
    input: EdgeEnrollRequest,
    context: EdgeEnrollContext = {},
  ): Promise<EdgeEnrollResult> => {
    const ipKey = context.ip !== undefined && context.ip.length > 0 ? context.ip : 'unknown';
    const decision = enrollLimiter.hit(ipKey);
    if (!decision.allowed) {
      throw new PanelError('UNAUTHORIZED', '边缘入网请求过于频繁', {
        retryAfterSec: decision.retryAfterSec ?? 60,
      });
    }
    const parsed = parseOrThrow(edgeEnrollRequestSchema, input, '边缘入网请求');

    return enqueueEnroll(async () => {
      const record = await keys.findBySecretHash(hashMachineSecret(parsed.key));
      if (record === undefined) {
        throw new PanelError('UNAUTHORIZED', '边缘入网密钥无效', {
          hint: '确认 MPANEL_EDGE_KEY 与 core 上创建的密钥一致；密钥只在创建时显示一次',
        });
      }
      const now = Date.now();
      if (record.revokedAt !== null) {
        throw new PanelError('FORBIDDEN', '边缘入网密钥已吊销', {
          resource: 'edge-key',
          id: record.id,
        });
      }
      if (record.expiresAt !== null && Date.parse(record.expiresAt) <= now) {
        throw new PanelError('FORBIDDEN', '边缘入网密钥已过期', {
          resource: 'edge-key',
          id: record.id,
        });
      }
      if (record.maxUses > 0 && record.uses >= record.maxUses) {
        throw new PanelError('FORBIDDEN', '边缘入网密钥使用次数已达上限', {
          resource: 'edge-key',
          id: record.id,
          maxUses: record.maxUses,
        });
      }

      const name =
        parsed.name ?? `${sanitizeNamePart(parsed.platform)}-${randomBytes(3).toString('hex')}`;
      const wsUrl = coreWsWorkerUrl(deps.config, context.origin);
      const created = await deps.machines.createEdgeMachine(
        { name, group: record.group, edgeKeyId: record.id },
        wsUrl,
      );
      await keys.update(record.id, {
        uses: record.uses + 1,
        lastUsedAt: new Date().toISOString(),
      });
      await recordEnroll({
        keyId: record.id,
        machineId: created.machine.id,
        ...(context.ip === undefined ? {} : { ip: context.ip }),
        platform: parsed.platform,
        arch: parsed.arch,
        version: parsed.version,
        name,
      });
      return { machine: created.machine, secret: created.secret, wsUrl: created.wsUrl };
    });
  };

  const recordEnroll = async (
    details: EdgeAuditDetails,
    result: 'ok' | 'error' = 'ok',
    error?: unknown,
  ): Promise<void> => {
    try {
      await deps.audit.write({
        at: new Date().toISOString(),
        action: 'edge.enroll',
        actor: 'edge',
        ...(details.ip === undefined ? {} : { ip: details.ip }),
        target: `machine:${details.machineId}`,
        result,
        details: {
          keyId: details.keyId,
          machineId: details.machineId,
          ...(details.ip === undefined ? {} : { ip: details.ip }),
          ...(details.platform === undefined ? {} : { platform: details.platform }),
          ...(details.arch === undefined ? {} : { arch: details.arch }),
          ...(details.version === undefined ? {} : { version: details.version }),
          ...(details.name === undefined ? {} : { name: details.name }),
          ...(error === undefined
            ? {}
            : { error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) }),
        },
      });
    } catch {
      // 审计失败不影响入网。
    }
  };

  const listJobs = async (query: {
    machineId?: string;
    status?: EdgeJobStatus;
    limit?: number;
    cursor?: string;
  } = {}): Promise<ListResult<EdgeJob>> => {
    const limit = normalizeLimit(query.limit);
    const offset = decodeCursor(query.cursor);
    let status: EdgeJobStatus | undefined;
    if (query.status !== undefined) {
      const parsed = edgeJobStatusSchema.safeParse(query.status);
      if (!parsed.success) {
        throw new PanelError('BAD_REQUEST', 'status 参数无效', {
          allowed: edgeJobStatusSchema.options,
        });
      }
      status = parsed.data;
    }
    const all = (await jobs.list())
      .filter((job) => (query.machineId === undefined ? true : job.machineId === query.machineId))
      .filter((job) => (status === undefined ? true : job.status === status))
      .sort(compareByCreated);
    const page = all.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return {
      available: true,
      items: page,
      nextCursor: nextOffset < all.length ? encodeCursor(nextOffset) : null,
      total: all.length,
    };
  };

  const createJob = async (input: EdgeJobCreateInput): Promise<EdgeJob> => {
    const parsed = parseOrThrow(edgeJobCreateSchema, input, '边缘作业');
    // machine 不存在 → NOT_FOUND（删除的机器不能排队）。
    await deps.machines.get(parsed.machineId);
    const payload = parsed.payload ?? {};
    if (parsed.kind === 'run-task') {
      requirePayloadField(payload, 'taskId');
    } else if (parsed.kind === 'apply-site') {
      requirePayloadField(payload, 'siteId');
    }
    const job: EdgeJob = {
      id: newId('edgejob'),
      machineId: parsed.machineId,
      kind: parsed.kind,
      payload,
      status: 'pending',
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      httpStatus: null,
      result: null,
      error: null,
    };
    await jobs.create(job);
    // Round-trip through the schema to guarantee the persisted record shape.
    const validated = edgeJobSchema.safeParse(job);
    await audit('edge.job.create', `machine:${job.machineId}`, 'ok', {
      jobId: job.id,
      kind: job.kind,
    });
    return validated.success ? validated.data : job;
  };

  const getJob = async (id: string): Promise<EdgeJob> => {
    const job = await jobs.get(id);
    if (job === undefined) {
      throw new PanelError('NOT_FOUND', '边缘作业不存在', { resource: 'edge-job', id });
    }
    return job;
  };

  const deleteJob = async (id: string): Promise<void> => {
    const job = await getJob(id);
    if (job.status !== 'pending') {
      throw new PanelError('CONFLICT', '只能删除 pending 状态的边缘作业', {
        resource: 'edge-job',
        id,
        status: job.status,
      });
    }
    await jobs.remove(id);
    await audit('edge.job.delete', `machine:${job.machineId}`, 'ok', { jobId: id });
  };

  const audit = async (
    action: string,
    target: string,
    result: 'ok' | 'denied' | 'error',
    details?: Record<string, unknown>,
  ): Promise<void> => {
    try {
      await deps.audit.write({
        at: new Date().toISOString(),
        action,
        actor: 'core',
        target,
        result,
        ...(details === undefined ? {} : { details }),
      });
    } catch {
      // 审计失败不阻塞业务。
    }
  };

  return {
    createKey,
    listKeys,
    revokeKey,
    resolveEnrollment,
    recordEnroll,
    listJobs,
    createJob,
    getJob,
    deleteJob,
    startDispatcher: () => dispatcher.start(),
    stopDispatcher: () => dispatcher.stop(),
    refreshSnapshot: (machineId) => dispatcher.refreshSnapshot(machineId),
  };
}

/* -------------------------------------------------------------------- */
/* Helpers                                                              */
/* -------------------------------------------------------------------- */

interface SafeParseSchema<T> {
  safeParse(input: unknown):
    | { success: true; data: T }
    | {
        success: false;
        error: {
          issues: ReadonlyArray<{
            path: ReadonlyArray<string | number | symbol>;
            message: string;
            code?: unknown;
          }>;
        };
      };
}

function parseOrThrow<T>(schema: SafeParseSchema<T>, input: unknown, label: string): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new PanelError('BAD_REQUEST', `${label}校验失败`, {
    issues: result.error.issues.map((issue) => ({
      path: issue.path.map((part) => String(part)).join('.'),
      code: typeof issue.code === 'string' ? issue.code : 'custom',
      message: issue.message,
    })),
  });
}

function requirePayloadField(payload: Record<string, unknown>, field: string): void {
  const value = payload[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new PanelError('BAD_REQUEST', `边缘作业缺少 payload.${field}`, {
      field,
      issues: [{ path: `payload.${field}`, code: 'invalid_type', message: '必须是非空字符串' }],
    });
  }
}

function toPublicKey(record: EdgeKeyRecord): EdgeKey {
  const { secretHash: _secretHash, ...publicKey } = record;
  return publicKey;
}

function sanitizeNamePart(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  return cleaned.length > 0 ? cleaned : 'edge';
}

function compareByCreated(left: { createdAt: string; id: string }, right: { createdAt: string; id: string }): number {
  const byCreated = left.createdAt.localeCompare(right.createdAt);
  return byCreated !== 0 ? byCreated : left.id.localeCompare(right.id);
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
