import { promises as fs } from 'node:fs';
import type { Stats } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PanelError, isPanelError } from '@mpanel/shared';
import type { FileRoot } from '@mpanel/shared';
import type { WorkerConfig } from './config.js';
import type { WorkerLogger } from './logger.js';

/**
 * 文件路径沙箱：所有用户输入都是“根内虚拟路径”，解析时 realpath 校验，
 * 拒绝 `..`、反斜杠、盘符、UNC、控制字符以及符号链接逃逸。
 */
export interface PathSandbox {
  readonly roots: FileRoot[];
  resolve(
    root: string,
    virtualPath: string,
    opts?: { forWrite?: boolean; allowMissing?: boolean },
  ): Promise<string>;
  relative(root: string, absPath: string): string;
  validateSiteRoot(absPath: string, opts?: { allowMissing?: boolean }): Promise<string>;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const MAX_VIRTUAL_PATH_LENGTH = 4096;

function badRequest(message: string, details?: unknown): PanelError {
  return new PanelError('BAD_REQUEST', message, details);
}

/**
 * 规范化根内虚拟路径：POSIX 风格、可带前导 `/`、折叠 `.`/重复 `/`。
 * 拒绝 NUL/控制字符、反斜杠、盘符、UNC 与 `..` 段。
 */
export function normalizeVirtualPath(input: string): string {
  if (typeof input !== 'string') {
    throw badRequest('路径必须是字符串');
  }
  if (input.length > MAX_VIRTUAL_PATH_LENGTH) {
    throw badRequest('路径过长（上限 4096 字符）');
  }
  if (CONTROL_CHARS.test(input)) {
    throw badRequest('路径不能包含控制字符');
  }
  if (input.includes('\\')) {
    throw badRequest('虚拟路径必须使用 / 作为分隔符');
  }
  if (input.startsWith('//')) {
    throw badRequest('虚拟路径不允许 UNC 形式');
  }
  if (/^[A-Za-z]:/.test(input)) {
    throw badRequest('虚拟路径不允许包含盘符');
  }
  const segments: string[] = [];
  for (const raw of input.split('/')) {
    if (raw === '' || raw === '.') continue;
    if (raw === '..') {
      throw badRequest('虚拟路径不能包含 .. 段');
    }
    segments.push(raw);
  }
  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

function splitVirtual(virtualPath: string): string[] {
  return virtualPath === '/' ? [] : virtualPath.slice(1).split('/');
}

/** 用 path.relative 判断 candidate 是否等于 base 或位于其内部（Windows 大小写不敏感）。 */
function isInside(base: string, candidate: string): boolean {
  const relative = path.relative(base, candidate);
  if (relative === '') return true;
  if (path.isAbsolute(relative)) return false;
  const posix = relative.split(path.sep).join('/');
  return posix !== '..' && !posix.startsWith('../');
}

function mapFsError(error: unknown, action: string): PanelError {
  if (isPanelError(error)) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return new PanelError('NOT_FOUND', `${action}失败：路径不存在`, { code });
    case 'EACCES':
    case 'EPERM':
      return new PanelError('FORBIDDEN', `${action}失败：权限不足`, { code });
    case 'ELOOP':
      return new PanelError('BAD_REQUEST', `${action}失败：符号链接层级过多`, { code });
    case 'ENAMETOOLONG':
      return new PanelError('BAD_REQUEST', `${action}失败：路径过长`, { code });
    default:
      return new PanelError('INTERNAL', `${action}失败`, {
        ...(code === undefined ? {} : { code }),
      });
  }
}

async function lstatSafe(absPath: string): Promise<Stats | null> {
  try {
    return await fs.lstat(absPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw mapFsError(error, '检查路径');
  }
}

/** 拒绝路径中任一层（含最终目标）为符号链接。 */
async function assertNoSymlink(realRoot: string, candidate: string): Promise<boolean> {
  const segments = splitVirtual(`/${path.relative(realRoot, candidate).split(path.sep).join('/')}`);
  let current = realRoot;
  let targetExists = true;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stats = await lstatSafe(current);
    if (stats === null) {
      targetExists = false;
      break;
    }
    if (stats.isSymbolicLink()) {
      throw badRequest('不允许通过符号链接访问文件', {
        hint: '请直接使用真实路径，或先在主机上解除符号链接。',
      });
    }
  }
  return targetExists;
}

async function realpathSafe(absPath: string): Promise<string | null> {
  try {
    return await fs.realpath(absPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw mapFsError(error, '解析路径');
  }
}

async function statsFs(absPath: string): Promise<{ freeBytes: number | null; totalBytes: number | null }> {
  try {
    const stats = await fs.statfs(absPath);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    if (!Number.isFinite(freeBytes) || !Number.isFinite(totalBytes)) {
      return { freeBytes: null, totalBytes: null };
    }
    return { freeBytes, totalBytes };
  } catch {
    return { freeBytes: null, totalBytes: null };
  }
}

interface RootEntry {
  name: string;
  configured: string;
  real: string | null;
  writable: boolean;
}

class PathSandboxImpl implements PathSandbox {
  readonly roots: FileRoot[];
  private readonly entries = new Map<string, RootEntry>();
  private readonly siteRoots: string[];
  private readonly logger: WorkerLogger;

  constructor(entries: RootEntry[], siteRoots: string[], logger: WorkerLogger) {
    this.logger = logger;
    for (const entry of entries) {
      this.entries.set(entry.name, entry);
    }
    this.roots = entries.map((entry) => ({
      name: entry.name,
      path: entry.real ?? entry.configured,
      writable: entry.writable,
    }));
    this.siteRoots = siteRoots;
  }

  async resolve(
    root: string,
    virtualPath: string,
    opts: { forWrite?: boolean; allowMissing?: boolean } = {},
  ): Promise<string> {
    const entry = this.entries.get(root);
    if (entry === undefined) {
      throw badRequest('未知的文件根', { root });
    }
    if (entry.real === null) {
      throw new PanelError('UNAVAILABLE', '文件根不可用', {
        root,
        hint: `确认文件根 ${entry.configured} 存在、可读且已配置在 MPANEL_FILES_ROOTS。`,
      });
    }
    const normalized = normalizeVirtualPath(virtualPath);
    const candidate = path.join(entry.real, ...splitVirtual(normalized));
    if (!isInside(entry.real, candidate)) {
      throw badRequest('路径超出文件根范围');
    }
    const exists = await assertNoSymlink(entry.real, candidate);
    const allowMissing = opts.allowMissing === true || opts.forWrite === true;
    if (!exists && !allowMissing) {
      throw new PanelError('NOT_FOUND', '路径不存在', { path: normalized, root });
    }
    if (exists) {
      const real = await realpathSafe(candidate);
      if (real === null) {
        if (!allowMissing) {
          throw new PanelError('NOT_FOUND', '路径不存在', { path: normalized, root });
        }
      } else {
        if (!isInside(entry.real, real)) {
          throw badRequest('路径超出文件根范围');
        }
        if (opts.forWrite === true) {
          try {
            await fs.access(real, fs.constants.W_OK);
          } catch {
            throw new PanelError('FORBIDDEN', '路径不可写', {
              path: normalized,
              root,
              hint: '检查 worker 运行用户对该路径的写权限。',
            });
          }
        }
        return real;
      }
    }
    // 目标不存在：校验最近存在的父目录仍在根内且不是符号链接。
    let parent = path.dirname(candidate);
    while (!isInside(entry.real, parent)) {
      throw badRequest('路径超出文件根范围');
    }
    let parentStats = await lstatSafe(parent);
    while (parentStats === null) {
      const next = path.dirname(parent);
      if (next === parent) break;
      parent = next;
      parentStats = await lstatSafe(parent);
    }
    if (parentStats === null) {
      throw new PanelError('NOT_FOUND', '路径不存在', { path: normalized, root });
    }
    const realParent = await realpathSafe(parent);
    if (realParent === null || !isInside(entry.real, realParent)) {
      throw badRequest('路径超出文件根范围');
    }
    if (opts.forWrite === true) {
      try {
        await fs.access(parentStats.isDirectory() ? parent : realParent, fs.constants.W_OK);
      } catch {
        throw new PanelError('FORBIDDEN', '目标目录不可写', {
          path: normalized,
          root,
          hint: '检查 worker 运行用户对父目录的写权限。',
        });
      }
    }
    return candidate;
  }

  relative(root: string, absPath: string): string {
    const entry = this.entries.get(root);
    if (entry === undefined) {
      throw badRequest('未知的文件根', { root });
    }
    if (entry.real === null) {
      throw new PanelError('UNAVAILABLE', '文件根不可用', {
        root,
        hint: `确认文件根 ${entry.configured} 存在且可读。`,
      });
    }
    const resolved = path.resolve(absPath);
    if (!isInside(entry.real, resolved)) {
      throw badRequest('路径超出文件根范围');
    }
    const relative = path.relative(entry.real, resolved).split(path.sep).join('/');
    return relative === '' ? '/' : `/${relative}`;
  }

  async validateSiteRoot(absPath: string, opts: { allowMissing?: boolean } = {}): Promise<string> {
    if (typeof absPath !== 'string' || absPath.trim().length === 0) {
      throw badRequest('站点根目录不能为空');
    }
    if (CONTROL_CHARS.test(absPath)) {
      throw badRequest('站点根目录不能包含控制字符');
    }
    const resolved = path.resolve(absPath);
    if (!path.isAbsolute(absPath)) {
      throw badRequest('站点根目录必须是绝对路径');
    }
    let target = await realpathSafe(resolved);
    if (target === null) {
      if (opts.allowMissing !== true) {
        throw new PanelError('BAD_REQUEST', '站点根目录不存在', {
          hint: '创建目录后重试，或在站点配置中使用已存在的目录。',
        });
      }
      // 逐级向上找最近存在的父目录并 realpath。
      let parent = path.dirname(resolved);
      let parentReal = await realpathSafe(parent);
      while (parentReal === null) {
        const next = path.dirname(parent);
        if (next === parent) break;
        parent = next;
        parentReal = await realpathSafe(parent);
      }
      if (parentReal === null) {
        throw badRequest('站点根目录的父目录不存在');
      }
      target = path.join(parentReal, path.relative(parent, resolved));
    }
    const allowed = this.siteRoots.some((root) => isInside(root, target as string));
    if (!allowed) {
      throw new PanelError('BAD_REQUEST', '站点根目录不在允许的白名单内', {
        hint: '把目录加入 MPANEL_SITES_ROOTS 或 MPANEL_FILES_ROOTS 后重试。',
      });
    }
    return target;
  }
}

export async function createPathSandbox(
  config: WorkerConfig,
  logger: WorkerLogger,
): Promise<PathSandbox> {
  const home = path.resolve(config.home);
  await fs.mkdir(home, { recursive: true }).catch(() => undefined);
  const entries: RootEntry[] = [];
  for (const root of config.files.roots) {
    const configured = path.resolve(root.path);
    let real: string | null = await realpathSafe(configured);
    if (real === null) {
      // 默认文件根（位于 MPANEL_HOME 下）自动创建；外部根只告警，不擅自创建。
      if (isInside(home, configured)) {
        try {
          await fs.mkdir(configured, { recursive: true });
          real = await realpathSafe(configured);
        } catch (error) {
          logger.warn('创建默认文件根失败', {
            root: root.name,
            path: configured,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } else {
        logger.warn('文件根不存在，相关操作将返回 UNAVAILABLE', {
          root: root.name,
          path: configured,
        });
      }
    }
    let writable = false;
    if (real !== null) {
      try {
        await fs.access(real, fs.constants.W_OK);
        writable = true;
      } catch {
        writable = false;
      }
    }
    entries.push({ name: root.name, configured, real, writable });
  }

  const siteRoots: string[] = [];
  for (const configured of config.caddy.sitesRoots) {
    const resolved = path.resolve(configured);
    const real = await realpathSafe(resolved);
    const value = real ?? resolved;
    if (!siteRoots.some((existing) => isInside(existing, value) && isInside(value, existing))) {
      siteRoots.push(value);
    }
  }
  // 文件根同样是 Caddy file_server.root 的白名单（architecture §6.3）。
  for (const entry of entries) {
    const value = entry.real ?? entry.configured;
    if (!siteRoots.some((existing) => isInside(existing, value) && isInside(value, existing))) {
      siteRoots.push(value);
    }
  }

  // 顺便把文件根的容量信息填进 roots（失败则为 null）。
  const sandboxEntries = entries;
  const sandbox = new PathSandboxImpl(sandboxEntries, siteRoots, logger);
  for (let index = 0; index < sandbox.roots.length; index += 1) {
    const root = sandbox.roots[index];
    const entry = sandboxEntries[index];
    if (root === undefined || entry === undefined || entry.real === null) continue;
    const capacity = await statsFs(entry.real);
    (root as FileRoot & { freeBytes?: number | null; totalBytes?: number | null }).freeBytes =
      capacity.freeBytes;
    (root as FileRoot & { freeBytes?: number | null; totalBytes?: number | null }).totalBytes =
      capacity.totalBytes;
  }
  return sandbox;
}

/** 供诊断：判断当前平台的路径是否可用作宿主绝对路径。 */
export function isAbsoluteHostPath(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (process.platform === 'win32') {
    return path.win32.isAbsolute(value);
  }
  return path.posix.isAbsolute(value);
}

/** 平台默认临时目录（测试/诊断用）。 */
export function defaultTempDir(): string {
  return os.tmpdir();
}
