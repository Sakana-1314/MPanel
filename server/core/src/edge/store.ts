import { PanelError } from '@mpanel/shared';
import { createJsonStore } from '../store.js';
import type {
  EdgeJobFile,
  EdgeJobStore,
  EdgeKeyFile,
  EdgeKeyRecord,
  EdgeKeyStore,
} from './types.js';

const SCHEMA_VERSION = 1;

/**
 * `$MPANEL_HOME/state/edge-keys.json`: atomic JSON (tmp + fsync + rename,
 * `.bak` retained) via the shared core store. Only the SHA-256 of the
 * enrollment secret is persisted.
 */
export function createEdgeKeyStore(file: string): EdgeKeyStore {
  const storage = createJsonStore<EdgeKeyFile>(file, {
    schemaVersion: SCHEMA_VERSION,
    keys: [],
  });

  return {
    async list() {
      const value = await storage.read();
      return value.keys.map(clone);
    },
    async get(id) {
      const value = await storage.read();
      const found = value.keys.find((record) => record.id === id);
      return found === undefined ? undefined : clone(found);
    },
    async findBySecretHash(hash) {
      const value = await storage.read();
      const found = value.keys.find((record) => record.secretHash === hash);
      return found === undefined ? undefined : clone(found);
    },
    async create(record) {
      const stored = clone(record);
      await storage.update((draft) => {
        if (draft.keys.some((existing) => existing.id === stored.id)) {
          throw new PanelError('CONFLICT', '边缘密钥 ID 已存在', { id: stored.id });
        }
        draft.keys.push(clone(stored));
        return draft;
      });
      return stored;
    },
    async update(id, patch) {
      const updated = await storage.update((draft) => {
        const index = draft.keys.findIndex((record) => record.id === id);
        if (index < 0) {
          throw new PanelError('NOT_FOUND', '边缘密钥不存在', { resource: 'edge-key', id });
        }
        const current = draft.keys[index] as EdgeKeyRecord;
        draft.keys[index] = {
          ...current,
          ...patch,
          id: current.id,
          createdAt: current.createdAt,
        };
        return draft;
      });
      const record = updated.keys.find((item) => item.id === id);
      if (record === undefined) {
        throw new PanelError('NOT_FOUND', '边缘密钥不存在', { resource: 'edge-key', id });
      }
      return clone(record);
    },
  };
}

/** `$MPANEL_HOME/state/edge-jobs.json`: same atomic JSON contract. */
export function createEdgeJobStore(file: string): EdgeJobStore {
  const storage = createJsonStore<EdgeJobFile>(file, {
    schemaVersion: SCHEMA_VERSION,
    jobs: [],
  });

  return {
    async list() {
      const value = await storage.read();
      return value.jobs.map(clone);
    },
    async get(id) {
      const value = await storage.read();
      const found = value.jobs.find((job) => job.id === id);
      return found === undefined ? undefined : clone(found);
    },
    async create(job) {
      const stored = clone(job);
      await storage.update((draft) => {
        if (draft.jobs.some((existing) => existing.id === stored.id)) {
          throw new PanelError('CONFLICT', '边缘作业 ID 已存在', { id: stored.id });
        }
        draft.jobs.push(clone(stored));
        return draft;
      });
      return stored;
    },
    async update(id, patch) {
      const updated = await storage.update((draft) => {
        const index = draft.jobs.findIndex((job) => job.id === id);
        if (index < 0) {
          throw new PanelError('NOT_FOUND', '边缘作业不存在', { resource: 'edge-job', id });
        }
        const current = draft.jobs[index] as EdgeJobLike;
        draft.jobs[index] = {
          ...current,
          ...patch,
          id: current.id,
          createdAt: current.createdAt,
        };
        return draft;
      });
      const job = updated.jobs.find((item) => item.id === id);
      if (job === undefined) {
        throw new PanelError('NOT_FOUND', '边缘作业不存在', { resource: 'edge-job', id });
      }
      return clone(job);
    },
    async remove(id) {
      await storage.update((draft) => {
        const index = draft.jobs.findIndex((job) => job.id === id);
        if (index < 0) {
          throw new PanelError('NOT_FOUND', '边缘作业不存在', { resource: 'edge-job', id });
        }
        draft.jobs.splice(index, 1);
        return draft;
      });
    },
  };
}

type EdgeJobLike = EdgeJobFile['jobs'][number];

function clone<T>(value: T): T {
  return structuredClone(value);
}
