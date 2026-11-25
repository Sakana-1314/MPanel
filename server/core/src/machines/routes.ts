import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  errorEnvelope,
  isPanelError,
  machineStatusSchema,
  machineTransportSchema,
  okEnvelope,
  PanelError,
  type MachineCreateResult,
  type MachineStatus,
  type MachineTransport,
} from '@mpanel/shared';
import type { CoreConfig } from '../config.js';
import type { AuditLog } from '../audit.js';
import type { AuthContext, AuthService } from '../auth/types.js';
import type { RateLimiter } from '../auth/rate-limit.js';
import { coreWsWorkerUrl, type MachineService } from './service.js';

/** /machines*；所有写操作写 audit。路由位于 `/api/v1` 作用域内，已由网关鉴权。 */
export async function registerMachineRoutes(
  app: FastifyInstance,
  deps: {
    machines: MachineService;
    auth: AuthService;
    config: CoreConfig;
    audit: AuditLog;
    rateLimit?: RateLimiter;
  },
): Promise<void> {
  app.get(
    '/machines',
    guarded(async (req, reply) => {
      const query = parseListQuery(req.query);
      const result = await deps.machines.list(query);
      return reply.code(200).send(okEnvelope(result));
    }),
  );

  app.post(
    '/machines',
    guarded(async (req, reply) => {
      const input = (req.body ?? {}) as Record<string, unknown>;
      let result: MachineCreateResult;
      try {
        result = await deps.machines.create(input as never);
      } catch (error) {
        await audit(deps, req, 'machine.create', '', 'error', error);
        throw error;
      }
      const enriched = withRequestOrigin(result, deps.config, req);
      await audit(deps, req, 'machine.create', enriched.machine.id, 'ok', undefined, {
        transport: enriched.machine.transport,
        name: enriched.machine.name,
      });
      return reply.code(201).send(okEnvelope(enriched));
    }),
  );

  app.get(
    '/machines/:id',
    guarded(async (req, reply) => {
      const id = machineIdOf(req);
      const machine = await deps.machines.get(id);
      return reply.code(200).send(okEnvelope(machine));
    }),
  );

  app.patch(
    '/machines/:id',
    guarded(async (req, reply) => {
      const id = machineIdOf(req);
      try {
        const machine = await deps.machines.update(id, (req.body ?? {}) as never);
        await audit(deps, req, 'machine.update', id, 'ok');
        return reply.code(200).send(okEnvelope(machine));
      } catch (error) {
        await audit(deps, req, 'machine.update', id, 'error', error);
        throw error;
      }
    }),
  );

  app.delete(
    '/machines/:id',
    guarded(async (req, reply) => {
      const id = machineIdOf(req);
      try {
        await deps.machines.remove(id);
        await audit(deps, req, 'machine.delete', id, 'ok');
        return reply.code(200).send(okEnvelope({ deleted: true }));
      } catch (error) {
        await audit(deps, req, 'machine.delete', id, 'error', error);
        throw error;
      }
    }),
  );

  app.post(
    '/machines/:id/connect',
    guarded(async (req, reply) => {
      const id = machineIdOf(req);
      try {
        const machine = await deps.machines.connect(id);
        await audit(deps, req, 'machine.connect', id, 'ok', undefined, { status: machine.status });
        return reply.code(200).send(okEnvelope(machine));
      } catch (error) {
        await audit(deps, req, 'machine.connect', id, 'error', error);
        throw error;
      }
    }),
  );

  app.post(
    '/machines/:id/disconnect',
    guarded(async (req, reply) => {
      const id = machineIdOf(req);
      try {
        const machine = await deps.machines.disconnect(id);
        await audit(deps, req, 'machine.disconnect', id, 'ok');
        return reply.code(200).send(okEnvelope(machine));
      } catch (error) {
        await audit(deps, req, 'machine.disconnect', id, 'error', error);
        throw error;
      }
    }),
  );

  app.post(
    '/machines/:id/test',
    guarded(async (req, reply) => {
      const id = machineIdOf(req);
      const result = await deps.machines.test(id);
      return reply.code(200).send(okEnvelope(result));
    }),
  );

  app.get(
    '/machines/:id/health',
    guarded(async (req, reply) => {
      const id = machineIdOf(req);
      const health = await deps.machines.health(id);
      return reply.code(200).send(okEnvelope(health));
    }),
  );

  app.post(
    '/machines/:id/secret/rotate',
    guarded(async (req, reply) => {
      const id = machineIdOf(req);
      try {
        const data = await deps.machines.rotateSecret(id);
        if (!deps.config.publicUrl) {
          const url = coreWsWorkerUrl(deps.config, originOf(req));
          data.workerEnv = { ...data.workerEnv, MPANEL_CORE_URL: url };
        }
        await audit(deps, req, 'machine.rotate-secret', id, 'ok');
        return reply.code(200).send(okEnvelope(data));
      } catch (error) {
        await audit(deps, req, 'machine.rotate-secret', id, 'error', error);
        throw error;
      }
    }),
  );
}

/* -------------------------------------------------------------------- */
/* 辅助                                                                 */
/* -------------------------------------------------------------------- */

type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown;

/** 无论上层是否注册错误处理器，机器路由都返回标准信封。 */
function guarded(handler: Handler): Handler {
  return async (req, reply) => {
    try {
      return await handler(req, reply);
    } catch (error) {
      if (reply.sent) return undefined;
      if (isPanelError(error)) {
        return reply.code(error.status).send(errorEnvelope(error.code, error.message, error.details));
      }
      return reply.code(500).send(errorEnvelope('INTERNAL', '机器操作失败'));
    }
  };
}

function machineIdOf(req: FastifyRequest): string {
  const params = req.params as { id?: unknown };
  if (typeof params.id !== 'string' || params.id.length === 0) {
    throw new PanelError('BAD_REQUEST', '缺少机器 id');
  }
  return params.id;
}

function parseListQuery(raw: unknown): {
  status?: MachineStatus;
  transport?: MachineTransport;
  q?: string;
  limit?: number;
  cursor?: string;
} {
  const query = (raw ?? {}) as Record<string, unknown>;
  const result: {
    status?: MachineStatus;
    transport?: MachineTransport;
    q?: string;
    limit?: number;
    cursor?: string;
  } = {};

  const status = singleString(query.status);
  if (status !== undefined) {
    const parsed = machineStatusSchema.safeParse(status);
    if (!parsed.success) {
      throw new PanelError('BAD_REQUEST', 'status 参数无效', {
        allowed: machineStatusSchema.options,
      });
    }
    result.status = parsed.data;
  }

  const transport = singleString(query.transport);
  if (transport !== undefined) {
    const parsed = machineTransportSchema.safeParse(transport);
    if (!parsed.success) {
      throw new PanelError('BAD_REQUEST', 'transport 参数无效', {
        allowed: machineTransportSchema.options,
      });
    }
    result.transport = parsed.data;
  }

  const q = singleString(query.q);
  if (q !== undefined) result.q = q;

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

function singleString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
  return undefined;
}

function withRequestOrigin(
  result: MachineCreateResult,
  config: CoreConfig,
  req: FastifyRequest,
): MachineCreateResult {
  if (result.enrollment === undefined || config.publicUrl !== undefined) return result;
  const url = coreWsWorkerUrl(config, originOf(req));
  return {
    ...result,
    enrollment: {
      ...result.enrollment,
      url,
      workerEnv: { ...result.enrollment.workerEnv, MPANEL_CORE_URL: url },
    },
  };
}

function originOf(req: FastifyRequest): string | undefined {
  const proto =
    singleString(req.headers['x-forwarded-proto']) ?? req.protocol ?? 'http';
  const host = singleString(req.headers['x-forwarded-host']) ?? singleString(req.headers.host);
  if (host === undefined || host.length === 0) return undefined;
  return `${proto}://${host}`;
}

async function audit(
  deps: { auth: AuthService; audit: AuditLog },
  req: FastifyRequest,
  action: string,
  target: string,
  result: 'ok' | 'denied' | 'error',
  error?: unknown,
  details?: Record<string, unknown>,
): Promise<void> {
  try {
    const actor = await resolveActor(deps.auth, req);
    await deps.audit.write({
      at: new Date().toISOString(),
      action,
      actor,
      ...(typeof req.ip === 'string' ? { ip: req.ip } : {}),
      ...(target.length > 0 ? { target: `machine:${target}` } : {}),
      result,
      ...(details === undefined && error === undefined
        ? {}
        : {
            details: {
              ...(details ?? {}),
              ...(error === undefined
                ? {}
                : { error: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) }),
            },
          }),
    });
  } catch {
    // audit 失败不影响主流程；审计轨道的实现负责写入日志。
  }
}

async function resolveActor(auth: AuthService, req: FastifyRequest): Promise<string> {
  const injected = (
    req as FastifyRequest & { mpanelAuth?: AuthContext; auth?: AuthContext }
  ).mpanelAuth ?? (req as FastifyRequest & { auth?: AuthContext }).auth;
  if (injected?.user?.username !== undefined) return injected.user.username;
  try {
    const context = await auth.authenticateOrNull(req);
    if (context !== null) return context.user.username;
  } catch {
    // 忽略：仅用于审计标识。
  }
  return 'unknown';
}
