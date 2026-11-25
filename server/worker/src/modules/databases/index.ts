import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  PanelError,
  backupRequestSchema,
  badRequest,
  databaseKindSchema,
  databaseProfileCreateSchema,
  databaseProfileUpdateSchema,
  handoffRedeemRequestSchema,
  handoffRequestSchema,
  okEnvelope,
  pageQuerySchema,
  restoreRequestSchema,
} from '@mpanel/shared';
import type {
  CapabilityProvider,
  DatabaseKind,
  ListResult,
  ModuleLogger,
  PageQuery,
} from '@mpanel/shared';
import type { WorkerModule } from '../../registry.js';
import type { WorkerLogger } from '../../logger.js';
import { assertCapability } from '../../util.js';
import { createDatabaseStore } from './store.js';
import type { DatabaseStore } from './store.js';
import { createSecretCipher, loadOrCreateSecretKeyAt } from './secrets.js';
import { createPostgresDriver } from './postgres.js';
import type { PostgresDriver } from './postgres.js';
import { createRedisDriver } from './redis.js';
import type { RedisDriver } from './redis.js';
import { createProfileService } from './profiles.js';
import type { ProfileService } from './profiles.js';
import { createDatabaseJobService } from './jobs.js';
import type { DatabaseJobService } from './jobs.js';
import { createHandoffService } from './handoff.js';
import type { HandoffService } from './handoff.js';

interface RouteDeps {
  profiles: ProfileService;
  jobs: DatabaseJobService;
  handoff: HandoffService;
  postgres: PostgresDriver;
  redis: RedisDriver;
  store: DatabaseStore;
  capabilities: CapabilityProvider;
  dbxOrigin?: string;
}

interface IdParams {
  Params: { id: string };
}

interface BackupParams {
  Params: { backupId: string };
}

type ParserResult<T> =
  | { success: true; data: T }
  | { success: false; error: { issues: unknown } };

interface SafeParser<T> {
  safeParse(value: unknown): ParserResult<T>;
}

/**
 * Databases API module. prefixes: ['/databases'].
 * 唯一无认证的路由是 POST /databases/handoff/redeem（由 http 层精确放行）。
 */
export function createDatabasesModule(): WorkerModule {
  return {
    name: 'databases',
    prefixes: ['/databases'],
    register(context) {
      const logger = toWorkerLogger(context.logger);
      const configuredKeyFile = context.config.security.keyFile;
      const keyFile =
        typeof configuredKeyFile === 'string' && configuredKeyFile.trim().length > 0
          ? configuredKeyFile
          : join(context.homeDir, 'secrets.key');
      const cipher = createSecretCipher(
        loadOrCreateSecretKeyAt(keyFile, context.config.security.secretKey),
      );
      const store = createDatabaseStore(
        join(context.homeDir, 'state', 'databases.json'),
        cipher,
      );
      const postgres = createPostgresDriver(context.config, context.runner, logger);
      const redis = createRedisDriver(context.config, context.runner, logger);
      const profiles = createProfileService({
        store,
        postgres,
        redis,
        cipher,
        logger,
        capabilities: context.capabilities,
      });
      const jobs = createDatabaseJobService({
        config: context.config,
        store,
        postgres,
        redis,
        logger,
      });
      const handoff = createHandoffService({
        store,
        cipher,
        publicUrl: context.config.publicUrl,
        rateLimit: context.config.redeemRateLimit,
        logger,
      });
      registerRoutes(context.app, {
        profiles,
        jobs,
        handoff,
        postgres,
        redis,
        store,
        capabilities: context.capabilities,
        ...(context.config.dbxOrigin !== undefined
          ? { dbxOrigin: context.config.dbxOrigin }
          : {}),
      });
    },
  };
}

function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  /* ------------------------------- handoff ------------------------------- */

  app.options('/databases/handoff/redeem', async (req, reply) => {
    applyRedeemCors(req, reply, deps.dbxOrigin);
    return reply.code(204).send();
  });

  app.post('/databases/handoff/redeem', async (req, reply) => {
    applyRedeemCors(req, reply, deps.dbxOrigin);
    reply.header('cache-control', 'no-store');
    reply.header('pragma', 'no-cache');
    const body = parseBody(handoffRedeemRequestSchema, req.body, 'handoff 参数');
    const payload = await deps.handoff.redeem(body.ticket, req.ip);
    return reply.send(okEnvelope(payload));
  });

  /* ------------------------------- profiles ------------------------------ */

  app.get('/databases/profiles', async (req) => {
    const q = queryRecord(req);
    const page = parsePageQuery(req);
    const kind = parseKind(q.kind);
    const search = optionalQueryString(q.q, 'q');
    const items = await deps.profiles.list({
      ...page,
      ...(kind !== undefined ? { kind } : {}),
      ...(search !== undefined ? { q: search } : {}),
    });
    return okEnvelope(items);
  });

  app.post('/databases/profiles', async (req, reply) => {
    const raw = normalizeProfileInput(req.body);
    const input = parseBody(databaseProfileCreateSchema, raw, '数据库档案参数');
    const notes = parseNotes(raw);
    const created = await deps.profiles.create({
      ...input,
      ...(notes !== undefined ? { notes } : {}),
    });
    return reply.code(201).send(okEnvelope(created));
  });

  app.get<IdParams>('/databases/profiles/:id', async (req) => {
    // 契约 §8.1：密码只写不读；唯一明文出口是 POST /databases/handoff/redeem。
    const profile = await deps.profiles.get(req.params.id);
    return okEnvelope(profile);
  });

  app.patch<IdParams>('/databases/profiles/:id', async (req) => {
    const raw = normalizeProfileInput(req.body);
    const notes = parseNotes(raw);
    // notes 不在共享 PATCH schema 内；允许只修改备注。
    if (!hasCanonicalUpdateField(raw)) {
      if (notes === undefined) {
        throw badRequest('至少需要修改一个字段');
      }
      const updatedNotes = await deps.profiles.update(req.params.id, { notes });
      return okEnvelope(updatedNotes);
    }
    const input = parseBody(databaseProfileUpdateSchema, raw, '数据库档案参数');
    const updated = await deps.profiles.update(req.params.id, {
      ...input,
      ...(notes !== undefined ? { notes } : {}),
    });
    return okEnvelope(updated);
  });

  app.delete<IdParams>('/databases/profiles/:id', async (req) => {
    await deps.profiles.remove(req.params.id);
    deps.handoff.revokeProfile(req.params.id);
    return okEnvelope({ deleted: true });
  });

  app.post<IdParams>('/databases/profiles/:id/test', async (req) => {
    const result = await deps.profiles.test(req.params.id);
    return okEnvelope(result);
  });

  app.get<IdParams>('/databases/profiles/:id/stats', async (req) => {
    const stats = await deps.profiles.stats(req.params.id);
    return okEnvelope(stats);
  });

  app.post<IdParams>('/databases/profiles/:id/handoff', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    const parsed = handoffRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw badRequest('handoff 参数校验失败', { issues: parsed.error.issues });
    }
    const ticket = await deps.handoff.issue(req.params.id, parsed.data.ttlSec);
    return reply.send(okEnvelope(ticket));
  });

  /* ------------------------------ diagnostics ---------------------------- */

  app.get<IdParams>('/databases/profiles/:id/databases', async (req) => {
    const profile = await requireProfileKind(deps, req.params.id, 'postgres');
    await assertCapability(deps.capabilities, 'postgres');
    const password = await requirePassword(deps, req.params.id);
    const items = await deps.postgres.databases(profile, password);
    return okEnvelope(listEnvelope(items));
  });

  app.get<IdParams>('/databases/profiles/:id/tables', async (req) => {
    const profile = await requireProfileKind(deps, req.params.id, 'postgres');
    await assertCapability(deps.capabilities, 'postgres');
    const password = await requirePassword(deps, req.params.id);
    const items = await deps.postgres.tables(profile, password);
    return okEnvelope(listEnvelope(items));
  });

  app.get<IdParams>('/databases/profiles/:id/slow-queries', async (req) => {
    const profile = await requireProfileKind(deps, req.params.id, 'postgres');
    await assertCapability(deps.capabilities, 'postgres');
    const limit = optionalLimit(queryRecord(req).limit, 10);
    const password = await requirePassword(deps, req.params.id);
    const items = await deps.postgres.slowQueries(profile, password, limit);
    return okEnvelope(listEnvelope(items));
  });

  app.get<IdParams>('/databases/profiles/:id/keyspace', async (req) => {
    const profile = await requireProfileKind(deps, req.params.id, 'redis');
    await assertCapability(deps.capabilities, 'redis');
    const password = await requirePassword(deps, req.params.id);
    const items = await deps.redis.keyspace(profile, password);
    return okEnvelope(listEnvelope(items));
  });

  app.get<IdParams>('/databases/profiles/:id/slowlog', async (req) => {
    const profile = await requireProfileKind(deps, req.params.id, 'redis');
    await assertCapability(deps.capabilities, 'redis');
    const limit = optionalLimit(queryRecord(req).limit, 20);
    const password = await requirePassword(deps, req.params.id);
    const items = await deps.redis.slowlog(profile, password, limit);
    return okEnvelope(listEnvelope(items));
  });

  /* -------------------------------- backups ------------------------------ */

  app.post<IdParams>('/databases/profiles/:id/backup', async (req, reply) => {
    const body = parseOptionalBody(backupRequestSchema, req.body, '备份参数');
    const job = await deps.jobs.startBackup(req.params.id, body);
    return reply.code(202).send(okEnvelope({ job }));
  });

  app.get<IdParams>('/databases/profiles/:id/backups', async (req) => {
    const page = parsePageQuery(req);
    const items = await deps.jobs.listBackups(req.params.id, page);
    return okEnvelope(items);
  });

  app.post<IdParams>('/databases/profiles/:id/restore', async (req, reply) => {
    const body = parseBody(restoreRequestSchema, req.body, '恢复参数');
    const job = await deps.jobs.startRestore(req.params.id, body);
    return reply.code(202).send(okEnvelope({ job }));
  });

  app.get<BackupParams>('/databases/backups/:backupId/download', async (req, reply) => {
    const resolved = await deps.jobs.resolveBackupFile(req.params.backupId);
    const fileName = resolved.backup.fileName.replace(/["\\\r\n]/g, '_');
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-length', String(resolved.sizeBytes));
    reply.header('content-disposition', `attachment; filename="${fileName}"`);
    reply.header('cache-control', 'no-store');
    return reply.send(createReadStream(resolved.path));
  });

  app.get<BackupParams>('/databases/backups/:backupId', async (req) => {
    const backup = await deps.jobs.getBackup(req.params.backupId);
    if (backup === undefined) {
      throw notFoundBackup(req.params.backupId);
    }
    return okEnvelope(backup);
  });

  app.delete<BackupParams>('/databases/backups/:backupId', async (req) => {
    await deps.jobs.deleteBackup(req.params.backupId);
    return okEnvelope({ deleted: true });
  });

  /* --------------------------------- jobs -------------------------------- */

  app.get('/databases/jobs', async (req) => {
    const q = queryRecord(req);
    const page = parsePageQuery(req);
    const profileId = optionalQueryString(q.profileId, 'profileId');
    const status = optionalQueryString(q.status, 'status');
    if (status !== undefined && !JOB_STATUSES.has(status)) {
      throw badRequest('status 必须是 queued/running/success/failed', { field: 'status' });
    }
    const items = await deps.jobs.listJobs({
      ...page,
      ...(profileId !== undefined ? { profileId } : {}),
      ...(status !== undefined ? { status } : {}),
    });
    return okEnvelope(items);
  });

  app.get<{ Params: { jobId: string } }>('/databases/jobs/:jobId', async (req) => {
    const job = await deps.jobs.getJob(req.params.jobId);
    if (job === undefined) {
      throw notFoundJob(req.params.jobId);
    }
    return okEnvelope(job);
  });
}

const JOB_STATUSES = new Set(['queued', 'running', 'success', 'failed']);

/* ------------------------------------------------------------------ */
/* 请求解析辅助                                                        */
/* ------------------------------------------------------------------ */

function queryRecord(req: FastifyRequest): Record<string, unknown> {
  const query: unknown = req.query;
  return typeof query === 'object' && query !== null
    ? (query as Record<string, unknown>)
    : {};
}

function parsePageQuery(req: FastifyRequest): PageQuery {
  const parsed = pageQuerySchema.safeParse(queryRecord(req));
  if (!parsed.success) {
    throw badRequest('分页参数无效', { issues: parsed.error.issues });
  }
  return parsed.data;
}

function parseBody<T>(schema: SafeParser<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw badRequest(`${label}校验失败`, { issues: parsed.error.issues });
  }
  return parsed.data;
}

function parseOptionalBody<T>(schema: SafeParser<T>, value: unknown, label: string): T {
  return parseBody(schema, value ?? {}, label);
}

function parseKind(value: unknown): DatabaseKind | undefined {
  if (value === undefined) return undefined;
  const normalized = value === 'pg' ? 'postgres' : value;
  const parsed = databaseKindSchema.safeParse(normalized);
  if (!parsed.success) {
    throw badRequest('kind 必须是 postgres 或 redis', { field: 'kind' });
  }
  return parsed.data;
}

function optionalQueryString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  throw badRequest(`${field} 必须是字符串`, { field });
}

function optionalLimit(value: unknown, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw badRequest('limit 必须是 1-100 的整数', { field: 'limit' });
  }
  return parsed;
}

/** 接受 engine/ssl 兼容别名，规范化成共享契约的 kind/tls。 */
function normalizeProfileInput(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const input = { ...(value as Record<string, unknown>) };
  if (input.kind === 'pg') input.kind = 'postgres';
  if (input.kind === undefined && typeof input.engine === 'string') {
    const engine = input.engine.toLowerCase();
    if (engine === 'pg' || engine === 'postgres') input.kind = 'postgres';
    else if (engine === 'redis') input.kind = 'redis';
  }
  if (input.tls === undefined && typeof input.ssl === 'boolean') {
    input.tls = input.ssl;
  }
  return input;
}

function parseNotes(value: unknown): string | null | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const notes = (value as Record<string, unknown>).notes;
  if (notes === undefined) return undefined;
  if (notes === null) return null;
  if (typeof notes !== 'string') {
    throw badRequest('notes 必须是字符串', { field: 'notes' });
  }
  if (notes.length > 2000) {
    throw badRequest('notes 不能超过 2000 个字符', { field: 'notes' });
  }
  return notes;
}

const PROFILE_UPDATE_FIELDS = [
  'name',
  'host',
  'port',
  'username',
  'password',
  'database',
  'tls',
  'redisDb',
] as const;

function hasCanonicalUpdateField(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return PROFILE_UPDATE_FIELDS.some((field) =>
    Object.prototype.hasOwnProperty.call(record, field),
  );
}

async function requireProfileKind(
  deps: RouteDeps,
  id: string,
  kind: DatabaseKind,
): Promise<Awaited<ReturnType<ProfileService['get']>>> {
  const profile = await deps.profiles.get(id);
  if (profile.kind !== kind) {
    const label = kind === 'postgres' ? 'PostgreSQL' : 'Redis';
    throw badRequest(`该操作仅适用于 ${label} 档案`, { id, kind: profile.kind });
  }
  return profile;
}

async function requirePassword(deps: RouteDeps, id: string): Promise<string | null> {
  const password = await deps.store.getPassword(id);
  if (password === undefined) {
    throw new PanelError('NOT_FOUND', '数据库档案不存在', { id });
  }
  return password;
}

function listEnvelope<T>(items: T[]): ListResult<T> {
  return { available: true, items, total: items.length, nextCursor: null };
}

function notFoundBackup(id: string): PanelError {
  return new PanelError('NOT_FOUND', '备份记录不存在', { id });
}

function notFoundJob(id: string): PanelError {
  return new PanelError('NOT_FOUND', '数据库任务不存在', { id });
}

/* ------------------------------------------------------------------ */
/* CORS / 日志                                                         */
/* ------------------------------------------------------------------ */

function applyRedeemCors(
  req: FastifyRequest,
  reply: { header(name: string, value: string): unknown },
  dbxOrigin?: string,
): void {
  reply.header('vary', 'Origin');
  const origin = req.headers.origin;
  if (dbxOrigin !== undefined && dbxOrigin.length > 0 && origin === dbxOrigin) {
    reply.header('access-control-allow-origin', dbxOrigin);
    reply.header('access-control-allow-methods', 'POST, OPTIONS');
    reply.header('access-control-allow-headers', 'content-type');
    reply.header('access-control-max-age', '600');
  }
}

function toWorkerLogger(logger: ModuleLogger): WorkerLogger {
  const candidate = logger as Partial<WorkerLogger>;
  if (typeof candidate.child === 'function') return logger as WorkerLogger;
  const adapter: WorkerLogger = {
    debug: (message, details) => logger.debug(message, details),
    info: (message, details) => logger.info(message, details),
    warn: (message, details) => logger.warn(message, details),
    error: (message, details) => logger.error(message, details),
    child: () => adapter,
  };
  return adapter;
}
