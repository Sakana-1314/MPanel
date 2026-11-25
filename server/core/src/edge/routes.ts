import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { errorEnvelope, isPanelError, okEnvelope, PanelError } from '@mpanel/shared';
import type { EdgeJobStatus } from '@mpanel/shared';
import type { EdgeService } from './service.js';

/**
 * `/edge/*` routes (docs/api-contract.md §5.4). Registered inside the
 * protected `/api/v1` scope; `POST /edge/enroll` is the single unauthenticated
 * exception (key + per-IP rate limit are enforced by EdgeService and app.ts).
 */
export async function registerEdgeRoutes(
  app: FastifyInstance,
  deps: { edge: EdgeService },
): Promise<void> {
  app.post(
    '/edge/enroll',
    guarded(async (req, reply) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const result = await deps.edge.resolveEnrollment(body as never, {
        ...(typeof req.ip === 'string' ? { ip: req.ip } : {}),
        ...(originOf(req) === undefined ? {} : { origin: originOf(req) as string }),
      });
      return reply.code(200).send(okEnvelope(result));
    }),
  );

  app.get(
    '/edge/keys',
    guarded(async (req, reply) => {
      const query = parsePageQuery(req.query);
      const result = await deps.edge.listKeys(query);
      return reply.code(200).send(okEnvelope(result));
    }),
  );

  app.post(
    '/edge/keys',
    guarded(async (req, reply) => {
      const result = await deps.edge.createKey((req.body ?? {}) as never);
      return reply.code(201).send(okEnvelope(result));
    }),
  );

  app.delete(
    '/edge/keys/:id',
    guarded(async (req, reply) => {
      const id = paramId(req);
      await deps.edge.revokeKey(id);
      return reply.code(200).send(okEnvelope({ revoked: true }));
    }),
  );

  app.get(
    '/edge/jobs',
    guarded(async (req, reply) => {
      const query = parseJobQuery(req.query);
      const result = await deps.edge.listJobs(query);
      return reply.code(200).send(okEnvelope(result));
    }),
  );

  app.post(
    '/edge/jobs',
    guarded(async (req, reply) => {
      const job = await deps.edge.createJob((req.body ?? {}) as never);
      return reply.code(201).send(okEnvelope(job));
    }),
  );

  app.get(
    '/edge/jobs/:id',
    guarded(async (req, reply) => {
      const job = await deps.edge.getJob(paramId(req));
      return reply.code(200).send(okEnvelope(job));
    }),
  );

  app.delete(
    '/edge/jobs/:id',
    guarded(async (req, reply) => {
      await deps.edge.deleteJob(paramId(req));
      return reply.code(200).send(okEnvelope({ deleted: true }));
    }),
  );
}

/* -------------------------------------------------------------------- */
/* Helpers                                                              */
/* -------------------------------------------------------------------- */

type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown;

function guarded(handler: Handler): Handler {
  return async (req, reply) => {
    try {
      return await handler(req, reply);
    } catch (error) {
      if (reply.sent) return undefined;
      if (isPanelError(error)) {
        return reply.code(error.status).send(errorEnvelope(error.code, error.message, error.details));
      }
      return reply.code(500).send(errorEnvelope('INTERNAL', '边缘操作失败'));
    }
  };
}

function paramId(req: FastifyRequest): string {
  const params = req.params as { id?: unknown };
  if (typeof params.id !== 'string' || params.id.length === 0) {
    throw new PanelError('BAD_REQUEST', '缺少 id');
  }
  return params.id;
}

function parsePageQuery(raw: unknown): { limit?: number; cursor?: string } {
  const query = (raw ?? {}) as Record<string, unknown>;
  const result: { limit?: number; cursor?: string } = {};
  const limit = singleString(query.limit);
  if (limit !== undefined && limit.length > 0) {
    const value = Number(limit);
    if (!Number.isInteger(value) || value < 1 || value > 200) {
      throw new PanelError('BAD_REQUEST', 'limit 必须是 1 到 200 之间的整数');
    }
    result.limit = value;
  }
  const cursor = singleString(query.cursor);
  if (cursor !== undefined) result.cursor = cursor;
  return result;
}

function parseJobQuery(raw: unknown): {
  machineId?: string;
  status?: EdgeJobStatus;
  limit?: number;
  cursor?: string;
} {
  const query = (raw ?? {}) as Record<string, unknown>;
  const page = parsePageQuery(query);
  const machineId = singleString(query.machineId);
  const status = singleString(query.status);
  return {
    ...page,
    ...(machineId === undefined || machineId.length === 0 ? {} : { machineId }),
    ...(status === undefined || status.length === 0 ? {} : { status: status as EdgeJobStatus }),
  };
}

function singleString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function originOf(req: FastifyRequest): string | undefined {
  const proto = singleString(req.headers['x-forwarded-proto']) ?? req.protocol ?? 'http';
  const host = singleString(req.headers['x-forwarded-host']) ?? singleString(req.headers.host);
  if (host === undefined || host.length === 0) return undefined;
  return `${proto}://${host}`;
}
