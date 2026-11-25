import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ServerResponse } from 'node:http';
import {
  badRequest,
  booleanQuerySchema,
  containerActionSchema,
  containerLogsQuerySchema,
  execRequestSchema,
  imagePruneRequestSchema,
  imagePullRequestSchema,
  isPanelError,
  okEnvelope,
  pageQuerySchema,
  PanelError,
  stackActionSchema,
  stackCreateSchema,
  stackUpdateSchema,
  type CapabilityProvider,
} from '@mpanel/shared';
import type { WorkerModule } from '../../registry.js';
import { listResult, unavailableList } from '../../util.js';
import {
  createDockerClient,
  decodeCursor,
  paginateAscending,
  type ContainerLogsOptions,
} from './docker.js';
import {
  createContainerService,
  normalizeLogsOptions,
  type ContainerService,
} from './containers.js';
import { createImageService, type ImageService } from './images.js';
import { createStackService, type StackService } from './stacks.js';
import { registerContainerLogsWs } from './logs.js';

type ParserResult<T> =
  | { success: true; data: T }
  | { success: false; error: { issues: unknown } };

interface SafeParser<T> {
  safeParse(value: unknown): ParserResult<T>;
}

type IdParams = { Params: { id: string } };
type NameParams = { Params: { name: string } };

/** 容器、镜像与 Compose 栈模块；全部路径在同一个 register() 内注册。 */
export function createContainersModule(): WorkerModule {
  return {
    name: 'containers',
    prefixes: ['/containers', '/images', '/stacks'],
    requires: ['docker'],
    register(context) {
      const docker = createDockerClient(context.config, context.runner, context.logger);
      const containers = createContainerService(docker);
      const images = createImageService(docker);
      const stacks = createStackService(docker, context.config);
      registerContainerLogsWs(context.wsBridge, containers);
      registerRoutes(context.capabilities, context.app, containers, images, stacks);
    },
  };
}

function registerRoutes(
  capability: CapabilityProvider,
  app: FastifyInstance,
  containers: ContainerService,
  images: ImageService,
  stacks: StackService,
): void {

  /* ------------------------------ 容器 ------------------------------ */

  app.get('/containers', async (req, reply) => {
    const q = queryRecord(req);
    const page = parsePageQuery(req);
    const all = optionalBoolean(q.all, 'all');
    const status = optionalQueryString(q.status, 'status');
    const search = optionalQueryString(q.q, 'q');
    const result = await containers.list({
      ...page,
      ...(all !== undefined ? { all } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(search !== undefined ? { q: search } : {}),
    });
    return reply.send(okEnvelope(result));
  });

  app.get<IdParams>('/containers/:id', async (req, reply) => {
    const detail = await containers.get(req.params.id);
    return reply.send(okEnvelope(detail));
  });

  app.post<IdParams>('/containers/:id/start', async (req, reply) => {
    await requireDocker(capability);
    const action = containers.action(req.params.id, 'start');
    return reply.send(okEnvelope(await action));
  });

  app.post<IdParams>('/containers/:id/stop', async (req, reply) => {
    await requireDocker(capability);
    const body = parseOptionalBody(containerActionSchema, req.body, '停止参数');
    const result = await containers.action(req.params.id, 'stop', {
      timeoutSec: body.timeoutSec,
    });
    return reply.send(okEnvelope(result));
  });

  app.post<IdParams>('/containers/:id/restart', async (req, reply) => {
    await requireDocker(capability);
    const body = parseOptionalBody(containerActionSchema, req.body, '重启参数');
    const result = await containers.action(req.params.id, 'restart', {
      timeoutSec: body.timeoutSec,
    });
    return reply.send(okEnvelope(result));
  });

  app.delete<IdParams>('/containers/:id', async (req, reply) => {
    await requireDocker(capability);
    const q = queryRecord(req);
    const force = optionalBoolean(q.force, 'force');
    const removeVolumes = optionalBoolean(q.removeVolumes, 'removeVolumes');
    const result = await containers.remove(req.params.id, { force, removeVolumes });
    return reply.send(okEnvelope(result));
  });

  app.get<IdParams>('/containers/:id/logs', async (req, reply) => {
    const options = parseLogsQuery(req, false);
    const result = await containers.logs(req.params.id, options);
    return reply.send(okEnvelope(result));
  });

  app.get<IdParams>('/containers/:id/stats', async (req, reply) => {
    const stats = await containers.stats(req.params.id);
    return reply.send(okEnvelope({ stats }));
  });

  app.post<IdParams>('/containers/:id/exec', async (req, reply) => {
    await requireDocker(capability);
    const input = parseBody(execRequestSchema, req.body, 'exec 请求');
    const result = await containers.exec(req.params.id, input);
    return reply.send(okEnvelope(result));
  });

  app.post('/containers/prune', async (req, reply) => {
    await requireDocker(capability);
    const result = await containers.prune();
    return reply.send(okEnvelope(result));
  });

  /* ------------------------------ 镜像 ------------------------------ */

  app.get('/images', async (req, reply) => {
    const q = queryRecord(req);
    const page = parsePageQuery(req);
    const all = optionalBoolean(q.all, 'all');
    const dangling = optionalBoolean(q.dangling, 'dangling');
    const search = optionalQueryString(q.q, 'q');
    const result = await images.list({
      ...page,
      ...(all !== undefined ? { all } : {}),
      ...(dangling !== undefined ? { dangling } : {}),
      ...(search !== undefined ? { q: search } : {}),
    });
    return reply.send(okEnvelope(result));
  });

  app.post('/images/pull', async (req, reply) => {
    await requireDocker(capability);
    const input = parseBody(imagePullRequestSchema, req.body, '镜像拉取参数');
    const result = await images.pull(input.reference);
    return reply.send(okEnvelope(result));
  });

  app.post('/images/prune', async (req, reply) => {
    await requireDocker(capability);
    const input = parseOptionalBody(imagePruneRequestSchema, req.body, '镜像清理参数');
    const result = await images.prune({ danglingOnly: input.danglingOnly });
    return reply.send(okEnvelope(result));
  });

  app.delete<IdParams>('/images/:id', async (req, reply) => {
    await requireDocker(capability);
    const force = optionalBoolean(queryRecord(req).force, 'force');
    const result = await images.remove(req.params.id, force);
    return reply.send(okEnvelope(result));
  });

  /* ------------------------------ 栈 -------------------------------- */

  app.get('/stacks', async (req, reply) => {
    const page = parsePageQuery(req);
    let all;
    try {
      all = await stacks.list();
    } catch (error) {
      if (isPanelError(error) && error.code === 'UNAVAILABLE') {
        return reply.send(okEnvelope(unavailableList(error.message)));
      }
      throw error;
    }
    const cursor = decodeCursor(page.cursor);
    const paged = paginateAscending(all, cursor, (stack) => stack.name, page.limit ?? 50);
    return reply.send(
      okEnvelope(
        listResult(paged.items, {
          nextCursor: paged.nextCursor,
          total: all.length,
        }),
      ),
    );
  });

  app.post('/stacks', async (req, reply) => {
    await requireDocker(capability);
    const input = parseBody(stackCreateSchema, req.body, '栈创建参数');
    const detail = await stacks.create(input);
    return reply.code(201).send(okEnvelope(detail));
  });

  app.get<NameParams>('/stacks/:name', async (req, reply) => {
    const detail = await stacks.get(req.params.name);
    return reply.send(okEnvelope(detail));
  });

  app.put<NameParams>('/stacks/:name', async (req, reply) => {
    await requireDocker(capability);
    const input = parseBody(stackUpdateSchema, req.body, '栈更新参数');
    const detail = await stacks.update(req.params.name, input);
    return reply.send(okEnvelope(detail));
  });

  app.delete<NameParams>('/stacks/:name', async (req, reply) => {
    await requireDocker(capability);
    const force = optionalBoolean(queryRecord(req).force, 'force');
    const result = await stacks.remove(req.params.name, force);
    return reply.send(okEnvelope(result));
  });

  app.post<NameParams>('/stacks/:name/up', async (req, reply) => {
    await requireDocker(capability);
    const input = parseOptionalBody(stackActionSchema, req.body, '栈启动参数');
    const result = await stacks.up(req.params.name, input);
    return reply.send(okEnvelope(result));
  });

  app.post<NameParams>('/stacks/:name/down', async (req, reply) => {
    await requireDocker(capability);
    const input = parseOptionalBody(stackActionSchema, req.body, '栈停止参数');
    const result = await stacks.down(req.params.name, input);
    return reply.send(okEnvelope(result));
  });

  app.post<NameParams>('/stacks/:name/restart', async (req, reply) => {
    await requireDocker(capability);
    const result = await stacks.restart(req.params.name);
    return reply.send(okEnvelope(result));
  });

  app.post<NameParams>('/stacks/:name/pull', async (req, reply) => {
    await requireDocker(capability);
    const result = await stacks.pull(req.params.name);
    return reply.send(okEnvelope(result));
  });

  app.get<NameParams>('/stacks/:name/logs', async (req, reply) => {
    const options = parseLogsQuery(req, false);
    const result = await stacks.logsText(req.params.name, options);
    return reply.send(okEnvelope(result));
  });

  app.get<NameParams>('/stacks/:name/logs/stream', async (req, reply) => {
    const options = parseLogsQuery(req, true);
    const controller = new AbortController();
    const source = await stacks.logs(req.params.name, {
      ...options,
      signal: controller.signal,
    });
    const iterator = source[Symbol.asyncIterator]();
    reply.hijack();
    const res = reply.raw;
    let closed = false;
    const finish = (): void => {
      if (closed) return;
      closed = true;
      controller.abort();
      void Promise.resolve(iterator.return?.()).catch(() => undefined);
      try {
        res.end();
      } catch {
        // 客户端已断开。
      }
    };
    req.raw.on('close', finish);
    res.on('close', finish);
    res.on('error', finish);
    try {
      if (res.destroyed || req.raw.destroyed) {
        finish();
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      for (;;) {
        const next = await iterator.next();
        if (closed) break;
        if (next.done === true) break;
        const entry = next.value;
        const payload = JSON.stringify({
          stream: entry.stream,
          container: entry.container,
          data: entry.data,
          ...(entry.ts !== undefined ? { ts: entry.ts } : {}),
        });
        if (!res.write(`event: log\ndata: ${payload}\n\n`)) {
          await waitForDrain(res, () => closed);
          if (closed) break;
        }
      }
      if (!closed) {
        res.write('event: end\ndata: {}\n\n');
      }
    } catch (error) {
      if (!closed) {
        const code = isPanelError(error) ? error.code : 'INTERNAL';
        const message = error instanceof Error ? error.message : '日志流内部错误';
        try {
          res.write(`event: error\ndata: ${JSON.stringify({ code, message })}\n\n`);
        } catch {
          // 客户端已断开。
        }
      }
    } finally {
      finish();
    }
  });

  app.get<NameParams>('/stacks/:name/file', async (req, reply) => {
    const detail = await stacks.get(req.params.name);
    return reply.send(
      okEnvelope({ path: detail.composePath, content: detail.composeYaml }),
    );
  });

  app.put<NameParams>('/stacks/:name/file', async (req, reply) => {
    await requireDocker(capability);
    const input = parseBody(stackUpdateSchema, req.body, '栈文件参数');
    const detail = await stacks.update(req.params.name, input);
    return reply.send(okEnvelope(detail));
  });
}

/* ------------------------------------------------------------------ */
/* 请求解析辅助                                                        */
/* ------------------------------------------------------------------ */

/** 请求时的 docker 能力闸门；写操作缺能力一律 UNAVAILABLE（带可执行 hint）。 */
async function requireDocker(provider: CapabilityProvider): Promise<void> {
  const capabilities = await provider.get();
  const status = capabilities.docker;
  if (status.available) return;
  throw new PanelError('UNAVAILABLE', `Docker 不可用${status.reason ? `: ${status.reason}` : ''}`, {
    capability: 'docker',
    reason: status.reason,
    hint: '请安装 Docker CLI 并启动 daemon（Linux: sudo systemctl start docker；Windows/macOS: 启动 Docker Desktop），或设置 MPANEL_DOCKER_BIN 指向 docker 可执行文件。',
  });
}

function queryRecord(req: FastifyRequest): Record<string, unknown> {
  const query: unknown = req.query;
  return typeof query === 'object' && query !== null
    ? (query as Record<string, unknown>)
    : {};
}

function parsePageQuery(req: FastifyRequest): { limit?: number; cursor?: string } {
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

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  const parsed = booleanQuerySchema.safeParse(value);
  if (!parsed.success) {
    throw badRequest(`${field} 必须是 true/false/1/0`, { field });
  }
  return parsed.data;
}

function optionalQueryString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value;
  throw badRequest(`${field} 必须是字符串`, { field });
}

function parseLogsQuery(req: FastifyRequest, followDefault: boolean): ContainerLogsOptions {
  const q = queryRecord(req);
  const parsed = containerLogsQuerySchema.safeParse({
    ...q,
    follow: q.follow ?? (followDefault ? '1' : '0'),
    tail: q.tail ?? '200',
  });
  if (!parsed.success) {
    throw badRequest('日志参数无效', { issues: parsed.error.issues });
  }
  return normalizeLogsOptions(parsed.data);
}

function waitForDrain(res: ServerResponse, isClosed: () => boolean): Promise<void> {
  if (isClosed()) return Promise.resolve();
  return new Promise<void>((resolveWait) => {
    const done = (): void => {
      res.off('drain', done);
      res.off('close', done);
      resolveWait();
    };
    res.once('drain', done);
    res.once('close', done);
  });
}
