import { randomBytes } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import * as path from 'node:path';
import { PanelError, isPanelError } from '@mpanel/shared';
import type {
  FileItem,
  FileRoot,
  FileType,
  ListResult,
  ModuleLogger,
  PageQuery,
  TrashEmptyRequest,
  TrashEntry,
  TrashRestoreRequest,
} from '@mpanel/shared';
import type { WorkerConfig } from '../../config.js';
import type { PathSandbox } from '../../paths.js';

/** 根内虚拟路径的最大长度（与 shared 的 filePathSchema 上限一致）。 */
export const MAX_VIRTUAL_PATH_LENGTH = 4096;
/** 单个路径段的最大字节数。 */
export const MAX_SEGMENT_BYTES = 255;
/** 分页规则与契约一致：默认 100，最大 200。 */
export const LIST_LIMIT_DEFAULT = 100;
export const LIST_LIMIT_MAX = 200;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const FILE_ROOT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/;
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
const TRASH_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ISO_DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface ResolveOptions {
  forWrite?: boolean;
  allowMissing?: boolean;
  allowSymlink?: boolean;
}

export interface FileSandbox extends PathSandbox {
  readonly config: WorkerConfig;
  readonly roots: FileRoot[];
  readonly defaultRoot: string;
  hasRoot(root: string): boolean;
  rootPath(root: string): string;
  resolve(root: string, virtualPath: string, opts?: ResolveOptions): Promise<string>;
  relative(root: string, absPath: string): string;
  stat(root: string, virtualPath: string): Promise<FileItem>;
  describe(root: string, virtualPath: string, absPath: string, stats: Stats): Promise<FileItem>;
  ensureDir(absPath: string, mode?: number): Promise<void>;
  listRoots(): Promise<FileRoot[]>;
  trashDir(): string;
  trash(root: string, virtualPath: string): Promise<TrashEntry>;
  listTrash(q: PageQuery): Promise<ListResult<TrashEntry>>;
  restoreTrash(req: TrashRestoreRequest): Promise<{ restored: true; path: string }>;
  emptyTrash(req: TrashEmptyRequest): Promise<{ deleted: number }>;
  validateSiteRoot(absPath: string, opts?: { allowMissing?: boolean }): Promise<string>;
}

export function isReservedWindowsName(segment: string): boolean {
  return WINDOWS_RESERVED_RE.test(segment);
}

/**
 * 规范化根内虚拟路径：POSIX 分隔符、可带前导 `/`。
 * 拒绝 NUL/控制字符、反斜杠、盘符、UNC、`..` 段、Windows 保留名、超长路径。
 */
export function normalizeVirtualPath(input: string): string {
  if (typeof input !== 'string') {
    throw new PanelError('BAD_REQUEST', '路径必须是字符串');
  }
  if (input.length > MAX_VIRTUAL_PATH_LENGTH) {
    throw new PanelError('BAD_REQUEST', '路径过长（上限 4096 字符）');
  }
  if (CONTROL_CHARS.test(input)) {
    throw new PanelError('BAD_REQUEST', '路径不能包含控制字符');
  }
  if (input.includes('\\')) {
    throw new PanelError('BAD_REQUEST', '虚拟路径必须使用 / 作为分隔符');
  }
  if (input.startsWith('//')) {
    throw new PanelError('BAD_REQUEST', '虚拟路径不允许 UNC 形式');
  }
  if (/^[A-Za-z]:/.test(input)) {
    throw new PanelError('BAD_REQUEST', '虚拟路径不允许包含盘符');
  }
  const segments: string[] = [];
  for (const raw of input.split('/')) {
    if (raw === '' || raw === '.') continue;
    if (raw === '..') {
      throw new PanelError('BAD_REQUEST', '虚拟路径不能包含 .. 段');
    }
    if (raw.includes(':')) {
      throw new PanelError('BAD_REQUEST', '路径段不能包含冒号');
    }
    if (isReservedWindowsName(raw)) {
      throw new PanelError('BAD_REQUEST', '路径包含 Windows 保留名称');
    }
    if (/[. ]$/.test(raw)) {
      throw new PanelError('BAD_REQUEST', '路径段不能以点或空格结尾');
    }
    if (Buffer.byteLength(raw, 'utf8') > MAX_SEGMENT_BYTES) {
      throw new PanelError('BAD_REQUEST', '路径段过长（上限 255 字节）');
    }
    segments.push(raw);
  }
  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

export function splitVirtualPath(virtualPath: string): string[] {
  return virtualPath === '/' ? [] : virtualPath.slice(1).split('/');
}

export function virtualBasename(virtualPath: string): string {
  const segments = splitVirtualPath(virtualPath);
  return segments.length === 0 ? '/' : segments[segments.length - 1]!;
}

/** 目标是否等于 base 或位于 base 之内（虚拟路径）。 */
export function isVirtualInside(base: string, candidate: string): boolean {
  if (base === '/') return true;
  return candidate === base || candidate.startsWith(`${base}/`);
}

export function encodeOffsetCursor(kind: string, offset: number): string {
  return Buffer.from(`${kind}:${offset}`, 'utf8').toString('base64url');
}

export function decodeOffsetCursor(kind: string, cursor: string): number {
  let text: string;
  try {
    text = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new PanelError('BAD_REQUEST', '分页游标无效');
  }
  const separator = text.lastIndexOf(':');
  if (separator <= 0 || text.slice(0, separator) !== kind) {
    throw new PanelError('BAD_REQUEST', '分页游标无效');
  }
  const offset = Number(text.slice(separator + 1));
  if (!Number.isInteger(offset) || offset < 0) {
    throw new PanelError('BAD_REQUEST', '分页游标无效');
  }
  return offset;
}

export function fileTypeOf(stats: Stats): FileType {
  if (stats.isSymbolicLink()) return 'symlink';
  if (stats.isFile()) return 'file';
  if (stats.isDirectory()) return 'directory';
  return 'other';
}

export function formatMode(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(4, '0');
}

/** 将底层文件系统错误映射为契约错误码，绝不向客户端暴露真实绝对路径。 */
export function mapFsError(error: unknown, action: string): PanelError {
  if (isPanelError(error)) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case 'ENOENT':
      return new PanelError('NOT_FOUND', `${action}失败：文件或目录不存在`, { code });
    case 'EACCES':
    case 'EPERM':
      return new PanelError('FORBIDDEN', `${action}失败：权限不足`, { code });
    case 'EEXIST':
      return new PanelError('CONFLICT', `${action}失败：目标已存在`, { code });
    case 'ENOTEMPTY':
      return new PanelError('CONFLICT', `${action}失败：目录非空`, { code });
    case 'EISDIR':
      return new PanelError('BAD_REQUEST', `${action}失败：目标是目录`, { code });
    case 'ENOTDIR':
      return new PanelError('BAD_REQUEST', `${action}失败：路径不是目录`, { code });
    case 'ENAMETOOLONG':
      return new PanelError('BAD_REQUEST', `${action}失败：路径过长`, { code });
    case 'ELOOP':
      return new PanelError('BAD_REQUEST', `${action}失败：符号链接层级过多`, { code });
    case 'EINVAL':
      return new PanelError('BAD_REQUEST', `${action}失败：参数不合法`, { code });
    case 'EROFS':
      return new PanelError('FORBIDDEN', `${action}失败：文件系统只读`, { code });
    case 'ENOSPC':
      return new PanelError('UNAVAILABLE', `${action}失败：磁盘空间不足`, {
        code,
        hint: '释放磁盘空间后重试',
      });
    case 'EMFILE':
    case 'ENFILE':
      return new PanelError('UNAVAILABLE', `${action}失败：打开的文件过多`, {
        code,
        hint: '稍后重试或提高 worker 主机的文件句柄上限',
      });
    default:
      return new PanelError('INTERNAL', `${action}失败`, code === undefined ? undefined : { code });
  }
}

export async function pathExists(absPath: string): Promise<boolean> {
  try {
    await fs.lstat(absPath);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw mapFsError(error, '检查路径');
  }
}

function isInsideRoot(realRoot: string, candidate: string): boolean {
  const rel = path.relative(realRoot, candidate);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  const posix = rel.split(path.sep).join('/');
  return posix !== '..' && !posix.startsWith('../');
}

/** 递归计算路径大小；目录内的符号链接按链接自身大小计入，不跟随。 */
export async function computeTreeSize(absPath: string, stats?: Stats): Promise<number> {
  const first = stats ?? (await fs.lstat(absPath));
  if (!first.isDirectory() || first.isSymbolicLink()) return first.size;
  let total = 0;
  const stack: string[] = [absPath];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      let childStat: Stats;
      try {
        childStat = await fs.lstat(child);
      } catch {
        continue;
      }
      if (childStat.isDirectory() && !childStat.isSymbolicLink()) {
        stack.push(child);
      } else {
        total += childStat.size;
      }
    }
  }
  return total;
}

export interface CopyTreeOptions {
  maxFiles?: number;
  maxBytes?: number;
  symlinks?: 'reject' | 'copy';
}

export interface CopyTreeResult {
  files: number;
  bytes: number;
}

/** 复制目录树；默认拒绝符号链接，避免把根外目标复制进根内。 */
export async function copyTree(
  source: string,
  destination: string,
  opts: CopyTreeOptions = {},
): Promise<CopyTreeResult> {
  const maxFiles = opts.maxFiles ?? Number.POSITIVE_INFINITY;
  const maxBytes = opts.maxBytes ?? Number.POSITIVE_INFINITY;
  const symlinks = opts.symlinks ?? 'reject';
  let files = 0;
  let bytes = 0;
  const stack: Array<{ source: string; destination: string }> = [{ source, destination }];
  while (stack.length > 0) {
    const item = stack.pop()!;
    const stats = await fs.lstat(item.source);
    if (stats.isSymbolicLink()) {
      if (symlinks === 'reject') {
        throw new PanelError('BAD_REQUEST', '不支持复制符号链接', {
          hint: '请先移除或替换符号链接后重试',
        });
      }
      const target = await fs.readlink(item.source);
      await fs.symlink(target, item.destination);
      files += 1;
      continue;
    }
    if (stats.isDirectory()) {
      await fs.mkdir(item.destination, { recursive: true, mode: stats.mode & 0o777 });
      const entries = await fs.readdir(item.source, { withFileTypes: true });
      for (const entry of entries) {
        stack.push({
          source: path.join(item.source, entry.name),
          destination: path.join(item.destination, entry.name),
        });
      }
      continue;
    }
    if (!stats.isFile()) {
      throw new PanelError('BAD_REQUEST', '不支持复制特殊文件（设备/管道等）');
    }
    files += 1;
    bytes += stats.size;
    if (files > maxFiles || bytes > maxBytes) {
      throw new PanelError('BAD_REQUEST', '复制内容超过上限（10 万文件 / 5 GiB）');
    }
    await fs.copyFile(item.source, item.destination);
  }
  return { files, bytes };
}

/** 同文件系统 rename，跨卷时退化为复制后删除。 */
export async function movePath(
  source: string,
  destination: string,
  opts: CopyTreeOptions = {},
): Promise<void> {
  try {
    await fs.rename(source, destination);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
  }
  await copyTree(source, destination, { symlinks: 'copy', ...opts });
  await fs.rm(source, { recursive: true, force: true });
}

function trashEntryIsValid(value: unknown): value is TrashEntry {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    TRASH_ID_RE.test(record.id) &&
    typeof record.root === 'string' &&
    FILE_ROOT_NAME_RE.test(record.root) &&
    typeof record.originalPath === 'string' &&
    record.originalPath.startsWith('/') &&
    typeof record.trashedAt === 'string' &&
    !Number.isNaN(Date.parse(record.trashedAt)) &&
    typeof record.sizeBytes === 'number' &&
    record.sizeBytes >= 0 &&
    (record.type === 'file' ||
      record.type === 'directory' ||
      record.type === 'symlink' ||
      record.type === 'other')
  );
}

function generateTrashId(): string {
  return `${Date.now().toString(36)}-${randomBytes(6).toString('hex')}`;
}

function parseLimit(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return fallback;
  return Math.min(value, max);
}

async function writeTrashMeta(filePath: string, entry: TrashEntry): Promise<void> {
  const tmp = `${filePath}.tmp-${randomBytes(4).toString('hex')}`;
  const handle = await fs.open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(entry));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, filePath);
}

interface TrashLocation {
  directory: string;
  entry: TrashEntry;
}

class FileSandboxImpl implements FileSandbox {
  readonly config: WorkerConfig;
  readonly roots: FileRoot[];
  readonly defaultRoot: string;
  private readonly logger: ModuleLogger;
  private readonly rootByName = new Map<string, FileRoot>();
  private readonly realRootCache = new Map<string, string>();

  constructor(config: WorkerConfig, logger: ModuleLogger) {
    this.config = config;
    this.logger = logger;
    const configured = Array.isArray(config.files?.roots) ? config.files.roots : [];
    const roots: FileRoot[] = [];
    for (const entry of configured) {
      if (typeof entry?.name !== 'string' || !FILE_ROOT_NAME_RE.test(entry.name)) {
        this.logger.warn('忽略名称非法的文件根配置', { name: entry?.name });
        continue;
      }
      if (typeof entry.path !== 'string' || entry.path.length === 0) {
        this.logger.warn('忽略路径为空的文件根配置', { name: entry.name });
        continue;
      }
      if (this.rootByName.has(entry.name)) {
        this.logger.warn('忽略重复的文件根名称', { name: entry.name });
        continue;
      }
      const resolved = path.isAbsolute(entry.path)
        ? path.resolve(entry.path)
        : path.resolve(config.home, entry.path);
      const root: FileRoot = { name: entry.name, path: resolved, writable: true };
      roots.push(root);
      this.rootByName.set(root.name, root);
    }
    if (roots.length === 0) {
      const fallback: FileRoot = {
        name: 'files',
        path: path.resolve(config.home, 'files'),
        writable: true,
      };
      roots.push(fallback);
      this.rootByName.set(fallback.name, fallback);
    }
    this.roots = roots;
    this.defaultRoot = roots[0]!.name;
  }

  hasRoot(root: string): boolean {
    return typeof root === 'string' && this.rootByName.has(root);
  }

  rootPath(root: string): string {
    const entry = this.rootByName.get(root);
    if (entry === undefined) {
      throw new PanelError('BAD_REQUEST', '未知的文件根', { root });
    }
    return entry.path;
  }

  private async rootReal(root: string): Promise<string> {
    const cached = this.realRootCache.get(root);
    if (cached !== undefined) return cached;
    const configured = this.rootPath(root);
    let resolved: string;
    try {
      resolved = await fs.realpath(configured);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw new PanelError('NOT_FOUND', '文件根不存在或不可访问', { root });
      }
      throw mapFsError(error, '访问文件根');
    }
    let stats: Stats;
    try {
      stats = await fs.stat(resolved);
    } catch (error) {
      throw mapFsError(error, '访问文件根');
    }
    if (!stats.isDirectory()) {
      throw new PanelError('BAD_REQUEST', '文件根不是目录', { root });
    }
    this.realRootCache.set(root, resolved);
    return resolved;
  }

  private async realpathNearest(absPath: string): Promise<string> {
    let current = absPath;
    for (;;) {
      try {
        return await fs.realpath(current);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw mapFsError(error, '解析路径');
        const parent = path.dirname(current);
        if (parent === current) throw mapFsError(error, '解析路径');
        current = parent;
      }
    }
  }

  private async checkComponents(
    realRoot: string,
    segments: readonly string[],
    allowFinalSymlink: boolean,
  ): Promise<string[]> {
    const checks: string[] = [];
    let current = realRoot;
    for (let index = 0; index < segments.length; index += 1) {
      current = path.join(current, segments[index]!);
      const isFinal = index === segments.length - 1;
      let stats: Stats;
      try {
        stats = await fs.lstat(current);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return checks;
        throw mapFsError(error, '解析路径');
      }
      checks.push(current);
      if (stats.isSymbolicLink()) {
        if (isFinal && allowFinalSymlink) continue;
        throw new PanelError('BAD_REQUEST', '不允许通过符号链接访问文件或目录', {
          hint: '请使用符号链接指向的真实路径',
        });
      }
      if (!isFinal && !stats.isDirectory()) {
        throw new PanelError('BAD_REQUEST', '路径中间段不是目录');
      }
    }
    return checks;
  }

  async resolve(root: string, virtualPath: string, opts: ResolveOptions = {}): Promise<string> {
    const relative = normalizeVirtualPath(virtualPath);
    const realRoot = await this.rootReal(root);
    const segments = splitVirtualPath(relative);
    const abs = segments.length === 0 ? realRoot : path.join(realRoot, ...segments);
    if (abs.length > MAX_VIRTUAL_PATH_LENGTH) {
      throw new PanelError('BAD_REQUEST', '路径过长（上限 4096 字符）');
    }
    await this.checkComponents(realRoot, segments, opts.allowSymlink === true);

    let exists = true;
    let stats: Stats | undefined;
    try {
      stats = await fs.lstat(abs);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        exists = false;
      } else {
        throw mapFsError(error, '解析路径');
      }
    }
    if (exists && stats !== undefined) {
      if (stats.isSymbolicLink() && opts.allowSymlink !== true) {
        throw new PanelError('BAD_REQUEST', '不允许通过符号链接访问文件或目录', {
          hint: '请使用符号链接指向的真实路径',
        });
      }
      let real: string;
      try {
        real = await fs.realpath(abs);
      } catch (error) {
        throw mapFsError(error, '解析路径');
      }
      if (!isInsideRoot(realRoot, real)) {
        throw new PanelError('FORBIDDEN', '目标超出文件根范围', {
          hint: '只允许访问文件根内的路径',
        });
      }
      return abs;
    }
    if (opts.allowMissing !== true) {
      throw new PanelError('NOT_FOUND', '文件或目录不存在');
    }
    const parentReal = await this.realpathNearest(path.dirname(abs));
    if (!isInsideRoot(realRoot, parentReal)) {
      throw new PanelError('FORBIDDEN', '目标超出文件根范围', {
        hint: '只允许访问文件根内的路径',
      });
    }
    return abs;
  }

  relative(root: string, absPath: string): string {
    const base = this.realRootCache.get(root) ?? this.rootPath(root);
    const target = path.resolve(absPath);
    const rel = path.relative(base, target);
    if (rel === '') return '/';
    if (path.isAbsolute(rel)) {
      throw new PanelError('FORBIDDEN', '路径超出文件根范围');
    }
    const posix = rel.split(path.sep).join('/');
    if (posix === '..' || posix.startsWith('../')) {
      throw new PanelError('FORBIDDEN', '路径超出文件根范围');
    }
    return `/${posix}`;
  }

  private async symlinkTargetType(realRoot: string, absPath: string): Promise<FileType | null> {
    let real: string;
    try {
      real = await fs.realpath(absPath);
    } catch {
      return null;
    }
    if (!isInsideRoot(realRoot, real)) return null;
    try {
      const stats = await fs.stat(real);
      return fileTypeOf(stats);
    } catch {
      return null;
    }
  }

  async describe(
    root: string,
    virtualPath: string,
    absPath: string,
    stats: Stats,
  ): Promise<FileItem> {
    const rel = normalizeVirtualPath(virtualPath);
    const type = fileTypeOf(stats);
    const realRoot = await this.rootReal(root);
    const item: FileItem = {
      name: rel === '/' ? root : virtualBasename(rel),
      root,
      path: rel,
      type,
      size: stats.isDirectory() && !stats.isSymbolicLink() ? 0 : stats.size,
      mtime: stats.mtime.toISOString(),
      ctime: stats.ctime.toISOString(),
      mode: formatMode(stats.mode),
      readonly: (stats.mode & 0o200) === 0,
      isSymlink: stats.isSymbolicLink(),
    };
    if (stats.isSymbolicLink()) {
      item.targetType = await this.symlinkTargetType(realRoot, absPath);
    }
    return item;
  }

  async stat(root: string, virtualPath: string): Promise<FileItem> {
    const rel = normalizeVirtualPath(virtualPath);
    const realRoot = await this.rootReal(root);
    const segments = splitVirtualPath(rel);
    const abs = segments.length === 0 ? realRoot : path.join(realRoot, ...segments);
    await this.checkComponents(realRoot, segments.slice(0, -1), false);
    let stats: Stats;
    try {
      stats = await fs.lstat(abs);
    } catch (error) {
      throw mapFsError(error, '读取文件信息');
    }
    return this.describe(root, rel, abs, stats);
  }

  async ensureDir(absPath: string, mode = 0o755): Promise<void> {
    try {
      await fs.mkdir(absPath, { recursive: true, mode });
    } catch (error) {
      throw mapFsError(error, '创建目录');
    }
  }

  async listRoots(): Promise<FileRoot[]> {
    const result: FileRoot[] = [];
    for (const root of this.roots) {
      let writable = true;
      try {
        await fs.access(root.path, fsConstants.W_OK);
      } catch {
        writable = false;
      }
      let freeBytes: number | null = null;
      let totalBytes: number | null = null;
      try {
        const stats = await fs.statfs(root.path);
        freeBytes = Number(stats.bavail) * Number(stats.bsize);
        totalBytes = Number(stats.blocks) * Number(stats.bsize);
      } catch {
        freeBytes = null;
        totalBytes = null;
      }
      result.push({
        name: root.name,
        path: root.path,
        writable,
        freeBytes,
        totalBytes,
      });
    }
    return result;
  }

  trashDir(): string {
    const configured = this.config.files?.trashDir;
    return path.isAbsolute(configured ?? '')
      ? path.resolve(configured!)
      : path.resolve(this.config.home, configured ?? 'trash');
  }

  private async trashLocations(): Promise<TrashLocation[]> {
    const base = this.trashDir();
    let dateDirs: Dirent[];
    try {
      dateDirs = await fs.readdir(base, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return [];
      throw mapFsError(error, '读取回收站');
    }
    const locations: TrashLocation[] = [];
    for (const dateDir of dateDirs) {
      if (!dateDir.isDirectory() || !ISO_DATE_PREFIX_RE.test(dateDir.name)) continue;
      const datePath = path.join(base, dateDir.name);
      let entryDirs: Dirent[];
      try {
        entryDirs = await fs.readdir(datePath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entryDir of entryDirs) {
        if (!entryDir.isDirectory() || !TRASH_ID_RE.test(entryDir.name)) continue;
        const dir = path.join(datePath, entryDir.name);
        try {
          const raw = await fs.readFile(path.join(dir, 'meta.json'), 'utf8');
          const parsed: unknown = JSON.parse(raw);
          if (trashEntryIsValid(parsed) && parsed.id === entryDir.name) {
            locations.push({ directory: dir, entry: parsed });
          }
        } catch {
          this.logger.warn('跳过损坏的回收站条目', { id: entryDir.name });
        }
      }
    }
    locations.sort((a, b) => {
      const delta = Date.parse(b.entry.trashedAt) - Date.parse(a.entry.trashedAt);
      return delta !== 0 ? delta : b.entry.id.localeCompare(a.entry.id);
    });
    return locations;
  }

  async trash(root: string, virtualPath: string): Promise<TrashEntry> {
    const rel = normalizeVirtualPath(virtualPath);
    if (rel === '/') {
      throw new PanelError('BAD_REQUEST', '不能删除文件根目录');
    }
    const abs = await this.resolve(root, rel);
    let stats: Stats;
    try {
      stats = await fs.lstat(abs);
    } catch (error) {
      throw mapFsError(error, '删除文件');
    }
    const trashedAt = new Date().toISOString();
    const id = generateTrashId();
    const date = trashedAt.slice(0, 10);
    const entryDir = path.join(this.trashDir(), date, id);
    const payload = path.join(entryDir, 'payload');
    const entry: TrashEntry = {
      id,
      root,
      originalPath: rel,
      trashedAt,
      sizeBytes: await computeTreeSize(abs, stats),
      type: fileTypeOf(stats) === 'symlink' ? 'symlink' : fileTypeOf(stats),
    };
    try {
      await this.ensureDir(entryDir, 0o700);
      await movePath(abs, payload, { symlinks: 'copy' });
      await writeTrashMeta(path.join(entryDir, 'meta.json'), entry);
      return entry;
    } catch (error) {
      try {
        if ((await pathExists(payload)) && !(await pathExists(abs))) {
          await movePath(payload, abs, { symlinks: 'copy' });
        }
      } catch {
        this.logger.warn('回收站回滚失败', { id });
      }
      try {
        await fs.rm(entryDir, { recursive: true, force: true });
      } catch {
        // 清理失败不覆盖原始错误。
      }
      throw mapFsError(error, '移入回收站');
    }
  }

  async listTrash(q: PageQuery): Promise<ListResult<TrashEntry>> {
    const locations = await this.trashLocations();
    const limit = parseLimit(q.limit, 50, LIST_LIMIT_MAX);
    const offset = q.cursor === undefined ? 0 : decodeOffsetCursor('trash', q.cursor);
    const page = locations.slice(offset, offset + limit).map((location) => location.entry);
    const nextCursor =
      offset + page.length < locations.length
        ? encodeOffsetCursor('trash', offset + page.length)
        : null;
    return { available: true, items: page, nextCursor, total: locations.length };
  }

  private async findTrashEntry(trashId: string): Promise<TrashLocation | null> {
    if (typeof trashId !== 'string' || !TRASH_ID_RE.test(trashId)) {
      throw new PanelError('BAD_REQUEST', '回收站条目 ID 不合法');
    }
    const locations = await this.trashLocations();
    return locations.find((location) => location.entry.id === trashId) ?? null;
  }

  async restoreTrash(req: TrashRestoreRequest): Promise<{ restored: true; path: string }> {
    const location = await this.findTrashEntry(req.trashId);
    if (location === null) {
      throw new PanelError('NOT_FOUND', '回收站条目不存在');
    }
    const entry = location.entry;
    if (!this.hasRoot(entry.root)) {
      throw new PanelError('BAD_REQUEST', '原始文件根已不存在，无法恢复', { root: entry.root });
    }
    const targetRel = normalizeVirtualPath(entry.originalPath);
    if (targetRel === '/') {
      throw new PanelError('BAD_REQUEST', '不能恢复到文件根目录');
    }
    const targetAbs = await this.resolve(entry.root, targetRel, {
      allowMissing: true,
      forWrite: true,
    });
    const targetExists = await pathExists(targetAbs);
    if (targetExists) {
      if (req.overwrite !== true) {
        throw new PanelError('CONFLICT', '恢复目标已存在', { path: targetRel });
      }
      try {
        await fs.rm(targetAbs, { recursive: true, force: true });
      } catch (error) {
        throw mapFsError(error, '清理恢复目标');
      }
    }
    const payload = path.join(location.directory, 'payload');
    if (!(await pathExists(payload))) {
      throw new PanelError('NOT_FOUND', '回收站内容已丢失');
    }
    try {
      await this.ensureDir(path.dirname(targetAbs));
      await movePath(payload, targetAbs, { symlinks: 'copy' });
    } catch (error) {
      throw mapFsError(error, '恢复文件');
    }
    await fs.rm(location.directory, { recursive: true, force: true }).catch(() => undefined);
    const parent = path.dirname(location.directory);
    await fs.rmdir(parent).catch(() => undefined);
    return { restored: true, path: targetRel };
  }

  async emptyTrash(req: TrashEmptyRequest): Promise<{ deleted: number }> {
    const locations = await this.trashLocations();
    const all = req.all === true;
    const requested = new Set<string>(Array.isArray(req.trashIds) ? req.trashIds : []);
    if (!all && requested.size === 0) {
      throw new PanelError('BAD_REQUEST', '请提供 trashIds 或 all=true');
    }
    let deleted = 0;
    for (const location of locations) {
      if (!all && !requested.has(location.entry.id)) continue;
      try {
        await fs.rm(location.directory, { recursive: true, force: true });
        deleted += 1;
        await fs.rmdir(path.dirname(location.directory)).catch(() => undefined);
      } catch (error) {
        this.logger.warn('清空回收站条目失败', { id: location.entry.id });
        void error;
      }
    }
    return { deleted };
  }

  async validateSiteRoot(absPath: string, opts: { allowMissing?: boolean } = {}): Promise<string> {
    if (typeof absPath !== 'string' || absPath.length === 0 || CONTROL_CHARS.test(absPath)) {
      throw new PanelError('BAD_REQUEST', '站点根路径不合法');
    }
    if (!path.isAbsolute(absPath)) {
      throw new PanelError('BAD_REQUEST', '站点根路径必须是绝对宿主机路径');
    }
    const resolvedInput = path.resolve(absPath);
    let real: string;
    try {
      real = await fs.realpath(resolvedInput);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' && opts.allowMissing === true) {
        real = await this.realpathNearest(resolvedInput);
      } else {
        throw mapFsError(error, '校验站点根目录');
      }
    }
    const allowed = [
      ...this.roots.map((root) => root.path),
      ...(Array.isArray(this.config.caddy?.sitesRoots) ? this.config.caddy.sitesRoots : []),
    ];
    for (const candidate of allowed) {
      if (typeof candidate !== 'string' || candidate.length === 0) continue;
      let realAllowed: string;
      try {
        realAllowed = await fs.realpath(path.resolve(candidate));
      } catch {
        continue;
      }
      if (isInsideRoot(realAllowed, real)) return real;
    }
    throw new PanelError('FORBIDDEN', '路径不在允许的站点根目录内');
  }
}

export function createFileSandbox(config: WorkerConfig, logger: ModuleLogger): FileSandbox {
  return new FileSandboxImpl(config, logger);
}
