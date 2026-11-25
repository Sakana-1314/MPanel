import {
  badRequest,
  isPanelError,
  type ContainerDetail,
  type ContainerStats,
  type ContainerSummary,
  type ExecRequest,
  type ExecResult,
  type ListResult,
  type PageQuery,
} from '@mpanel/shared';
import { listResult, parsePage, unavailableList } from '../../util.js';
import {
  assertContainerReference,
  assertExecRequest,
  decodeCursor,
  paginateDescending,
  truncateText,
  type ContainerLogsOptions,
  type DockerClient,
  type DockerLogEntry,
} from './docker.js';

export type ContainerAction = 'start' | 'stop' | 'restart';

/** 非流式日志单次最多返回 1 MiB。 */
export const MAX_LOG_BYTES = 1024 * 1024;
/** 未显式指定 tail 时的默认行数。 */
export const DEFAULT_LOG_TAIL = 200;

export interface ContainerService {
  list(
    q: PageQuery & { all?: boolean; status?: string; q?: string },
  ): Promise<ListResult<ContainerSummary>>;
  get(id: string): Promise<ContainerDetail>;
  action(
    id: string,
    action: ContainerAction,
    opts?: { timeoutSec?: number },
  ): Promise<{ ok: true; action: ContainerAction; id: string }>;
  remove(
    id: string,
    opts: { force?: boolean; removeVolumes?: boolean },
  ): Promise<{ removed: true; id: string }>;
  logs(id: string, q: ContainerLogsOptions): Promise<{ logs: string; truncated: boolean }>;
  /** 供 WS/SSE 使用的流式日志（follow 由调用方决定）。 */
  streamLogs(id: string, q: ContainerLogsOptions): AsyncIterable<DockerLogEntry>;
  stats(id: string): Promise<ContainerStats>;
  exec(id: string, req: ExecRequest): Promise<ExecResult>;
  prune(): Promise<{ deleted: number; reclaimedBytes: number }>;
}

export function createContainerService(docker: DockerClient): ContainerService {
  return {
    async list(q) {
      let containers: ContainerSummary[];
      try {
        containers = await docker.listContainers({
          all: q.all,
          ...(q.status !== undefined && q.status.trim() !== '' ? { status: q.status } : {}),
          ...(q.q !== undefined && q.q.trim() !== '' ? { q: q.q } : {}),
        });
      } catch (error) {
        if (isPanelError(error) && error.code === 'UNAVAILABLE') {
          return unavailableList(error.message);
        }
        throw error;
      }
      const sorted = [...containers].sort(compareCreatedDesc);
      const page = parsePage(q);
      const cursor = decodeCursor(page.cursor);
      const result = paginateDescending(
        sorted,
        cursor,
        (item) => item.created,
        (item) => item.id,
        page.limit,
      );
      return listResult(result.items, {
        nextCursor: result.nextCursor,
        total: sorted.length,
      });
    },

    async get(id) {
      assertContainerReference(id);
      return docker.inspect(id);
    },

    async action(id, action, opts) {
      assertContainerReference(id);
      const timeoutSec = validateTimeoutSec(opts?.timeoutSec);
      if (action === 'start') {
        await docker.start(id);
      } else if (action === 'stop') {
        await docker.stop(id, timeoutSec);
      } else if (action === 'restart') {
        await docker.restart(id, timeoutSec);
      } else {
        throw badRequest('不支持的容器操作', { action });
      }
      return { ok: true, action, id };
    },

    async remove(id, opts) {
      assertContainerReference(id);
      await docker.remove(id, {
        force: opts.force,
        removeVolumes: opts.removeVolumes,
      });
      return { removed: true, id };
    },

    async logs(id, q) {
      assertContainerReference(id);
      const options = normalizeLogsOptions(q);
      const entries = docker.logs(id, { ...options, follow: false });
      let buffer = '';
      let truncated = false;
      for await (const entry of entries) {
        buffer += entry.data;
        if (Buffer.byteLength(buffer, 'utf8') > MAX_LOG_BYTES) {
          const clipped = truncateText(buffer, MAX_LOG_BYTES);
          buffer = clipped.text;
          truncated = true;
          break;
        }
      }
      return { logs: buffer, truncated };
    },

    async stats(id) {
      assertContainerReference(id);
      return docker.stats(id);
    },

    streamLogs(id, q) {
      assertContainerReference(id);
      const options = normalizeLogsOptions(q);
      return docker.logs(id, options);
    },

    async exec(id, req) {
      assertContainerReference(id);
      assertExecRequest(req);
      return docker.exec(id, req);
    },

    async prune() {
      return docker.pruneContainers();
    },
  };
}

export function normalizeLogsOptions(q: ContainerLogsOptions): ContainerLogsOptions {
  const tail = q.tail ?? DEFAULT_LOG_TAIL;
  if (!Number.isInteger(tail) || tail < 0 || tail > 10_000) {
    throw badRequest('tail 参数必须是 0..10000 的整数', { field: 'tail' });
  }
  if (q.since !== undefined && q.since.length > 64) {
    throw badRequest('since 参数过长', { field: 'since' });
  }
  return {
    follow: q.follow === true,
    tail,
    ...(q.since !== undefined && q.since !== '' ? { since: q.since } : {}),
    timestamps: q.timestamps === true,
    stdout: q.stdout !== false,
    stderr: q.stderr !== false,
    ...(q.signal !== undefined ? { signal: q.signal } : {}),
  };
}

function validateTimeoutSec(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0 || value > 600) {
    throw badRequest('timeoutSec 必须是 0..600 的整数', { field: 'timeoutSec' });
  }
  return value;
}

function compareCreatedDesc(left: ContainerSummary, right: ContainerSummary): number {
  if (left.created === right.created) return left.id.localeCompare(right.id);
  return left.created < right.created ? 1 : -1;
}
