import { randomBytes } from 'node:crypto';
import {
  appendFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import { PanelError } from '@mpanel/shared';

export interface JsonStore<T> {
  read(): Promise<T>;
  write(value: T): Promise<void>;
  update(mutator: (draft: T) => T | void): Promise<T>;
}

/** 单条 JSONL 记录上限（architecture §7.1）。 */
const JSONL_MAX_LINE_BYTES = 256 * 1024;
/** JSONL 轮转阈值与保留份数。 */
const JSONL_ROTATE_BYTES = 5 * 1024 * 1024;
const JSONL_KEEP = 3;

/** 进程内锁：文件锁不可用时的降级方案（见 acquireStateLock）。 */
const inProcessLocks = new Set<string>();

/**
 * 原子 JSON 存储：读不存在时返回默认值；写入走 tmp + fsync + rename，
 * 写前保留同目录 `.bak`。所有写操作在同一实例内串行化。
 */
export function createJsonStore<T>(filePath: string, defaults: T): JsonStore<T> {
  let queue: Promise<unknown> = Promise.resolve();
  let cache: T | undefined;
  let loaded = false;

  const load = async (): Promise<T> => {
    if (loaded && cache !== undefined) return cache;
    const primary = await tryReadJson<T>(filePath);
    if (primary.ok) {
      cache = primary.value;
      loaded = true;
      return cache;
    }
    const backup = await tryReadJson<T>(`${filePath}.bak`);
    if (backup.ok) {
      cache = backup.value;
      loaded = true;
      return cache;
    }
    cache = structuredClone(defaults);
    loaded = true;
    return cache;
  };

  const enqueue = <R>(task: () => Promise<R>): Promise<R> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  return {
    async read() {
      return structuredClone(await load());
    },
    async write(value) {
      await enqueue(async () => {
        const next = structuredClone(value);
        await writeFileAtomic(filePath, serialize(next));
        cache = next;
        loaded = true;
      });
    },
    async update(mutator) {
      return enqueue(async () => {
        const current = await load();
        const draft = structuredClone(current);
        const result = mutator(draft);
        const next = structuredClone(result === undefined ? draft : result);
        await writeFileAtomic(filePath, serialize(next));
        cache = next;
        loaded = true;
        return structuredClone(next);
      });
    },
  };
}

/** 同目录 tmp + fsync + rename；写前把旧文件复制为 `.bak`。 */
export async function writeFileAtomic(filePath: string, data: string): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  const handle = await open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    const existing = await readFile(filePath);
    const backupTmp = path.join(
      dir,
      `.${path.basename(filePath)}.${process.pid}.${randomBytes(6).toString('hex')}.bak.tmp`,
    );
    const backupHandle = await open(backupTmp, 'wx', 0o600);
    try {
      await backupHandle.writeFile(existing);
      await backupHandle.sync();
    } finally {
      await backupHandle.close();
    }
    await rename(backupTmp, `${filePath}.bak`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // 备份失败不应阻止主文件更新。
    }
  }
  await rename(tmp, filePath);
}

/**
 * 追加一行 JSONL（单行 ≤256 KiB），超过 5 MiB 轮转为 `.1` 并保留 3 份。
 * 追加不是原子替换，但单行写入使用 append 模式，读端按行解析。
 */
export async function appendJsonl(filePath: string, record: unknown): Promise<void> {
  const line = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(line, 'utf8') > JSONL_MAX_LINE_BYTES) {
    throw new PanelError('BAD_REQUEST', 'JSONL 记录超过 256 KiB 上限', {
      file: path.basename(filePath),
    });
  }
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await rotateJsonlIfNeeded(filePath);
  await appendFile(filePath, line, { encoding: 'utf8', mode: 0o600 });
}

/** 读取 JSONL 末尾最多 limit 条；文件不存在返回 []。 */
export async function readJsonlTail<T>(filePath: string, limit: number): Promise<T[]> {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  let text: string;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const lines = text.split('\n');
  const output: T[] = [];
  for (let index = lines.length - 1; index >= 0 && output.length < limit; index -= 1) {
    const line = (lines[index] ?? '').trim();
    if (line.length === 0) continue;
    try {
      output.push(JSON.parse(line) as T);
    } catch {
      // 损坏的尾行（进程崩溃）跳过，不让整个读取失败。
    }
  }
  return output.reverse();
}

/**
 * 跨进程状态锁：`state/.core.lock`（pid + 启动时间）。
 * 已存在且 pid 仍存活 → CONFLICT；pid 已退出或被判定为 stale → 接管。
 * 若当前平台/文件系统不支持独占创建（EPERM/ENOTSUP 等），降级为进程内锁。
 */
export async function acquireStateLock(home: string): Promise<() => Promise<void>> {
  const stateDir = path.join(home, 'state');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const lockFile = path.join(stateDir, '.core.lock');

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const record = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      home,
      role: 'core',
    };
    try {
      const handle = await open(lockFile, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      return async (): Promise<void> => {
        const current = await tryReadLock(lockFile);
        if (current?.pid === process.pid) {
          await rm(lockFile, { force: true }).catch(() => undefined);
        }
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        const existing = await tryReadLock(lockFile);
        if (existing !== null && isProcessAlive(existing.pid)) {
          throw new PanelError('CONFLICT', 'core 已有实例在运行', {
            hint: '同一 MPANEL_HOME 只允许一个 core 进程；停止旧进程或使用独立 home',
            pid: existing.pid,
            lockFile,
          });
        }
        // 陈旧/损坏的锁：删除后重试（最多 3 次）。
        await rm(lockFile, { force: true }).catch(() => undefined);
        continue;
      }
      // 文件系统不支持独占创建：降级为进程内锁。
      return acquireInProcessLock(home, lockFile);
    }
  }

  throw new PanelError('CONFLICT', '无法获取 core 状态锁', {
    hint: '删除 $MPANEL_HOME/state/.core.lock 后重试',
    lockFile,
  });
}

export function newId(prefix: string): string {
  const clean = prefix.replace(/[^A-Za-z0-9_]/g, '');
  return `${clean}_${randomBytes(9).toString('base64url')}`;
}

/* -------------------------------------------------------------------- */
/* 内部                                                                 */
/* -------------------------------------------------------------------- */

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function tryReadJson<T>(filePath: string): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    const text = await readFile(filePath, 'utf8');
    return { ok: true, value: JSON.parse(text) as T };
  } catch {
    return { ok: false };
  }
}

interface LockRecord {
  pid: number;
  startedAt?: string;
}

async function tryReadLock(lockFile: string): Promise<LockRecord | null> {
  try {
    const text = await readFile(lockFile, 'utf8');
    const parsed = JSON.parse(text) as LockRecord;
    if (typeof parsed.pid !== 'number' || !Number.isFinite(parsed.pid)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM：进程存在但无权限发送信号 → 视为存活。
    return code === 'EPERM';
  }
}

async function acquireInProcessLock(home: string, lockFile: string): Promise<() => Promise<void>> {
  const key = path.resolve(home);
  if (inProcessLocks.has(key)) {
    throw new PanelError('CONFLICT', 'core 已有实例在运行', {
      hint: '同一 MPANEL_HOME 只允许一个 core 进程',
      lockFile,
    });
  }
  inProcessLocks.add(key);
  return async (): Promise<void> => {
    inProcessLocks.delete(key);
  };
}

async function rotateJsonlIfNeeded(filePath: string): Promise<void> {
  let size = 0;
  try {
    const info = await stat(filePath);
    size = info.size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    return;
  }
  if (size <= JSONL_ROTATE_BYTES) return;
  // 保留 `file.1`…`file.3`：最旧的一份被覆盖。
  for (let index = JSONL_KEEP; index >= 1; index -= 1) {
    const from = index === 1 ? filePath : `${filePath}.${index - 1}`;
    const to = `${filePath}.${index}`;
    await rename(from, to).catch(() => undefined);
  }
}
