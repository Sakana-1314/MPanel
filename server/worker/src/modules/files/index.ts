import type { FastifyInstance } from 'fastify';
import {
  PanelError,
  booleanQuerySchema,
  fileArchiveRequestSchema,
  fileChmodRequestSchema,
  fileCopyRequestSchema,
  fileDeleteQuerySchema,
  fileDownloadQuerySchema,
  fileExtractRequestSchema,
  fileMkdirRequestSchema,
  filePathSchema,
  fileRenameRequestSchema,
  fileRootNameSchema,
  fileSearchQuerySchema,
  fileWriteRequestSchema,
  okEnvelope,
  pageQuerySchema,
  trashEmptyRequestSchema,
  trashRestoreRequestSchema,
} from '@mpanel/shared';
import type { WorkerModule, WorkerModuleContext } from '../../registry.js';
import { createArchiveService } from './archive.js';
import type { ArchiveService } from './archive.js';
import {
  MAX_WRITE_BYTES,
  buildContentDisposition,
  createFileService,
  guessMimeType,
} from './fs.js';
import type { FileService } from './fs.js';
import { createSearchService } from './search.js';
import type { SearchService } from './search.js';
import { createFileSandbox } from './sandbox.js';
import { createTrashService } from './trash.js';
import type { TrashService } from './trash.js';
import { registerUploadRoute } from './upload.js';

interface ParseIssue {
  path?: unknown[];
  message?: string;
}

interface Parser<T> {
  safeParse(
    input: unknown,
  ): { success: true; data: T } | { success: false; error: unknown };
}

function parseOrThrow<T>(schema: Parser<T>, input: unknown, label: string): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issues = (result.error as { issues?: ParseIssue[] }).issues ?? [];
  const detail = issues
    .map((issue) => {
      const where = (issue.path ?? []).map((part) => String(part)).join('.');
      return `${where.length > 0 ? where : label}: ${issue.message ?? '非法值'}`;
    })
    .join('; ');
  throw new PanelError('BAD_REQUEST', `${label}不合法${detail.length > 0 ? `：${detail}` : ''}`);
}

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

/** Fastify 的 query 均为字符串；允许直接传 boolean 的调用方也能被 query schema 接受。 */
function normalizeQuery(value: unknown): Record<string, unknown> {
  const record = toRecord(value);
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    result[key] = typeof entry === 'boolean' ? (entry ? 'true' : 'false') : entry;
  }
  return result;
}

function parseOptionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  const parsed = booleanQuerySchema.safeParse(value);
  if (!parsed.success) {
    throw new PanelError('BAD_REQUEST', `${name} 必须是 true/false/1/0`);
  }
  return parsed.data;
}

interface ListQuery {
  root: string;
  path?: string;
  showHidden?: boolean;
  limit?: number;
  cursor?: string;
}

function parseListQuery(raw: unknown): ListQuery {
  const record = toRecord(raw);
  const root = parseOrThrow(fileRootNameSchema, record.root, '文件根');
  let pathValue: string | undefined;
  if (record.path !== undefined && record.path !== '') {
    pathValue = parseOrThrow(filePathSchema, record.path, '路径');
  }
  const showHidden = parseOptionalBoolean(record.showHidden, 'showHidden');
  const page = parseOrThrow(pageQuerySchema, record, '分页');
  return { root, path: pathValue, showHidden, limit: page.limit, cursor: page.cursor };
}

interface ReadQuery {
  root: string;
  path: string;
  encoding?: 'utf8' | 'base64';
  maxBytes?: number;
}

function parseReadQuery(raw: unknown): ReadQuery {
  const record = toRecord(raw);
  const root = parseOrThrow(fileRootNameSchema, record.root, '文件根');
  const pathValue = parseOrThrow(filePathSchema, record.path, '路径');
  let encoding: 'utf8' | 'base64' | undefined;
  if (record.encoding !== undefined && record.encoding !== '') {
    if (record.encoding !== 'utf8' && record.encoding !== 'base64') {
      throw new PanelError('BAD_REQUEST', 'encoding 必须是 utf8 或 base64');
    }
    encoding = record.encoding;
  }
  let maxBytes: number | undefined;
  if (record.maxBytes !== undefined) {
    const value =
      typeof record.maxBytes === 'number' ? record.maxBytes : Number(record.maxBytes);
    if (!Number.isInteger(value) || value < 1 || value > 8 * 1024 * 1024) {
      throw new PanelError('BAD_REQUEST', 'maxBytes 必须在 1 到 8388608 之间');
    }
    maxBytes = value;
  }
  return { root, path: pathValue, encoding, maxBytes };
}

interface FilesRouteServices {
  files: FileService;
  trash: TrashService;
  archive: ArchiveService;
  search: SearchService;
}

export function registerFileRoutes(
  app: FastifyInstance,
  services: FilesRouteServices,
): void {
  const { files, trash, archive, search } = services;

  app.get('/files/roots', async () => {
    const roots = await files.roots();
    return okEnvelope({ available: true, items: roots, total: roots.length });
  });

  app.get('/files/list', async (request) => {
    return okEnvelope(await files.list(parseListQuery(request.query)));
  });

  app.get('/files/stat', async (request) => {
    const query = toRecord(request.query);
    const root = parseOrThrow(fileRootNameSchema, query.root, '文件根');
    const pathValue = parseOrThrow(filePathSchema, query.path, '路径');
    return okEnvelope(await files.stat({ root, path: pathValue }));
  });

  app.get('/files/read', async (request) => {
    return okEnvelope(await files.read(parseReadQuery(request.query)));
  });

  app.put(
    '/files/write',
    { bodyLimit: MAX_WRITE_BYTES },
    async (request) => {
      const rawBody = toRecord(request.body);
      const body = parseOrThrow(fileWriteRequestSchema, rawBody, '写入参数');
      const createBackup = parseOptionalBoolean(rawBody.createBackup, 'createBackup') === true;
      return okEnvelope(await files.write(body, { createBackup }));
    },
  );

  app.post('/files/mkdir', async (request) => {
    const body = parseOrThrow(fileMkdirRequestSchema, request.body, '创建目录参数');
    return okEnvelope(await files.mkdir(body));
  });

  app.post('/files/rename', async (request) => {
    const body = parseOrThrow(fileRenameRequestSchema, request.body, '重命名参数');
    return okEnvelope(await files.rename(body));
  });

  app.post('/files/copy', async (request) => {
    const body = parseOrThrow(fileCopyRequestSchema, request.body, '复制参数');
    return okEnvelope(await files.copy(body));
  });

  app.post('/files/chmod', async (request) => {
    const body = parseOrThrow(fileChmodRequestSchema, request.body, '权限参数');
    return okEnvelope(await files.chmod(body));
  });

  app.delete('/files', async (request) => {
    const query = parseOrThrow(
      fileDeleteQuerySchema,
      normalizeQuery(request.query),
      '删除参数',
    );
    return okEnvelope(await files.delete(query));
  });

  app.get('/files/trash', async (request) => {
    const page = parseOrThrow(
      pageQuerySchema,
      normalizeQuery(request.query),
      '分页参数',
    );
    return okEnvelope(await trash.list(page));
  });

  app.post('/files/trash/restore', async (request) => {
    const body = parseOrThrow(
      trashRestoreRequestSchema,
      request.body,
      '恢复参数',
    );
    return okEnvelope(await trash.restore(body));
  });

  app.post('/files/trash/empty', async (request) => {
    const body = parseOrThrow(trashEmptyRequestSchema, request.body, '清空参数');
    return okEnvelope(await trash.empty(body));
  });

  app.get('/files/download', async (request, reply) => {
    const query = parseOrThrow(
      fileDownloadQuerySchema,
      normalizeQuery(request.query),
      '下载参数',
    );
    const header = request.headers.range;
    const range = typeof header === 'string' ? header : Array.isArray(header) ? header[0] : undefined;
    const payload = await files.download(query, { range });
    reply.code(payload.partial ? 206 : 200);
    reply.header('Content-Type', guessMimeType(payload.filename));
    reply.header('Content-Length', String(payload.length));
    reply.header('Content-Disposition', buildContentDisposition(payload.filename));
    reply.header('Cache-Control', 'no-store');
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Last-Modified', payload.mtime);
    if (payload.partial) {
      reply.header(
        'Content-Range',
        `bytes ${payload.start}-${payload.end}/${payload.size}`,
      );
    }
    return reply.send(payload.stream);
  });

  app.post('/files/archive', async (request) => {
    const body = parseOrThrow(fileArchiveRequestSchema, request.body, '打包参数');
    return okEnvelope(await archive.archive(body));
  });

  app.post('/files/extract', async (request) => {
    const body = parseOrThrow(fileExtractRequestSchema, request.body, '解压参数');
    return okEnvelope(await archive.extract(body));
  });

  app.get('/files/search', async (request) => {
    const query = parseOrThrow(
      fileSearchQuerySchema,
      normalizeQuery(request.query),
      '搜索参数',
    );
    return okEnvelope(await search.search(query));
  });
}

/**
 * Files API 模块：owning prefix `/files`。除 `/files/upload` 由 upload.ts
 * 独占注册外，其余端点都在本模块注册。
 */
export function createFilesModule(): WorkerModule {
  return {
    name: 'files',
    prefixes: ['/files'],
    requires: [],
    async register(context: WorkerModuleContext): Promise<void> {
      const sandbox = createFileSandbox(context.config, context.logger);
      const files = createFileService({
        config: context.config,
        paths: context.paths,
        logger: context.logger,
        sandbox,
      });
      const trash = createTrashService(context.config, sandbox);
      const archive = createArchiveService({
        config: context.config,
        paths: context.paths,
        logger: context.logger,
        runner: context.runner,
        sandbox,
      });
      const search = createSearchService({
        config: context.config,
        paths: context.paths,
        logger: context.logger,
        sandbox,
      });
      registerFileRoutes(context.app, { files, trash, archive, search });
      await registerUploadRoute(context.app, files, {
        maxUploadBytes: context.config.files?.maxUploadBytes,
      });
    },
  };
}
