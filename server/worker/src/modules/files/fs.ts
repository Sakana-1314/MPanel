import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import type { Stats } from 'node:fs';
import * as path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PanelError, isPanelError } from '@mpanel/shared';
import type {
  FileChmodRequest,
  FileCopyRequest,
  FileDownloadQuery,
  FileItem,
  FileListResult,
  FileMkdirRequest,
  FileReadResult,
  FileRenameRequest,
  FileRoot,
  FileWriteRequest,
  ModuleLogger,
} from '@mpanel/shared';
import type { WorkerConfig } from '../../config.js';
import type { PathSandbox } from '../../paths.js';
import {
  LIST_LIMIT_DEFAULT,
  LIST_LIMIT_MAX,
  copyTree,
  createFileSandbox,
  decodeOffsetCursor,
  encodeOffsetCursor,
  isReservedWindowsName,
  isVirtualInside,
  mapFsError,
  normalizeVirtualPath,
  pathExists,
  virtualBasename,
} from './sandbox.js';
import type { FileSandbox } from './sandbox.js';

/** read 接口的硬上限（任务要求 5 MiB；契约允许 maxBytes 最大 8 MiB）。 */
export const MAX_READ_BYTES = 5 * 1024 * 1024;
export const DEFAULT_READ_BYTES = 1024 * 1024;
/** PUT /files/write 的请求体上限（契约 20 MiB）。 */
export const MAX_WRITE_BYTES = 20 * 1024 * 1024;
export const MAX_COPY_FILES = 100_000;
export const MAX_COPY_BYTES = 5 * 1024 * 1024 * 1024;

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export interface FileDownloadOptions {
  range?: string;
}

export interface FileDownload {
  stream: NodeJS.ReadableStream;
  filename: string;
  size: number;
  start: number;
  end: number;
  length: number;
  partial: boolean;
  mtime: string;
}

export interface FileUploadOptions {
  overwrite?: boolean;
  createParents?: boolean;
}

export interface FileWriteOptions {
  createBackup?: boolean;
}

export interface FileDeleteOptions {
  root: string;
  path: string;
  permanent?: boolean;
}

export interface FileService {
  readonly maxUploadBytes: number;
  roots(): Promise<FileRoot[]>;
  list(q: {
    root: string;
    path?: string;
    showHidden?: boolean;
    limit?: number;
    cursor?: string;
  }): Promise<FileListResult>;
  stat(q: { root: string; path: string }): Promise<FileItem>;
  read(q: {
    root: string;
    path: string;
    encoding?: 'utf8' | 'base64';
    maxBytes?: number;
  }): Promise<FileReadResult>;
  write(req: FileWriteRequest, opts?: FileWriteOptions): Promise<FileItem>;
  mkdir(req: FileMkdirRequest): Promise<FileItem>;
  rename(req: FileRenameRequest): Promise<FileItem>;
  copy(req: FileCopyRequest): Promise<FileItem>;
  chmod(req: FileChmodRequest): Promise<FileItem>;
  delete(q: FileDeleteOptions): Promise<{ trashed: boolean; trashId?: string; path: string }>;
  upload(
    root: string,
    path: string,
    filename: string,
    stream: NodeJS.ReadableStream,
    opts?: FileUploadOptions,
  ): Promise<FileItem>;
  download(q: FileDownloadQuery, opts?: FileDownloadOptions): Promise<FileDownload>;
}

export interface FileServiceDeps {
  config: WorkerConfig;
  paths: PathSandbox;
  logger: ModuleLogger;
  sandbox?: FileSandbox;
}

function compareItems(a: FileItem, b: FileItem): number {
  const aDirectory = a.type === 'directory' ? 0 : 1;
  const bDirectory = b.type === 'directory' ? 0 : 1;
  if (aDirectory !== bDirectory) return aDirectory - bDirectory;
  const aLower = a.name.toLowerCase();
  const bLower = b.name.toLowerCase();
  if (aLower !== bLower) return aLower < bLower ? -1 : 1;
  if (a.name === b.name) return 0;
  return a.name < b.name ? -1 : 1;
}

function parseOctalMode(mode: string): number {
  if (typeof mode !== 'string' || !/^[0-7]{3,4}$/.test(mode)) {
    throw new PanelError('BAD_REQUEST', '权限位必须是 3 或 4 位八进制数字');
  }
  return Number.parseInt(mode, 8);
}

function decodeContent(content: string, encoding: 'utf8' | 'base64' | undefined): Buffer {
  if (typeof content !== 'string') {
    throw new PanelError('BAD_REQUEST', 'content 必须是字符串');
  }
  if (encoding === 'base64') {
    const cleaned = content.replace(/\s+/g, '');
    if (cleaned.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) {
      throw new PanelError('BAD_REQUEST', 'content 不是合法的 base64 编码');
    }
    return Buffer.from(cleaned, 'base64');
  }
  return Buffer.from(content, 'utf8');
}

function looksBinary(buffer: Buffer, truncated: boolean): boolean {
  if (buffer.length === 0) return false;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.includes(0)) return true;
  let control = 0;
  for (const byte of sample) {
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20) || byte === 0x7f) control += 1;
  }
  if (control > 0 && control / sample.length > 0.1) return true;
  if (!truncated) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      return true;
    }
  }
  return false;
}

async function readHead(absPath: string, maxBytes: number, size: number): Promise<Buffer> {
  if (size === 0) return Buffer.alloc(0);
  const length = Math.min(size, maxBytes);
  let handle;
  try {
    handle = await fs.open(absPath, 'r');
  } catch (error) {
    throw mapFsError(error, '读取文件');
  }
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } catch (error) {
    throw mapFsError(error, '读取文件');
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function writeFileAtomic(absPath: string, data: Buffer, mode: number): Promise<void> {
  const temp = path.join(
    path.dirname(absPath),
    `.${path.basename(absPath)}.mpanel-${randomBytes(6).toString('hex')}.tmp`,
  );
  let handle;
  try {
    handle = await fs.open(temp, 'wx', mode);
    await handle.writeFile(data);
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw mapFsError(error, '保存文件');
  }
  await handle.close().catch(() => undefined);
  try {
    await fs.rename(temp, absPath);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw mapFsError(error, '保存文件');
  }
}

export function sanitizeFilename(input: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new PanelError('BAD_REQUEST', '缺少上传文件名');
  }
  const normalized = input.replace(/\\/g, '/');
  const parts = normalized.split('/').filter((part) => part.length > 0);
  let name = parts.length > 0 ? parts[parts.length - 1]! : '';
  name = name.replace(/[\u0000-\u001f\u007f]/g, '');
  name = name.replace(/[<>:"|?*]/g, '_');
  name = name.replace(/[. ]+$/, '');
  if (name === '' || name === '.' || name === '..') {
    throw new PanelError('BAD_REQUEST', '上传文件名不合法');
  }
  if (isReservedWindowsName(name)) {
    name = `_${name}`;
  }
  if (Buffer.byteLength(name, 'utf8') > 255) {
    throw new PanelError('BAD_REQUEST', '上传文件名过长（上限 255 字节）');
  }
  return name;
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.txt': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/plain; charset=utf-8',
  '.sh': 'text/x-shellscript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.wasm': 'application/wasm',
};

export function guessMimeType(filename: string): string {
  const extension = path.extname(filename).toLowerCase();
  return MIME_TYPES[extension] ?? 'application/octet-stream';
}

export function buildContentDisposition(filename: string): string {
  const fallback =
    filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function formatMiB(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MiB`;
}

interface RangeSlice {
  start: number;
  end: number;
  length: number;
  partial: boolean;
}

function parseRangeHeader(header: string | undefined, size: number): RangeSlice {
  const full: RangeSlice = {
    start: 0,
    end: size > 0 ? size - 1 : 0,
    length: size,
    partial: false,
  };
  if (header === undefined || header.length === 0) return full;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return full;
  const rawStart = match[1] ?? '';
  const rawEnd = match[2] ?? '';
  if (rawStart === '' && rawEnd === '') return full;
  if (size === 0) {
    throw new PanelError('BAD_REQUEST', 'Range 请求超出文件大小');
  }
  let start: number;
  let end: number;
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!Number.isInteger(suffix) || suffix <= 0) return full;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    throw new PanelError('BAD_REQUEST', 'Range 请求格式不合法');
  }
  if (start >= size) {
    throw new PanelError('BAD_REQUEST', 'Range 请求超出文件大小', { size });
  }
  end = Math.min(end, size - 1);
  return { start, end, length: end - start + 1, partial: true };
}

class FileServiceImpl implements FileService {
  readonly maxUploadBytes: number;
  private readonly logger: ModuleLogger;
  private readonly sandbox: FileSandbox;

  constructor(deps: FileServiceDeps) {
    this.logger = deps.logger;
    this.sandbox = deps.sandbox ?? createFileSandbox(deps.config, deps.logger);
    this.maxUploadBytes = Math.max(
      1,
      Math.floor(deps.config.files?.maxUploadBytes ?? 100 * 1024 * 1024),
    );
  }

  async roots(): Promise<FileRoot[]> {
    return this.sandbox.listRoots();
  }

  async list(q: {
    root: string;
    path?: string;
    showHidden?: boolean;
    limit?: number;
    cursor?: string;
  }): Promise<FileListResult> {
    const root = q.root;
    const relative = normalizeVirtualPath(q.path ?? '/');
    const abs = await this.sandbox.resolve(root, relative);
    let directoryStats: Stats;
    try {
      directoryStats = await fs.lstat(abs);
    } catch (error) {
      throw mapFsError(error, '读取目录');
    }
    if (!directoryStats.isDirectory()) {
      throw new PanelError('BAD_REQUEST', '目标不是目录，无法列出内容');
    }
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch (error) {
      throw mapFsError(error, '读取目录');
    }
    const showHidden = q.showHidden === true;
    const items: FileItem[] = [];
    for (const entry of entries) {
      if (entry.name === '.mpanel-tmp') continue;
      if (!showHidden && entry.name.startsWith('.')) continue;
      const entryAbs = path.join(abs, entry.name);
      let stats: Stats;
      try {
        stats = await fs.lstat(entryAbs);
      } catch {
        continue;
      }
      const entryRel = relative === '/' ? `/${entry.name}` : `${relative}/${entry.name}`;
      items.push(await this.sandbox.describe(root, entryRel, entryAbs, stats));
    }
    items.sort(compareItems);
    const limit =
      typeof q.limit === 'number' && Number.isInteger(q.limit) && q.limit >= 1
        ? Math.min(q.limit, LIST_LIMIT_MAX)
        : LIST_LIMIT_DEFAULT;
    const offset = q.cursor === undefined ? 0 : decodeOffsetCursor('files', q.cursor);
    const page = items.slice(offset, offset + limit);
    const nextCursor =
      offset + page.length < items.length
        ? encodeOffsetCursor('files', offset + page.length)
        : null;
    return {
      available: true,
      items: page,
      root,
      path: relative,
      nextCursor,
      total: items.length,
    };
  }

  async stat(q: { root: string; path: string }): Promise<FileItem> {
    return this.sandbox.stat(q.root, q.path);
  }

  async read(q: {
    root: string;
    path: string;
    encoding?: 'utf8' | 'base64';
    maxBytes?: number;
  }): Promise<FileReadResult> {
    const relative = normalizeVirtualPath(q.path);
    const abs = await this.sandbox.resolve(q.root, relative);
    let stats: Stats;
    try {
      stats = await fs.lstat(abs);
    } catch (error) {
      throw mapFsError(error, '读取文件');
    }
    if (stats.isDirectory()) {
      throw new PanelError('BAD_REQUEST', '目标是目录，无法读取');
    }
    if (!stats.isFile()) {
      throw new PanelError('BAD_REQUEST', '只支持读取普通文件');
    }
    const requested = typeof q.maxBytes === 'number' ? q.maxBytes : DEFAULT_READ_BYTES;
    const maxBytes = Math.min(Math.max(Math.trunc(requested), 1), MAX_READ_BYTES);
    const truncated = stats.size > maxBytes;
    const buffer = await readHead(abs, maxBytes, stats.size);
    const binary = looksBinary(buffer, truncated);
    const encoding: 'utf8' | 'base64' =
      q.encoding === 'base64' || binary ? 'base64' : 'utf8';
    return {
      content: encoding === 'base64' ? buffer.toString('base64') : buffer.toString('utf8'),
      encoding,
      size: stats.size,
      truncated,
      mtime: stats.mtime.toISOString(),
      isBinary: binary,
    };
  }

  async write(req: FileWriteRequest, opts: FileWriteOptions = {}): Promise<FileItem> {
    const root = req.root;
    const relative = normalizeVirtualPath(req.path);
    if (relative === '/') {
      throw new PanelError('BAD_REQUEST', '不能写入文件根目录');
    }
    const data = decodeContent(req.content, req.encoding);
    if (data.length > MAX_WRITE_BYTES) {
      throw new PanelError('BAD_REQUEST', `写入内容超过 ${formatMiB(MAX_WRITE_BYTES)} 上限`);
    }
    const abs = await this.sandbox.resolve(root, relative, {
      allowMissing: true,
      forWrite: true,
    });
    let stats: Stats | null = null;
    try {
      stats = await fs.lstat(abs);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw mapFsError(error, '写入文件');
    }
    if (stats !== null) {
      if (stats.isDirectory()) {
        throw new PanelError('BAD_REQUEST', '目标是目录，无法写入');
      }
      if (!stats.isFile()) {
        throw new PanelError('BAD_REQUEST', '目标不是普通文件');
      }
      if (req.overwrite === false) {
        throw new PanelError('CONFLICT', '目标已存在且 overwrite=false', { path: relative });
      }
      if (req.expectedMtime !== undefined) {
        const expected = Date.parse(req.expectedMtime);
        if (Number.isNaN(expected)) {
          throw new PanelError('BAD_REQUEST', 'expectedMtime 不是合法时间');
        }
        if (Math.abs(stats.mtimeMs - expected) > 1) {
          throw new PanelError('CONFLICT', '文件已被修改，请刷新后重试', { path: relative });
        }
      }
    } else if (req.create === false) {
      throw new PanelError('CONFLICT', '文件不存在且 create=false', { path: relative });
    }
    const mode = stats !== null ? stats.mode & 0o777 : 0o644;
    if (opts.createBackup === true && stats !== null) {
      try {
        await fs.copyFile(abs, `${abs}.bak`);
      } catch (error) {
        throw mapFsError(error, '创建写入备份');
      }
    }
    await writeFileAtomic(abs, data, mode);
    return this.sandbox.stat(root, relative);
  }

  async mkdir(req: FileMkdirRequest): Promise<FileItem> {
    const root = req.root;
    const relative = normalizeVirtualPath(req.path);
    const recursive = req.recursive === true;
    const abs = await this.sandbox.resolve(root, relative, {
      allowMissing: true,
      forWrite: true,
    });
    const exists = await pathExists(abs);
    if (exists) {
      const stats = await fs.lstat(abs);
      if (stats.isDirectory() && recursive) {
        return this.sandbox.describe(root, relative, abs, stats);
      }
      throw new PanelError('CONFLICT', '目标已存在', { path: relative });
    }
    const mode = req.mode === undefined ? 0o755 : parseOctalMode(req.mode);
    try {
      await fs.mkdir(abs, { recursive, mode });
    } catch (error) {
      throw mapFsError(error, '创建目录');
    }
    if (!(await pathExists(abs))) {
      throw new PanelError('INTERNAL', '创建目录失败');
    }
    return this.sandbox.stat(root, relative);
  }

  async rename(req: FileRenameRequest): Promise<FileItem> {
    const root = req.root;
    const from = normalizeVirtualPath(req.from);
    const to = normalizeVirtualPath(req.to);
    if (from === '/' || to === '/') {
      throw new PanelError('BAD_REQUEST', '不能重命名文件根目录');
    }
    if (from === to) {
      return this.sandbox.stat(root, from);
    }
    if (isVirtualInside(from, to)) {
      throw new PanelError('BAD_REQUEST', '目标路径不能位于源目录内部');
    }
    const fromAbs = await this.sandbox.resolve(root, from);
    const toAbs = await this.sandbox.resolve(root, to, { allowMissing: true, forWrite: true });
    let sourceStats: Stats;
    try {
      sourceStats = await fs.lstat(fromAbs);
    } catch (error) {
      throw mapFsError(error, '重命名');
    }
    if (await pathExists(toAbs)) {
      if (req.overwrite !== true) {
        throw new PanelError('CONFLICT', '目标已存在', { path: to });
      }
      let targetStats: Stats;
      try {
        targetStats = await fs.lstat(toAbs);
      } catch (error) {
        throw mapFsError(error, '重命名');
      }
      if (sourceStats.isDirectory() !== targetStats.isDirectory()) {
        throw new PanelError('CONFLICT', '源与目标类型不一致，无法覆盖', { path: to });
      }
      try {
        await fs.rm(toAbs, { recursive: true, force: true });
      } catch (error) {
        throw mapFsError(error, '删除目标');
      }
    }
    try {
      await fs.rename(fromAbs, toAbs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
        try {
          await copyTree(fromAbs, toAbs, {
            maxFiles: MAX_COPY_FILES,
            maxBytes: MAX_COPY_BYTES,
            symlinks: 'reject',
          });
          await fs.rm(fromAbs, { recursive: true, force: true });
        } catch (copyError) {
          await fs.rm(toAbs, { recursive: true, force: true }).catch(() => undefined);
          throw mapFsError(copyError, '重命名');
        }
      } else {
        throw mapFsError(error, '重命名');
      }
    }
    return this.sandbox.stat(root, to);
  }

  async copy(req: FileCopyRequest): Promise<FileItem> {
    const root = req.root;
    const from = normalizeVirtualPath(req.from);
    const to = normalizeVirtualPath(req.to);
    if (to === '/') {
      throw new PanelError('BAD_REQUEST', '不能覆盖文件根目录');
    }
    if (from === to) {
      throw new PanelError('BAD_REQUEST', '源路径与目标路径相同');
    }
    if (isVirtualInside(from, to)) {
      throw new PanelError('BAD_REQUEST', '目标路径不能位于源目录内部');
    }
    const fromAbs = await this.sandbox.resolve(root, from);
    const toAbs = await this.sandbox.resolve(root, to, { allowMissing: true, forWrite: true });
    let sourceStats: Stats;
    try {
      sourceStats = await fs.lstat(fromAbs);
    } catch (error) {
      throw mapFsError(error, '复制');
    }
    const targetExisted = await pathExists(toAbs);
    if (targetExisted) {
      if (req.overwrite !== true) {
        throw new PanelError('CONFLICT', '目标已存在', { path: to });
      }
      let targetStats: Stats;
      try {
        targetStats = await fs.lstat(toAbs);
      } catch (error) {
        throw mapFsError(error, '复制');
      }
      if (sourceStats.isDirectory() !== targetStats.isDirectory()) {
        throw new PanelError('CONFLICT', '源与目标类型不一致，无法覆盖', { path: to });
      }
    }
    const temp = path.join(
      path.dirname(toAbs),
      `.${path.basename(toAbs)}.mpanel-copy-${randomBytes(6).toString('hex')}`,
    );
    try {
      if (sourceStats.isDirectory()) {
        await copyTree(fromAbs, temp, {
          maxFiles: MAX_COPY_FILES,
          maxBytes: MAX_COPY_BYTES,
          symlinks: 'reject',
        });
      } else if (sourceStats.isFile()) {
        if (sourceStats.size > MAX_COPY_BYTES) {
          throw new PanelError('BAD_REQUEST', '复制内容超过上限（5 GiB）');
        }
        await fs.copyFile(fromAbs, temp);
        await fs.chmod(temp, sourceStats.mode & 0o777).catch(() => undefined);
      } else {
        throw new PanelError('BAD_REQUEST', '不支持复制特殊文件（设备/管道等）');
      }
      if (targetExisted) {
        try {
          await fs.rm(toAbs, { recursive: true, force: true });
        } catch (error) {
          throw mapFsError(error, '删除目标');
        }
      }
      await fs.rename(temp, toAbs);
    } catch (error) {
      await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
      throw isPanelError(error) ? error : mapFsError(error, '复制');
    }
    return this.sandbox.stat(root, to);
  }

  async chmod(req: FileChmodRequest): Promise<FileItem> {
    const root = req.root;
    const relative = normalizeVirtualPath(req.path);
    const mode = parseOctalMode(req.mode);
    if (mode > 0o7777) {
      throw new PanelError('BAD_REQUEST', '权限位必须在 0000-7777 之间');
    }
    const abs = await this.sandbox.resolve(root, relative, { forWrite: true });
    try {
      if (process.platform === 'win32') {
        const writable = (mode & 0o200) !== 0;
        await fs.chmod(abs, writable ? 0o666 : 0o444);
      } else {
        await fs.chmod(abs, mode);
      }
    } catch (error) {
      throw mapFsError(error, '修改权限');
    }
    return this.sandbox.stat(root, relative);
  }

  async delete(
    q: FileDeleteOptions,
  ): Promise<{ trashed: boolean; trashId?: string; path: string }> {
    const root = q.root;
    const relative = normalizeVirtualPath(q.path);
    if (relative === '/') {
      throw new PanelError('BAD_REQUEST', '不能删除文件根目录');
    }
    if (q.permanent === true) {
      const abs = await this.sandbox.resolve(root, relative, { forWrite: true });
      try {
        await fs.rm(abs, { recursive: true, force: true });
      } catch (error) {
        throw mapFsError(error, '删除文件');
      }
      return { trashed: false, path: relative };
    }
    const entry = await this.sandbox.trash(root, relative);
    return { trashed: true, trashId: entry.id, path: relative };
  }

  async upload(
    root: string,
    targetPath: string,
    filename: string,
    stream: NodeJS.ReadableStream,
    opts: FileUploadOptions = {},
  ): Promise<FileItem> {
    const directoryRel = normalizeVirtualPath(
      typeof targetPath === 'string' && targetPath.length > 0 ? targetPath : '/',
    );
    let directoryAbs: string;
    try {
      directoryAbs = await this.sandbox.resolve(root, directoryRel);
    } catch (error) {
      if (opts.createParents !== true) throw error;
      directoryAbs = await this.sandbox.resolve(root, directoryRel, {
        allowMissing: true,
        forWrite: true,
      });
      try {
        await fs.mkdir(directoryAbs, { recursive: true, mode: 0o755 });
      } catch (mkdirError) {
        throw mapFsError(mkdirError, '创建上传目录');
      }
    }
    let directoryStats: Stats;
    try {
      directoryStats = await fs.lstat(directoryAbs);
    } catch (error) {
      throw mapFsError(error, '读取上传目录');
    }
    if (!directoryStats.isDirectory()) {
      throw new PanelError('BAD_REQUEST', '上传目标不是目录');
    }
    const safeName = sanitizeFilename(filename);
    const relative =
      directoryRel === '/' ? `/${safeName}` : `${directoryRel}/${safeName}`;
    const abs = await this.sandbox.resolve(root, relative, {
      allowMissing: true,
      forWrite: true,
    });
    let targetStats: Stats | null = null;
    try {
      targetStats = await fs.lstat(abs);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw mapFsError(error, '检查上传目标');
    }
    if (targetStats !== null) {
      if (!targetStats.isFile()) {
        throw new PanelError('CONFLICT', '同名目标不是普通文件', { path: relative });
      }
      if (opts.overwrite !== true) {
        throw new PanelError('CONFLICT', '同名文件已存在（overwrite=false）', {
          path: relative,
        });
      }
    }
    const temp = path.join(
      path.dirname(abs),
      `.${safeName}.mpanel-upload-${randomBytes(6).toString('hex')}.tmp`,
    );
    const maxBytes = this.maxUploadBytes;
    let written = 0;
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        written += chunk.length;
        if (written > maxBytes) {
          callback(
            new PanelError('BAD_REQUEST', `上传文件超过上限（${formatMiB(maxBytes)}）`, {
              hint: '请压缩或拆分文件后重试',
            }),
          );
          return;
        }
        callback(null, chunk);
      },
    });
    try {
      await pipeline(stream, counter, createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
      const handle = await fs.open(temp, 'r+');
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      try {
        await fs.rename(temp, abs);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
          targetStats !== null &&
          (code === 'EEXIST' || code === 'EPERM' || code === 'ENOTEMPTY')
        ) {
          await fs.rm(abs, { force: true });
          await fs.rename(temp, abs);
        } else {
          throw error;
        }
      }
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined);
      throw isPanelError(error) ? error : mapFsError(error, '保存上传文件');
    }
    this.logger.debug('上传文件已保存', { root, path: relative });
    return this.sandbox.stat(root, relative);
  }

  async download(q: FileDownloadQuery, opts: FileDownloadOptions = {}): Promise<FileDownload> {
    const root = q.root;
    const relative = normalizeVirtualPath(q.path);
    const abs = await this.sandbox.resolve(root, relative);
    let stats: Stats;
    try {
      stats = await fs.lstat(abs);
    } catch (error) {
      throw mapFsError(error, '下载文件');
    }
    if (stats.isDirectory()) {
      throw new PanelError('BAD_REQUEST', '目录不能直接下载，请先打包');
    }
    if (!stats.isFile()) {
      throw new PanelError('BAD_REQUEST', '只支持下载普通文件');
    }
    const slice = parseRangeHeader(opts.range, stats.size);
    const stream = createReadStream(
      abs,
      slice.partial ? { start: slice.start, end: slice.end } : undefined,
    );
    return {
      stream,
      filename: virtualBasename(relative),
      size: stats.size,
      start: slice.start,
      end: slice.end,
      length: slice.length,
      partial: slice.partial,
      mtime: stats.mtime.toISOString(),
    };
  }
}

export function createFileService(deps: FileServiceDeps): FileService {
  return new FileServiceImpl(deps);
}
