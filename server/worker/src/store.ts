import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { PanelError, isPanelError } from '@mpanel/shared';

/**
 * 原子 JSON 存储与 JSONL 追加日志。
 * 单进程内按文件串行化，进程间由 acquireStateLock 保证单写者。
 */

export interface JsonStore<T> {
  read(): Promise<T>;
  write(value: T): Promise<void>;
  update(mutator: (draft: T) => T | void): Promise<T>;
}

const MAX_JSONL_LINE_BYTES = 256 * 1024;
const JSONL_ROTATE_BYTES = 5 * 1024 * 1024;
const JSONL_BACKUPS = 3;
const JSONL_TAIL_READ_BYTES = 64 * 1024 * 1024;
const STORE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** 同文件写入串行化，避免 update 竞争。 */
const writeChains = new Map<string, Promise<unknown>>();

function chainFor<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  writeChains.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

function mapFileError(error: unknown, action: string, filePath: string): never {
  if (isPanelError(error)) throw error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const file = path.basename(filePath);
  if (code === 'ENOENT') {
    throw new PanelError('NOT_FOUND', `${action}失败：文件不存在`, { file });
  }
  if (code === 'EACCES' || code === 'EPERM') {
    throw new PanelError('FORBIDDEN', `${action}失败：权限不足`, { file });
  }
  throw new PanelError('INTERNAL', `${action}失败`, {
    file,
    ...(code === undefined ? {} : { code }),
  });
}

function parseJson<T>(text: string, filePath: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new PanelError('INTERNAL', 'JSON 文件内容损坏，无法解析', {
      file: path.basename(filePath),
    }, { cause });
  }
}

async function readRawOptional(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    mapFileError(error, '读取文件', filePath);
  }
}

async function readJsonWithBackup<T>(filePath: string): Promise<T> {
  const raw = await readRawOptional(filePath);
  if (raw !== null) {
    try {
      return parseJson<T>(raw, filePath);
    } catch (error) {
      const backup = await readRawOptional(`${filePath}.bak`);
      if (backup !== null) {
        try {
          return parseJson<T>(backup, filePath);
        } catch {
          // 主文件与备份都损坏，继续抛出主文件错误。
        }
      }
      throw error;
    }
  }
  const backup = await readRawOptional(`${filePath}.bak`);
  if (backup !== null) {
    return parseJson<T>(backup, filePath);
  }
  throw new PanelError('NOT_FOUND', '读取文件失败：文件不存在', {
    file: path.basename(filePath),
  });
}

async function fsyncDirectory(dir: string): Promise<void> {
  // Windows 不支持对目录 fsync；失败静默，数据文件本身已 fsync。
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(dir, 'r');
    await handle.sync();
  } catch {
    // 平台不支持时忽略。
  } finally {
    if (handle !== null) {
      await handle.close().catch(() => undefined);
    }
  }
}

export function createJsonStore<T>(filePath: string, defaults: T): JsonStore<T> {
  const resolved = path.resolve(filePath);
  const read = async (): Promise<T> => {
    const raw = await readRawOptional(resolved);
    if (raw === null) {
      return structuredClone(defaults);
    }
    try {
      return parseJson<T>(raw, resolved);
    } catch (error) {
      const backup = await readRawOptional(`${resolved}.bak`);
      if (backup !== null) {
        try {
          return parseJson<T>(backup, resolved);
        } catch {
          // 备份也损坏。
        }
      }
      throw error;
    }
  };

  const write = async (value: T): Promise<void> => {
    let serialized: string;
    try {
      serialized = `${JSON.stringify(value, null, 2)}\n`;
    } catch (cause) {
      throw new PanelError('INTERNAL', '存储内容无法序列化为 JSON', {
        file: path.basename(resolved),
      }, { cause });
    }
    await chainFor(resolved, async () => {
      // 写前保留一份 .bak，便于从损坏/误写恢复。
      const existing = await readRawOptional(resolved);
      if (existing !== null) {
        await fs.copyFile(resolved, `${resolved}.bak`).catch(() => undefined);
      }
      await writeFileAtomic(resolved, serialized);
    });
  };

  const update = async (mutator: (draft: T) => T | void): Promise<T> => {
    return chainFor(resolved, async () => {
      const current = await read();
      const draft = structuredClone(current);
      const returned = mutator(draft);
      const next = returned === undefined ? draft : returned;
      let serialized: string;
      try {
        serialized = `${JSON.stringify(next, null, 2)}\n`;
      } catch (cause) {
        throw new PanelError('INTERNAL', '存储内容无法序列化为 JSON', {
          file: path.basename(resolved),
        }, { cause });
      }
      const existing = await readRawOptional(resolved);
      if (existing !== null) {
        await fs.copyFile(resolved, `${resolved}.bak`).catch(() => undefined);
      }
      await writeFileAtomic(resolved, serialized);
      return next;
    });
  };

  return { read, write, update };
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  return readJsonWithBackup<T>(path.resolve(filePath));
}

/** 同目录临时文件 + fsync + rename，Windows/POSIX 均可用。 */
export async function writeFileAtomic(filePath: string, data: string): Promise<void> {
  const resolved = path.resolve(filePath);
  const dir = path.dirname(resolved);
  await fs.mkdir(dir, { recursive: true });
  const temporary = path.join(
    dir,
    `.${path.basename(resolved)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(data, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await fs.rename(temporary, resolved);
    } catch (error) {
      // Windows 上目标被占用时 rename 可能失败；先删目标再重试一次（已 fsync 的临时文件仍在）。
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES') throw error;
      await fs.rm(resolved, { force: true });
      await fs.rename(temporary, resolved);
    }
    await fsyncDirectory(dir);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    mapFileError(error, '写入文件', resolved);
  } finally {
    if (handle !== null) {
      await handle.close().catch(() => undefined);
    }
  }
}

async function rotateJsonlIfNeeded(filePath: string, incomingBytes: number): Promise<void> {
  let size = 0;
  try {
    size = (await fs.stat(filePath)).size;
  } catch {
    return;
  }
  if (size + incomingBytes <= JSONL_ROTATE_BYTES) return;
  // .2 -> .3, .1 -> .2, file -> .1；更旧的直接覆盖。
  await fs.rm(`${filePath}.${JSONL_BACKUPS}`, { force: true }).catch(() => undefined);
  for (let index = JSONL_BACKUPS - 1; index >= 1; index -= 1) {
    await fs
      .rename(`${filePath}.${index}`, `${filePath}.${index + 1}`)
      .catch(() => undefined);
  }
  await fs.rename(filePath, `${filePath}.1`).catch(() => undefined);
}

export async function appendJsonl(filePath: string, record: unknown): Promise<void> {
  const resolved = path.resolve(filePath);
  let line: string;
  try {
    line = `${JSON.stringify(record)}\n`;
  } catch (cause) {
    throw new PanelError('INTERNAL', '日志记录无法序列化为 JSON', undefined, { cause });
  }
  if (Buffer.byteLength(line, 'utf8') > MAX_JSONL_LINE_BYTES) {
    throw new PanelError('BAD_REQUEST', '单条日志记录超过 256 KiB 上限');
  }
  const dir = path.dirname(resolved);
  try {
    await fs.mkdir(dir, { recursive: true });
    await chainFor(resolved, async () => {
      await rotateJsonlIfNeeded(resolved, Buffer.byteLength(line, 'utf8'));
      await fs.appendFile(resolved, line, { encoding: 'utf8', mode: 0o600 });
    });
  } catch (error) {
    mapFileError(error, '追加日志', resolved);
  }
}

export async function readJsonlTail<T>(filePath: string, limit: number): Promise<T[]> {
  const resolved = path.resolve(filePath);
  const cap = Math.max(0, Math.floor(limit));
  if (cap === 0) return [];
  let size = 0;
  try {
    size = (await fs.stat(resolved)).size;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    mapFileError(error, '读取日志', resolved);
  }
  let text: string;
  try {
    const start = Math.max(0, size - JSONL_TAIL_READ_BYTES);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    const handle = await fs.open(resolved, 'r');
    try {
      await handle.read(buffer, 0, length, start);
    } finally {
      await handle.close();
    }
    text = buffer.toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
  } catch (error) {
    mapFileError(error, '读取日志', resolved);
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const selected = lines.slice(Math.max(0, lines.length - cap));
  const records: T[] = [];
  for (const line of selected) {
    try {
      records.push(JSON.parse(line) as T);
    } catch {
      // 单行损坏跳过，不影响历史列表。
    }
  }
  return records;
}

interface LockRecord {
  pid: number;
  role: string;
  startedAt: string;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

async function readLock(lockPath: string): Promise<LockRecord | null> {
  try {
    const raw = await fs.readFile(lockPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<LockRecord>;
    if (typeof parsed.pid !== 'number' || typeof parsed.role !== 'string') return null;
    return {
      pid: parsed.pid,
      role: parsed.role,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
    };
  } catch {
    return null;
  }
}

/** 跨进程状态锁：`state/.worker.lock`（pid + 启动时间）。 */
export async function acquireStateLock(
  homeDir: string,
  role: 'worker',
): Promise<() => Promise<void>> {
  const stateDir = path.join(path.resolve(homeDir), 'state');
  await fs.mkdir(stateDir, { recursive: true });
  const lockPath = path.join(stateDir, `.${role}.lock`);
  const payload: LockRecord = {
    pid: process.pid,
    role,
    startedAt: new Date().toISOString(),
  };
  const body = `${JSON.stringify(payload)}\n`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
      handle = await fs.open(lockPath, 'wx', 0o600);
      await handle.writeFile(body, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      let released = false;
      return async (): Promise<void> => {
        if (released) return;
        released = true;
        const current = await readLock(lockPath);
        if (current !== null && current.pid !== process.pid) return;
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
      };
    } catch (error) {
      if (handle !== null) await handle.close().catch(() => undefined);
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        mapFileError(error, '获取状态锁', lockPath);
      }
      const existing = await readLock(lockPath);
      if (existing !== null && isPidAlive(existing.pid)) {
        throw new PanelError('CONFLICT', '已有另一个 worker 实例在使用同一个 MPANEL_HOME', {
          pid: existing.pid,
          startedAt: existing.startedAt,
          hint: '请停止已有进程，或为本次运行设置独立的 MPANEL_HOME。',
        });
      }
      // 上一个进程异常退出，清理陈旧锁后重试。
      await fs.rm(lockPath, { force: true }).catch(() => undefined);
    }
  }
  throw new PanelError('CONFLICT', '无法获取 worker 状态锁，请稍后重试', {
    hint: '检查 MPANEL_HOME/state 目录权限，并确认没有残留的 worker 进程。',
  });
}

export interface StoreFactory {
  json<T>(name: string, defaults: T): JsonStore<T>;
  appendJsonl(name: string, record: unknown): Promise<void>;
  readJsonlTail<T>(name: string, limit: number): Promise<T[]>;
  newId(prefix: string): string;
}

function resolveStorePath(homeDir: string, name: string): string {
  if (!STORE_NAME_RE.test(name)) {
    throw new PanelError('BAD_REQUEST', '存储名称不合法', { name });
  }
  return path.join(path.resolve(homeDir), 'state', `${name}.json`);
}

function resolveJsonlPath(homeDir: string, name: string): string {
  if (!STORE_NAME_RE.test(name)) {
    throw new PanelError('BAD_REQUEST', '存储名称不合法', { name });
  }
  return path.join(path.resolve(homeDir), 'state', `${name}.jsonl`);
}

export function createStoreFactory(homeDir: string): StoreFactory {
  const home = path.resolve(homeDir);
  return {
    json<T>(name: string, defaults: T): JsonStore<T> {
      return createJsonStore<T>(resolveStorePath(home, name), defaults);
    },
    appendJsonl(name: string, record: unknown): Promise<void> {
      return appendJsonl(resolveJsonlPath(home, name), record);
    },
    readJsonlTail<T>(name: string, limit: number): Promise<T[]> {
      return readJsonlTail<T>(resolveJsonlPath(home, name), limit);
    },
    newId(prefix: string): string {
      return newId(prefix);
    },
  };
}

export function newId(prefix: string): string {
  const cleanPrefix = /^[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/.test(prefix)
    ? prefix
    : 'id';
  return `${cleanPrefix}_${randomBytes(9).toString('base64url')}`;
}

/** 生成随机不透明标识（uuid 形式），供需要稳定格式的调用方使用。 */
export function newUuid(): string {
  return randomUUID();
}
