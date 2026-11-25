import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { PanelError } from '@mpanel/shared';
import type { MachineRecord } from './types.js';

/** Root object persisted to `$MPANEL_HOME/state/machines.json`. */
interface MachineFile {
  schemaVersion: number;
  machines: MachineRecord[];
}

const SCHEMA_VERSION = 1;

export interface MachineStore {
  list(): Promise<MachineRecord[]>;
  get(id: string): Promise<MachineRecord | undefined>;
  create(record: MachineRecord): Promise<MachineRecord>;
  update(id: string, patch: Partial<MachineRecord>): Promise<MachineRecord>;
  remove(id: string): Promise<void>;
  findBySecretHash(hash: string): Promise<MachineRecord | undefined>;
}

export interface MachineStoreLogger {
  warn(message: string, details?: Record<string, unknown>): void;
}

/**
 * 机器档案存储：仅使用原子 JSON（tmp + fsync + rename），不引入原生数据库。
 * 单进程单写者，所有读写串行化；主文件损坏时尝试从 `.bak` 恢复。
 */
export function createMachineStore(file: string, logger?: MachineStoreLogger): MachineStore {
  const storage = new AtomicJsonFile<MachineFile>(
    file,
    { schemaVersion: SCHEMA_VERSION, machines: [] },
    logger,
    migrate,
  );

  return {
    async list() {
      const value = await storage.read();
      return value.machines.map(cloneRecord);
    },
    async get(id) {
      const value = await storage.read();
      const found = value.machines.find((record) => record.id === id);
      return found === undefined ? undefined : cloneRecord(found);
    },
    async create(record) {
      const stored = cloneRecord(record);
      await storage.update((draft) => {
        if (draft.machines.some((existing) => existing.id === stored.id)) {
          throw new PanelError('CONFLICT', '机器 ID 已存在', { machineId: stored.id });
        }
        draft.machines.push(cloneRecord(stored));
        return draft;
      });
      return stored;
    },
    async update(id, patch) {
      const updated = await storage.update((draft) => {
        const index = draft.machines.findIndex((record) => record.id === id);
        if (index < 0) {
          throw new PanelError('NOT_FOUND', '机器不存在', { machineId: id });
        }
        const current = draft.machines[index] as MachineRecord;
        draft.machines[index] = {
          ...current,
          ...patch,
          id: current.id,
          createdAt: current.createdAt,
        };
        return draft;
      });
      const record = updated.machines.find((item) => item.id === id);
      if (record === undefined) {
        throw new PanelError('NOT_FOUND', '机器不存在', { machineId: id });
      }
      return cloneRecord(record);
    },
    async remove(id) {
      await storage.update((draft) => {
        const index = draft.machines.findIndex((record) => record.id === id);
        if (index < 0) {
          throw new PanelError('NOT_FOUND', '机器不存在', { machineId: id });
        }
        draft.machines.splice(index, 1);
        return draft;
      });
    },
    async findBySecretHash(hash) {
      const value = await storage.read();
      const found = value.machines.find((record) => record.secretHash !== null && record.secretHash === hash);
      return found === undefined ? undefined : cloneRecord(found);
    },
  };
}

function cloneRecord(record: MachineRecord): MachineRecord {
  return structuredClone(record);
}

function migrate(value: MachineFile): MachineFile {
  if (value.schemaVersion === SCHEMA_VERSION) return value;
  // v1 是首个 schema；未知版本按 v1 读取，避免直接丢弃档案。
  return { schemaVersion: SCHEMA_VERSION, machines: value.machines };
}

/**
 * 串行化、原子落盘的 JSON 文件访问器。读取缺失/损坏时先尝试 `.bak`，
 * 两者都失败则以默认值启动并记录警告（绝不使 core 启动失败）。
 */
class AtomicJsonFile<T> {
  private cache: T | undefined;
  private loading: Promise<T> | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly defaults: T,
    private readonly logger: MachineStoreLogger | undefined,
    private readonly normalize: (value: T) => T,
  ) {}

  async read(): Promise<T> {
    if (this.cache !== undefined) return this.cache;
    if (this.loading === undefined) {
      this.loading = this.load().finally(() => {
        this.loading = undefined;
      });
    }
    return this.loading;
  }

  async update(mutator: (draft: T) => T | void): Promise<T> {
    const run = async (): Promise<T> => {
      const current = await this.read();
      const draft = structuredClone(current);
      const result = mutator(draft);
      const next = this.normalize(result === undefined ? draft : result);
      await this.persist(next);
      this.cache = next;
      return next;
    };
    const chained = this.queue.then(run, run);
    this.queue = chained.catch(() => undefined);
    return chained;
  }

  private async load(): Promise<T> {
    const primary = await this.tryRead(this.filePath);
    if (primary.ok) {
      this.cache = this.normalize(primary.value);
      return this.cache;
    }
    const backup = await this.tryRead(`${this.filePath}.bak`);
    if (backup.ok) {
      this.logger?.warn('机器档案损坏，已从备份恢复', {
        file: this.filePath,
        error: primary.error,
      });
      this.cache = this.normalize(backup.value);
      // 立即回写主文件，避免下次继续走备份；此时不能把损坏的主文件复制成 .bak，
      // 否则会覆盖掉唯一可用的备份。
      await this.persist(this.cache, false);
      return this.cache;
    }
    if (primary.error !== undefined || backup.error !== undefined) {
      this.logger?.warn('机器档案不可读取，使用空档案启动', {
        file: this.filePath,
        error: primary.error ?? backup.error,
      });
    }
    this.cache = this.defaults;
    return this.cache;
  }

  private async tryRead(target: string): Promise<{ ok: true; value: T } | { ok: false; error?: string }> {
    try {
      const text = await readFile(target, 'utf8');
      const parsed = JSON.parse(text) as T;
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !Array.isArray((parsed as { machines?: unknown }).machines)
      ) {
        return { ok: false, error: '机器档案结构无效' };
      }
      return { ok: true, value: parsed };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { ok: false };
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async persist(value: T, keepBackup = true): Promise<void> {
    const dir = path.dirname(this.filePath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(
      dir,
      `.${path.basename(this.filePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
    );
    const payload = `${JSON.stringify(value, null, 2)}\n`;
    const handle = await open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (keepBackup) {
      try {
        await copyFile(this.filePath, `${this.filePath}.bak`);
      } catch {
        // 首次写入没有备份可复制，忽略。
      }
    }
    await rename(tmp, this.filePath);
  }
}
