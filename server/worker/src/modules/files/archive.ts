import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import * as path from 'node:path';
import { PanelError, isPanelError } from '@mpanel/shared';
import type {
  CommandResult,
  CommandRunner,
  FileArchiveRequest,
  FileArchiveResult,
  FileExtractRequest,
  FileExtractResult,
  ModuleLogger,
} from '@mpanel/shared';
import type { WorkerConfig } from '../../config.js';
import type { PathSandbox } from '../../paths.js';
import {
  createFileSandbox,
  isVirtualInside,
  mapFsError,
  normalizeVirtualPath,
  pathExists,
} from './sandbox.js';
import type { FileSandbox } from './sandbox.js';

export interface ArchiveService {
  archive(req: FileArchiveRequest): Promise<FileArchiveResult>;
  extract(req: FileExtractRequest): Promise<FileExtractResult>;
}

export interface ArchiveServiceDeps {
  config: WorkerConfig;
  paths: PathSandbox;
  logger: ModuleLogger;
  runner?: CommandRunner;
  sandbox?: FileSandbox;
}

const MAX_TREE_ENTRIES = 100_000;
const MAX_TREE_BYTES = 5 * 1024 * 1024 * 1024;
const RUN_TIMEOUT_MS = 600_000;
const RUN_MAX_BUFFER = 8 * 1024 * 1024;

interface TreeEntry {
  rel: string;
  abs: string;
  isDir: boolean;
  stats: Stats;
}

interface SourceCounts {
  entries: number;
  bytes: number;
}

class ArchiveServiceImpl implements ArchiveService {
  private readonly config: WorkerConfig;
  private readonly logger: ModuleLogger;
  private readonly runner: CommandRunner | undefined;
  private readonly sandbox: FileSandbox;

  constructor(deps: ArchiveServiceDeps) {
    this.config = deps.config;
    this.logger = deps.logger;
    this.runner = deps.runner;
    this.sandbox = deps.sandbox ?? createFileSandbox(deps.config, deps.logger);
  }

  private requireRunner(): CommandRunner {
    if (this.runner === undefined) {
      throw new PanelError('UNAVAILABLE', '归档功能不可用', {
        hint: 'worker 未配置命令执行器，无法调用 tar',
      });
    }
    return this.runner;
  }

  private async toolPath(runner: CommandRunner, tool: string): Promise<string> {
    let resolved: string | null = null;
    try {
      resolved = await runner.which(tool);
    } catch {
      resolved = null;
    }
    if (resolved === null || resolved.length === 0) {
      throw new PanelError('UNAVAILABLE', `未找到 ${tool} 命令`, {
        capability: tool,
        hint: `在 worker 主机安装 ${tool} 后重试`,
      });
    }
    return resolved;
  }

  private sanitize(text: string): string {
    let output = text;
    const secrets = [
      ...this.sandbox.roots.map((root) => root.path),
      path.resolve(this.config.home),
    ].filter((item) => item.length > 0);
    for (const secret of secrets) {
      output = output.split(secret).join('[root]');
    }
    return output;
  }

  private async run(
    runner: CommandRunner,
    command: string,
    args: readonly string[],
    cwd?: string,
  ): Promise<CommandResult> {
    try {
      return await runner.run(command, args, {
        cwd,
        timeoutMs: RUN_TIMEOUT_MS,
        maxBufferBytes: RUN_MAX_BUFFER,
      });
    } catch {
      throw new PanelError('UNAVAILABLE', '无法执行归档命令', {
        capability: 'tar',
        hint: '检查 tar 是否可执行、worker 主机资源是否充足后重试',
      });
    }
  }

  private toolFailure(action: string, result: CommandResult): PanelError {
    this.logger.warn('归档命令执行失败', {
      action,
      exitCode: result.code,
      stderr: this.sanitize(result.stderr).slice(-500),
    });
    return new PanelError('UNAVAILABLE', `${action}失败`, {
      capability: 'tar',
      exitCode: result.code,
      hint: '检查文件权限、磁盘空间与 tar 版本后重试',
    });
  }

  private async inspectSources(root: string, sources: readonly string[]): Promise<SourceCounts> {
    let entries = 0;
    let bytes = 0;
    for (const source of sources) {
      const abs = await this.sandbox.resolve(root, source);
      let stats: Stats;
      try {
        stats = await fs.lstat(abs);
      } catch (error) {
        throw mapFsError(error, '读取打包源');
      }
      if (stats.isSymbolicLink()) {
        throw new PanelError('BAD_REQUEST', '不允许打包符号链接');
      }
      if (stats.isFile()) {
        entries += 1;
        bytes += stats.size;
      } else if (stats.isDirectory()) {
        const stack: string[] = [abs];
        while (stack.length > 0) {
          const dir = stack.pop()!;
          let children: Dirent[];
          try {
            children = await fs.readdir(dir, { withFileTypes: true });
          } catch (error) {
            throw mapFsError(error, '读取打包目录');
          }
          for (const child of children) {
            const childAbs = path.join(dir, child.name);
            let childStats: Stats;
            try {
              childStats = await fs.lstat(childAbs);
            } catch (error) {
              throw mapFsError(error, '读取打包目录');
            }
            if (childStats.isSymbolicLink()) {
              throw new PanelError('BAD_REQUEST', '打包内容包含符号链接，已拒绝', {
                hint: '归档中的链接可能指向文件根之外，请先移除',
              });
            }
            if (childStats.isDirectory()) {
              stack.push(childAbs);
              continue;
            }
            if (!childStats.isFile()) {
              throw new PanelError('BAD_REQUEST', '打包内容包含特殊文件（设备/管道等）');
            }
            entries += 1;
            bytes += childStats.size;
            if (entries > MAX_TREE_ENTRIES || bytes > MAX_TREE_BYTES) {
              throw new PanelError('BAD_REQUEST', '打包内容超过上限（10 万条目 / 5 GiB）');
            }
          }
        }
      } else {
        throw new PanelError('BAD_REQUEST', '不支持打包该类型的路径');
      }
      if (entries > MAX_TREE_ENTRIES || bytes > MAX_TREE_BYTES) {
        throw new PanelError('BAD_REQUEST', '打包内容超过上限（10 万条目 / 5 GiB）');
      }
    }
    return { entries, bytes };
  }

  private toolRelative(realRoot: string, absPath: string): string {
    const relative = path.relative(realRoot, absPath);
    if (relative === '' || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      throw new PanelError('INTERNAL', '归档临时路径超出文件根范围');
    }
    return relative.split(path.sep).join('/');
  }

  private async writeZip(
    runner: CommandRunner,
    tar: string,
    archiveArg: string,
    relativeSources: readonly string[],
    cwd: string,
  ): Promise<void> {
    let zipBinary: string | null = null;
    try {
      zipBinary = await runner.which('zip');
    } catch {
      zipBinary = null;
    }
    if (zipBinary !== null && zipBinary.length > 0) {
      const result = await this.run(
        runner,
        zipBinary,
        ['-r', '-q', '-X', archiveArg, ...relativeSources],
        cwd,
      );
      if (result.code !== 0) throw this.toolFailure('创建 zip 归档', result);
      return;
    }
    const version = await this.run(runner, tar, ['--version'], cwd);
    const isBsdtar = /bsdtar|libarchive/i.test(`${version.stdout}${version.stderr}`);
    if (!isBsdtar) {
      throw new PanelError('UNAVAILABLE', '当前系统不支持创建 zip 归档', {
        capability: 'zip',
        hint: '安装 zip 或 bsdtar/libarchive（支持 zip 的 tar）后重试',
      });
    }
    const result = await this.run(
      runner,
      tar,
      ['-a', '-cf', archiveArg, '--', ...relativeSources],
      cwd,
    );
    if (result.code !== 0) {
      throw new PanelError('UNAVAILABLE', '创建 zip 归档失败', {
        capability: 'zip',
        hint: '安装 zip 或 bsdtar/libarchive 后重试',
      });
    }
  }

  async archive(req: FileArchiveRequest): Promise<FileArchiveResult> {
    const runner = this.requireRunner();
    const tar = await this.toolPath(runner, 'tar');
    const root = req.root;
    const format = req.format;
    const sources = req.paths.map((item) => normalizeVirtualPath(item));
    const destination = normalizeVirtualPath(req.destination);
    if (sources.length === 0) {
      throw new PanelError('BAD_REQUEST', '请至少选择一个要打包的路径');
    }
    if (destination === '/') {
      throw new PanelError('BAD_REQUEST', '归档目标不能是文件根目录');
    }
    for (const source of sources) {
      if (source === '/') {
        throw new PanelError('BAD_REQUEST', '不能打包文件根目录本身');
      }
      if (isVirtualInside(source, destination)) {
        throw new PanelError('BAD_REQUEST', '归档目标不能位于源路径内', { path: destination });
      }
    }
    const realRoot = await this.sandbox.resolve(root, '/');
    const counts = await this.inspectSources(root, sources);
    const destAbs = await this.sandbox.resolve(root, destination, {
      allowMissing: true,
      forWrite: true,
    });
    if (await pathExists(destAbs)) {
      throw new PanelError('CONFLICT', '归档目标已存在', { path: destination });
    }
    let parentStats: Stats;
    try {
      parentStats = await fs.stat(path.dirname(destAbs));
    } catch (error) {
      throw mapFsError(error, '检查归档目标目录');
    }
    if (!parentStats.isDirectory()) {
      throw new PanelError('BAD_REQUEST', '归档目标目录不存在');
    }
    const tempDir = path.join(realRoot, '.mpanel-tmp');
    await this.sandbox.ensureDir(tempDir, 0o700);
    const extension = format === 'tar.gz' ? '.tar.gz' : format === 'zip' ? '.zip' : '.tar';
    const tempFile = path.join(
      tempDir,
      `mpanel-archive-${randomBytes(6).toString('hex')}${extension}`,
    );
    const relativeSources = sources.map((source) => source.slice(1));
    const archiveArg = this.toolRelative(realRoot, tempFile);
    try {
      if (format === 'zip') {
        await this.writeZip(runner, tar, archiveArg, relativeSources, realRoot);
      } else {
        const args =
          format === 'tar.gz'
            ? ['-czf', archiveArg, '--', ...relativeSources]
            : ['-cf', archiveArg, '--', ...relativeSources];
        const result = await this.run(runner, tar, args, realRoot);
        if (result.code !== 0) throw this.toolFailure('创建归档', result);
      }
      let tempStats: Stats;
      try {
        tempStats = await fs.stat(tempFile);
      } catch (error) {
        throw mapFsError(error, '创建归档');
      }
      try {
        await fs.rename(tempFile, destAbs);
      } catch (error) {
        throw mapFsError(error, '保存归档');
      }
      return {
        path: destination,
        format,
        sizeBytes: tempStats.size,
        entries: counts.entries,
      };
    } finally {
      await fs.rm(tempFile, { force: true }).catch(() => undefined);
    }
  }

  private inferFormat(name: string): 'zip' | 'tar' | 'tar.gz' {
    const lower = name.toLowerCase();
    if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz';
    if (lower.endsWith('.zip')) return 'zip';
    if (lower.endsWith('.tar')) return 'tar';
    throw new PanelError('BAD_REQUEST', '无法识别归档格式，请显式指定 format');
  }

  private validateEntryName(raw: string): string {
    let normalized: string;
    try {
      normalized = normalizeVirtualPath(`/${raw}`);
    } catch (error) {
      if (isPanelError(error)) {
        throw new PanelError('BAD_REQUEST', '归档包含不安全的条目路径，已拒绝');
      }
      throw error;
    }
    return normalized;
  }

  private listFailure(format: 'zip' | 'tar' | 'tar.gz', result: CommandResult): PanelError {
    this.logger.warn('读取归档条目失败', {
      format,
      exitCode: result.code,
      stderr: this.sanitize(result.stderr).slice(-500),
    });
    if (format === 'zip') {
      return new PanelError('UNAVAILABLE', '当前系统无法读取 zip 归档', {
        capability: 'zip',
        hint: '安装 bsdtar/libarchive（支持 zip 的 tar）后重试，或改用 tar/tar.gz 归档',
      });
    }
    return new PanelError('BAD_REQUEST', '无法读取归档内容，文件可能已损坏');
  }

  private extractFailure(format: 'zip' | 'tar' | 'tar.gz', result: CommandResult): PanelError {
    this.logger.warn('解压归档失败', {
      format,
      exitCode: result.code,
      stderr: this.sanitize(result.stderr).slice(-500),
    });
    return new PanelError('BAD_REQUEST', '解压归档失败，文件可能已损坏');
  }

  private async collectStaging(staging: string): Promise<TreeEntry[]> {
    const entries: TreeEntry[] = [];
    let bytes = 0;
    const stack: string[] = [staging];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let children: Dirent[];
      try {
        children = await fs.readdir(dir, { withFileTypes: true });
      } catch (error) {
        throw mapFsError(error, '校验解压结果');
      }
      for (const child of children) {
        const abs = path.join(dir, child.name);
        let stats: Stats;
        try {
          stats = await fs.lstat(abs);
        } catch (error) {
          throw mapFsError(error, '校验解压结果');
        }
        if (stats.isSymbolicLink()) {
          throw new PanelError('BAD_REQUEST', '归档包含符号链接或硬链接，已拒绝');
        }
        const rel = path.relative(staging, abs).split(path.sep).join('/');
        if (stats.isDirectory()) {
          entries.push({ rel, abs, isDir: true, stats });
          stack.push(abs);
          continue;
        }
        if (!stats.isFile()) {
          throw new PanelError('BAD_REQUEST', '归档包含特殊文件（设备/管道等）');
        }
        bytes += stats.size;
        entries.push({ rel, abs, isDir: false, stats });
        if (entries.length > MAX_TREE_ENTRIES || bytes > MAX_TREE_BYTES) {
          throw new PanelError('BAD_REQUEST', '解压内容超过上限（10 万条目 / 5 GiB）');
        }
      }
    }
    return entries;
  }

  private joinVirtual(base: string, relative: string): string {
    return base === '/' ? `/${relative}` : `${base}/${relative}`;
  }

  async extract(req: FileExtractRequest): Promise<FileExtractResult> {
    const runner = this.requireRunner();
    const tar = await this.toolPath(runner, 'tar');
    const root = req.root;
    const source = normalizeVirtualPath(req.path);
    const sourceAbs = await this.sandbox.resolve(root, source);
    let sourceStats: Stats;
    try {
      sourceStats = await fs.lstat(sourceAbs);
    } catch (error) {
      throw mapFsError(error, '读取归档');
    }
    if (!sourceStats.isFile()) {
      throw new PanelError('BAD_REQUEST', '只能解压普通文件');
    }
    const format = req.format ?? this.inferFormat(source);
    const destination = normalizeVirtualPath(req.destination);
    const destAbs = await this.sandbox.resolve(root, destination, {
      allowMissing: true,
      forWrite: true,
    });
    const realRoot = await this.sandbox.resolve(root, '/');
    const staging = path.join(
      realRoot,
      '.mpanel-tmp',
      `extract-${randomBytes(6).toString('hex')}`,
    );
    await this.sandbox.ensureDir(staging, 0o700);
    const sourceArg = this.toolRelative(realRoot, sourceAbs);
    const stagingArg = this.toolRelative(realRoot, staging);
    try {
      const listing = await this.run(runner, tar, ['-tf', sourceArg], realRoot);
      if (listing.code !== 0) throw this.listFailure(format, listing);
      if (listing.truncated) {
        throw new PanelError('BAD_REQUEST', '归档条目过多，无法完成安全校验');
      }
      const names = listing.stdout.split(/\r?\n/).filter((name) => name.length > 0);
      if (names.length > MAX_TREE_ENTRIES) {
        throw new PanelError('BAD_REQUEST', '归档条目超过上限（10 万条目）');
      }
      for (const name of names) this.validateEntryName(name);

      const verbose = await this.run(runner, tar, ['-tvf', sourceArg], realRoot);
      if (verbose.code !== 0) {
        throw new PanelError('BAD_REQUEST', '无法校验归档条目类型');
      }
      for (const line of verbose.stdout.split(/\r?\n/)) {
        const trimmed = line.trimStart();
        if (trimmed.length === 0) continue;
        const marker = trimmed.charAt(0);
        if (marker === 'l' || marker === 'h') {
          throw new PanelError('BAD_REQUEST', '归档包含符号链接或硬链接，已拒绝', {
            hint: '请重新打包并移除链接后再解压',
          });
        }
      }

      const extraction = await this.run(
        runner,
        tar,
        ['--no-same-owner', '-xf', sourceArg, '-C', stagingArg],
        realRoot,
      );
      if (extraction.code !== 0) throw this.extractFailure(format, extraction);

      const entries = await this.collectStaging(staging);
      const destExists = await pathExists(destAbs);
      if (destExists) {
        let destStats: Stats;
        try {
          destStats = await fs.lstat(destAbs);
        } catch (error) {
          throw mapFsError(error, '检查解压目标');
        }
        if (!destStats.isDirectory()) {
          throw new PanelError('BAD_REQUEST', '解压目标不是目录');
        }
      } else {
        try {
          await fs.mkdir(destAbs, { recursive: true, mode: 0o755 });
        } catch (error) {
          throw mapFsError(error, '创建解压目标');
        }
      }
      for (const entry of entries) {
        const target = path.join(destAbs, ...entry.rel.split('/'));
        if (await pathExists(target)) {
          throw new PanelError('CONFLICT', '解压目标已存在同名文件或目录', {
            path: this.joinVirtual(destination, entry.rel),
          });
        }
      }
      entries.sort((a, b) => {
        const depth = a.rel.split('/').length - b.rel.split('/').length;
        if (depth !== 0) return depth;
        return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0;
      });
      for (const entry of entries) {
        const target = path.join(destAbs, ...entry.rel.split('/'));
        if (entry.isDir) {
          try {
            await fs.mkdir(target, { recursive: true, mode: entry.stats.mode & 0o777 });
          } catch (error) {
            throw mapFsError(error, '解压文件');
          }
          continue;
        }
        try {
          await fs.rename(entry.abs, target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
            await fs.copyFile(entry.abs, target);
            await fs.unlink(entry.abs);
          } else {
            throw mapFsError(error, '解压文件');
          }
        }
      }
      const files = entries.filter((entry) => !entry.isDir).length;
      return { destination, entries: files };
    } finally {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export function createArchiveService(deps: ArchiveServiceDeps): ArchiveService {
  return new ArchiveServiceImpl(deps);
}
