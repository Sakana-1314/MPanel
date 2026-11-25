/**
 * 站点 API 模块（prefixes: ['/sites']）。
 *
 * - 草稿读写始终可用（JSON 存储）；apply/preview(validate) 依赖 Caddy 能力。
 * - 所有写操作先落盘站点存储，再显式 apply；PUT 不自动 apply。
 * - 根目录写前校验 MPANEL_SITES_ROOTS 白名单（文件根白名单同样约束 file_server）。
 */
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  PanelError,
  booleanQuerySchema,
  okEnvelope,
  siteApplyRequestSchema,
  siteCreateSchema,
  siteImportRequestSchema,
  sitePreviewRequestSchema,
  siteUpdateSchema,
} from '@mpanel/shared';
import type { FastifyInstance } from 'fastify';
import type {
  ModuleLogger,
  SiteApplyRequest,
  SiteConfig,
  SiteCreateInput,
  SiteImportRequest,
  SiteUpdateInput,
} from '@mpanel/shared';
import type { WorkerConfig } from '../../config.js';
import type { WorkerLogger } from '../../logger.js';
import type { WorkerModule } from '../../registry.js';
import { listResult, parsePage } from '../../util.js';
import { createSiteStore } from './store.js';
import type { SiteStore } from './store.js';
import { createCaddyClient } from './caddy.js';
import { createSiteApplyService } from './apply.js';
import type { SiteApplyService } from './apply.js';
import {
  assertDistinctDomains,
  renderSiteConfig,
  validateSiteRoot,
} from './caddyfile.js';

interface ValidationIssue {
  path: readonly PropertyKey[];
  code: string;
  message: string;
}

interface SafeParseSchema<T> {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: readonly ValidationIssue[] } };
}

function parseInput<T>(
  schema: SafeParseSchema<T>,
  value: unknown,
  message = '请求参数校验失败',
): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new PanelError('BAD_REQUEST', message, {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.map((segment) => String(segment)).join('.'),
        code: issue.code,
        message: issue.message,
      })),
    });
  }
  return result.data;
}

function parseBooleanQuery(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  const parsed = booleanQuerySchema.safeParse(value);
  if (!parsed.success) {
    throw new PanelError('BAD_REQUEST', `${field} 只接受 true/false/1/0`, { field });
  }
  return parsed.data;
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      offset?: unknown;
    };
    return typeof parsed.offset === 'number' &&
      Number.isInteger(parsed.offset) &&
      parsed.offset >= 0
      ? parsed.offset
      : 0;
  } catch {
    return 0;
  }
}

async function realpathOrResolve(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    return path.resolve(target);
  }
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  const normalized = process.platform === 'win32' ? relative.toLowerCase() : relative;
  if (normalized === '') return true;
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) return false;
  return true;
}

/**
 * file_server.root 必须落在 MPANEL_SITES_ROOTS 白名单内（architecture §6.3）。
 * 目录存在时用 realpath 比较，避免符号链接逃逸；不存在时退回词法比较。
 */
async function assertRootAllowed(config: WorkerConfig, siteConfig: SiteConfig): Promise<void> {
  if (siteConfig.handler.type !== 'file_server') return;
  const root = siteConfig.handler.root;
  validateSiteRoot(root);
  const allowedRoots = config.caddy.sitesRoots.filter((entry) => entry.trim().length > 0);
  if (allowedRoots.length === 0) return;
  const rootReal = await realpathOrResolve(root);
  for (const allowed of allowedRoots) {
    if (isInside(await realpathOrResolve(allowed), rootReal)) return;
  }
  throw new PanelError('BAD_REQUEST', '站点根目录不在 MPANEL_SITES_ROOTS 允许范围内', {
    root,
    allowedRoots,
    hint: '在 MPANEL_SITES_ROOTS 中加入该目录后重试',
  });
}

/** 写入前的结构校验：域名唯一性、完整生成一次、根目录白名单。 */
async function validateConfigForWrite(
  config: WorkerConfig,
  siteConfig: SiteConfig,
): Promise<void> {
  assertDistinctDomains(siteConfig.domains);
  renderSiteConfig(siteConfig);
  await assertRootAllowed(config, siteConfig);
}

function asWorkerLogger(logger: ModuleLogger): WorkerLogger {
  const candidate = logger as Partial<WorkerLogger>;
  if (typeof candidate.child === 'function') return candidate as WorkerLogger;
  const adapter: WorkerLogger = {
    debug: (message, details) => logger.debug(message, details),
    info: (message, details) => logger.info(message, details),
    warn: (message, details) => logger.warn(message, details),
    error: (message, details) => logger.error(message, details),
    child: () => adapter,
  };
  return adapter;
}

export interface SitesRouteDeps {
  store: SiteStore;
  applyService: SiteApplyService;
  config: WorkerConfig;
  logger: ModuleLogger;
}

export async function registerSiteRoutes(
  app: FastifyInstance,
  deps: SitesRouteDeps,
): Promise<void> {
  const { store, applyService, config } = deps;

  app.get('/sites', async (req) => {
    const query = (req.query ?? {}) as Record<string, unknown>;
    const enabledFilter = parseBooleanQuery(query.enabled, 'enabled');
    const search = typeof query.q === 'string' ? query.q.trim().toLowerCase() : '';
    const { limit, cursor } = parsePage({
      limit: query.limit,
      cursor: typeof query.cursor === 'string' ? query.cursor : undefined,
    });

    const sites = await store.list();
    const filtered = sites.filter((site) => {
      if (enabledFilter !== undefined && site.enabled !== enabledFilter) return false;
      if (search.length === 0) return true;
      if (site.name.toLowerCase().includes(search)) return true;
      return site.config.domains.some((domain) => domain.toLowerCase().includes(search));
    });
    filtered.sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
    );
    const offset = decodeCursor(cursor);
    const items = filtered.slice(offset, offset + limit);
    const nextCursor = offset + limit < filtered.length ? encodeCursor(offset + limit) : null;
    return okEnvelope(listResult(items, { nextCursor, total: filtered.length }));
  });

  app.get('/sites/export', async () => okEnvelope(await store.exportBundle()));

  app.post('/sites/preview', async (req) => {
    const request = parseInput(sitePreviewRequestSchema, req.body);
    if (request.site) await validateConfigForWrite(config, request.site);
    return okEnvelope(await applyService.preview(request));
  });

  app.post('/sites/apply', async (req) => {
    // 空 body 等价于“全量应用”，与契约的 { siteIds?, force? } 保持一致。
    const request = parseInput(siteApplyRequestSchema, req.body ?? {}) as SiteApplyRequest;
    return okEnvelope(await applyService.apply(request));
  });

  app.post('/sites/import', async (req) => {
    const request = parseInput(siteImportRequestSchema, req.body) as SiteImportRequest;
    // 先整体校验再写入：任何无效配置都不得部分落盘（api-contract §6.5）。
    const seenNames = new Set<string>();
    for (const item of request.bundle.sites) {
      const name = item.name.trim();
      if (name.length === 0) {
        throw new PanelError('BAD_REQUEST', '导入包中的站点名称不能为空', {
          field: 'name',
          value: item.name,
        });
      }
      const key = name.toLowerCase();
      if (seenNames.has(key)) {
        throw new PanelError('BAD_REQUEST', '导入包中的站点名称重复', {
          field: 'name',
          value: name,
        });
      }
      seenNames.add(key);
      await validateConfigForWrite(config, item.config);
    }
    return okEnvelope(await store.importBundle(request.bundle, request.mode ?? 'merge'));
  });

  app.post('/sites', async (req, reply) => {
    const input = parseInput<SiteCreateInput>(siteCreateSchema, req.body);
    await validateConfigForWrite(config, input.config);
    const site = await store.create(input);
    return reply.code(201).send(okEnvelope(site));
  });

  app.get('/sites/:id', async (req) => {
    const { id } = req.params as { id: string };
    const site = await store.get(id);
    if (!site) {
      throw new PanelError('NOT_FOUND', '站点不存在', { resource: 'site', id });
    }
    return okEnvelope(site);
  });

  app.put('/sites/:id', async (req) => {
    const { id } = req.params as { id: string };
    const input = parseInput<SiteUpdateInput>(siteUpdateSchema, req.body);
    if (input.config) await validateConfigForWrite(config, input.config);
    return okEnvelope(await store.update(id, input));
  });

  app.delete('/sites/:id', async (req) => {
    const { id } = req.params as { id: string };
    await store.remove(id);
    return okEnvelope({ deleted: true, pendingApply: true });
  });
}

/** Sites API module. prefixes: ['/sites']. */
export function createSitesModule(): WorkerModule {
  return {
    name: 'sites',
    prefixes: ['/sites'],
    requires: ['caddy'],
    async register(ctx): Promise<void> {
      const logger = asWorkerLogger(ctx.logger);
      const store = createSiteStore(
        path.join(ctx.config.home, 'state', 'sites.json'),
        ctx.logger,
      );
      const caddy = createCaddyClient(ctx.config, ctx.runner);
      const applyService = createSiteApplyService({
        config: ctx.config,
        store,
        caddy,
        runner: ctx.runner,
        logger,
      });
      await registerSiteRoutes(ctx.app, {
        store,
        applyService,
        config: ctx.config,
        logger: ctx.logger,
      });
    },
  };
}
