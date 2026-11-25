import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import { PanelError, booleanQuerySchema, fileUploadQuerySchema, isPanelError, okEnvelope } from '@mpanel/shared';
import type { FileService } from './fs.js';
import { mapFsError } from './sandbox.js';

export interface UploadRouteOptions {
  maxUploadBytes?: number;
}

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

function formatMiB(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MiB`;
}

function mapUploadError(error: unknown, maxBytes: number): PanelError {
  if (isPanelError(error)) return error;
  const record = error as { code?: unknown; name?: unknown; message?: unknown };
  const code = typeof record.code === 'string' ? record.code : '';
  const name = typeof record.name === 'string' ? record.name : '';
  const message = typeof record.message === 'string' ? record.message : '';
  if (
    code === 'FST_REQ_FILE_TOO_LARGE' ||
    code === 'FST_ERR_CTP_BODY_TOO_LARGE' ||
    name.includes('RequestFileTooLarge') ||
    /file size limit/i.test(message)
  ) {
    return new PanelError('BAD_REQUEST', `上传文件超过上限（${formatMiB(maxBytes)}）`, {
      hint: '请压缩或拆分文件后重试',
    });
  }
  if (
    code === 'FST_FILES_LIMIT' ||
    code === 'FST_PARTS_LIMIT' ||
    code === 'FST_FIELDS_LIMIT' ||
    code === 'FST_INVALID_MULTIPART_CONTENT_TYPE'
  ) {
    return new PanelError('BAD_REQUEST', '上传请求格式不合法（仅支持单文件字段 file）');
  }
  return mapFsError(error, '上传文件');
}

/**
 * POST /files/upload 的唯一注册者：@fastify/multipart 单字段 `file`，
 * 临时文件 + rename，单文件与总大小受 config.files.maxUploadBytes 限制。
 */
export async function registerUploadRoute(
  app: FastifyInstance,
  service: FileService,
  opts: UploadRouteOptions = {},
): Promise<void> {
  const maxBytes = Math.max(
    1,
    Math.floor(opts.maxUploadBytes ?? service.maxUploadBytes ?? 100 * 1024 * 1024),
  );
  if (!app.hasRequestDecorator('isMultipart')) {
    app.register(multipart, {
      limits: { fileSize: maxBytes, files: 1, fields: 4, parts: 8 },
    });
  }

  app.post(
    '/files/upload',
    { bodyLimit: maxBytes + 1024 * 1024 },
    async (request, reply) => {
      let part: Awaited<ReturnType<typeof request.file>> = undefined;
      try {
        if (typeof request.isMultipart !== 'function' || !request.isMultipart()) {
          throw new PanelError('BAD_REQUEST', '上传请求必须是 multipart/form-data', {
            hint: '使用字段名 file 上传单个文件',
          });
        }
        const rawQuery = (
          typeof request.query === 'object' && request.query !== null ? request.query : {}
        ) as Record<string, unknown>;
        const query = parseOrThrow(
          fileUploadQuerySchema,
          rawQuery,
          '上传参数',
        );
        let createParents = false;
        if (rawQuery.createParents !== undefined) {
          const parsed = booleanQuerySchema.safeParse(rawQuery.createParents);
          if (!parsed.success) {
            throw new PanelError('BAD_REQUEST', 'createParents 必须是 true/false/1/0');
          }
          createParents = parsed.data;
        }
        const uploadedPart = await request.file({
          limits: { fileSize: maxBytes, files: 1, fields: 4, parts: 8 },
        });
        part = uploadedPart;
        if (uploadedPart === undefined) {
          throw new PanelError('BAD_REQUEST', '缺少 multipart 字段 file', {
            hint: '使用字段名 file 上传单个文件',
          });
        }
        if (uploadedPart.fieldname !== 'file') {
          uploadedPart.file.resume();
          throw new PanelError('BAD_REQUEST', '仅支持单文件字段 file');
        }
        if (uploadedPart.file.truncated) {
          throw new PanelError('BAD_REQUEST', `上传文件超过上限（${formatMiB(maxBytes)}）`, {
            hint: '请压缩或拆分文件后重试',
          });
        }
        const item = await service.upload(
          query.root,
          query.path,
          uploadedPart.filename,
          uploadedPart.file,
          { overwrite: query.overwrite === true, createParents },
        );
        reply.code(201);
        return okEnvelope(item);
      } catch (error) {
        if (part !== undefined && !part.file.destroyed) {
          part.file.resume();
        }
        throw mapUploadError(error, maxBytes);
      }
    },
  );
}
