import { hostname, arch, platform } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  PanelError,
  allCapabilitiesUnavailable,
  okEnvelope,
} from '@mpanel/shared';
import type { Machine, MachineCounts, SystemInfo, SystemOverview } from '@mpanel/shared';
import type { CoreConfig } from './config.js';
import type { MachineService } from './machines/service.js';
import type { AuditEvent } from './audit.js';
import { readJsonlTail } from './store.js';
import { asRecord, asString } from './auth/types.js';

/** 与 server/core/package.json 保持一致；避免把 package.json 打进 rootDir。 */
export const CORE_VERSION = '0.1.0';

const CORE_STARTED_AT = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();
const CORE_CAPABILITY_REASON = 'feature capabilities are provided by workers';

export async function registerSystemRoutes(
  app: FastifyInstance,
  deps: { config: CoreConfig; machines: MachineService },
): Promise<void> {
  const { config, machines } = deps;

  app.get('/system/info', async () => okEnvelope(buildCoreSystemInfo(config)));

  app.get('/system/overview', async () =>
    okEnvelope(await buildSystemOverview(config, machines, () => machines.listAll())));

  /*
   * 审计查询：读取 state/audit.jsonl 尾部，按 offset/limit 分页。
   * cursor 是本实现的不透明 offset（字符串），客户端不得解析。
   * 审计记录只追加，offset 分页在并发写入时可能轻微漂移，v1 可接受。
   */
  app.get('/system/audit', async (req) => {
    const query = asRecord(req.query) ?? {};
    const limitRaw = asString(query.limit);
    const cursorRaw = asString(query.cursor);
    const limit = limitRaw === undefined ? 50 : Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new PanelError('BAD_REQUEST', 'limit 必须是 1-200 的整数', {
        issues: [{ path: 'limit', code: 'invalid_number', message: 'limit 必须是 1-200 的整数' }],
      });
    }
    let offset = 0;
    if (cursorRaw !== undefined && cursorRaw !== '') {
      offset = Number(cursorRaw);
      if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) {
        throw new PanelError('BAD_REQUEST', 'cursor 无效', {
          issues: [{ path: 'cursor', code: 'invalid_cursor', message: 'cursor 无效或已过期' }],
        });
      }
    }

    const file = join(config.home, 'audit.jsonl');
    // readJsonlTail 返回窗口内的「旧 → 新」记录；查询接口统一按新到旧输出。
    const tail = await readJsonlTail<AuditEvent>(
      file,
      Math.min(offset + limit + 1, 100_000),
    );
    const newestFirst = [...tail].reverse();
    const items = newestFirst.slice(offset, offset + limit);
    const nextCursor = newestFirst.length > offset + limit ? String(offset + limit) : null;
    return okEnvelope({
      available: true,
      items,
      nextCursor,
    });
  });
}

export function buildCoreSystemInfo(config: CoreConfig): SystemInfo {
  return {
    role: 'core',
    name: 'mpanel-core',
    version: CORE_VERSION,
    apiVersion: 1,
    protocolVersion: 1,
    nodeVersion: process.version,
    platform: platform(),
    arch: arch(),
    hostname: hostname(),
    startedAt: CORE_STARTED_AT,
    uptimeSec: Math.max(0, Math.round(process.uptime())),
    capabilities: allCapabilitiesUnavailable(CORE_CAPABILITY_REASON),
    features: {
      dbxHandoff: true,
      websocket: true,
      pty: false,
    },
    paths: {
      home: config.home,
    },
  };
}

/** Overview uses listAll; paginated machine routes use list. */
export async function buildSystemOverview(
  config: CoreConfig,
  machines: MachineService,
  listAll: () => Promise<Machine[]>,
): Promise<SystemOverview> {
  void machines;
  const workers = await listAll();
  const counts: MachineCounts = {
    total: workers.length,
    online: 0,
    offline: 0,
    starting: 0,
    degraded: 0,
    error: 0,
  };
  for (const machine of workers) {
    switch (machine.status) {
      case 'online':
        counts.online += 1;
        break;
      case 'offline':
        counts.offline += 1;
        break;
      case 'starting':
        counts.starting += 1;
        break;
      case 'degraded':
        counts.degraded += 1;
        break;
      case 'error':
        counts.error += 1;
        break;
      default:
        break;
    }
  }
  return {
    core: buildCoreSystemInfo(config),
    machines: counts,
    workers,
    generatedAt: new Date().toISOString(),
  };
}
