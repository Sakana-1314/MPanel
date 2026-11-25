import type {
  ListResult,
  ModuleLogger,
  PageQuery,
  TrashEmptyRequest,
  TrashEntry,
  TrashRestoreRequest,
} from '@mpanel/shared';
import type { WorkerConfig } from '../../config.js';
import { createFileSandbox } from './sandbox.js';
import type { FileSandbox } from './sandbox.js';

export interface TrashService {
  move(root: string, path: string): Promise<TrashEntry>;
  list(q: PageQuery): Promise<ListResult<TrashEntry>>;
  restore(req: TrashRestoreRequest): Promise<{ restored: true; path: string }>;
  empty(req: TrashEmptyRequest): Promise<{ deleted: number }>;
}

const silentLogger: ModuleLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/**
 * 回收站服务是 sandbox 软删除能力的薄封装：条目落在
 * `$MPANEL_HOME/trash/<日期>/<id>/`（payload + meta.json）。
 */
export function createTrashService(
  config: WorkerConfig,
  sandbox?: FileSandbox,
): TrashService {
  const backing = sandbox ?? createFileSandbox(config, silentLogger);
  return {
    move(root: string, path: string): Promise<TrashEntry> {
      return backing.trash(root, path);
    },
    list(q: PageQuery): Promise<ListResult<TrashEntry>> {
      return backing.listTrash(q);
    },
    restore(req: TrashRestoreRequest): Promise<{ restored: true; path: string }> {
      return backing.restoreTrash(req);
    },
    empty(req: TrashEmptyRequest): Promise<{ deleted: number }> {
      return backing.emptyTrash(req);
    },
  };
}
