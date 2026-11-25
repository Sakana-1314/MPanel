/**
 * 证书 API 模块（只读，prefixes: ['/certs']）。
 *
 * 可用性取决于 Caddy data 目录是否可读，与 caddy 二进制是否存在无关。
 * 契约只有 GET /certs 与 GET /certs/:id；不提供续期/删除/手工导入。
 */
import {
  booleanQuerySchema,
  certificateStatusSchema,
  okEnvelope,
  PanelError,
} from '@mpanel/shared';
import type { CertificateInfo, CertificateStatus, ModuleLogger } from '@mpanel/shared';
import type { FastifyInstance } from 'fastify';
import type { WorkerLogger } from '../../logger.js';
import type { WorkerModule } from '../../registry.js';
import { listResult, parsePage, unavailableList } from '../../util.js';
import { scanCertificates } from './scan.js';

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

function matchesDomain(certificate: CertificateInfo, needle: string): boolean {
  if (needle.length === 0) return true;
  if (certificate.commonName?.toLowerCase().includes(needle)) return true;
  return certificate.domains.some((domain) => domain.toLowerCase().includes(needle));
}

export interface CertRoutesDeps {
  dataDir: string;
  logger: WorkerLogger;
}

export async function registerCertRoutes(
  app: FastifyInstance,
  deps: CertRoutesDeps,
): Promise<void> {
  const { dataDir, logger } = deps;

  app.get('/certs', async (req) => {
    const query = (req.query ?? {}) as Record<string, unknown>;
    const domainFilter = typeof query.domain === 'string' ? query.domain.trim().toLowerCase() : '';
    let statusFilter: CertificateStatus | undefined;
    if (query.status !== undefined) {
      const parsed = certificateStatusSchema.safeParse(query.status);
      if (!parsed.success) {
        throw new PanelError('BAD_REQUEST', 'status 过滤值不合法', {
          field: 'status',
          allowed: certificateStatusSchema.options,
        });
      }
      statusFilter = parsed.data;
    }
    const includeExpired = parseBooleanQuery(query.includeExpired, 'includeExpired') ?? true;
    const { limit, cursor } = parsePage({
      limit: query.limit,
      cursor: typeof query.cursor === 'string' ? query.cursor : undefined,
    });

    const scan = await scanCertificates(dataDir, logger);
    if (!scan.available) {
      return okEnvelope(unavailableList<CertificateInfo>(scan.reason ?? 'Caddy 数据目录不可用'));
    }

    const filtered = scan.items.filter((certificate) => {
      if (!includeExpired && certificate.status === 'expired') return false;
      if (statusFilter !== undefined && certificate.status !== statusFilter) return false;
      return matchesDomain(certificate, domainFilter);
    });
    const offset = decodeCursor(cursor);
    const items = filtered.slice(offset, offset + limit);
    const nextCursor = offset + limit < filtered.length ? encodeCursor(offset + limit) : null;
    return okEnvelope(listResult(items, { nextCursor, total: filtered.length }));
  });

  app.get('/certs/:id', async (req) => {
    const { id } = req.params as { id: string };
    const scan = await scanCertificates(dataDir, logger);
    if (!scan.available) {
      throw new PanelError('UNAVAILABLE', '证书目录不可用', {
        reason: scan.reason,
        hint:
          scan.reason ??
          '设置 MPANEL_CADDY_DATA_DIR 指向 Caddy 的 data 目录，并确保 worker 用户可读。',
      });
    }
    const certificate = scan.items.find((item) => item.id === id);
    if (!certificate) {
      throw new PanelError('NOT_FOUND', '证书不存在', { resource: 'certificate', id });
    }
    return okEnvelope(certificate);
  });
}

/** Certificates API module (read-only). prefixes: ['/certs']. */
export function createCertsModule(): WorkerModule {
  return {
    name: 'certs',
    prefixes: ['/certs'],
    async register(ctx): Promise<void> {
      await registerCertRoutes(ctx.app, {
        dataDir: ctx.config.caddy.dataDir,
        logger: asWorkerLogger(ctx.logger),
      });
    },
  };
}
