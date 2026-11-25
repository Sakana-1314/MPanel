import { promises as fs } from 'node:fs';
import type { Dirent, Stats } from 'node:fs';
import * as path from 'node:path';
import { PanelError } from '@mpanel/shared';
import type {
  FileItem,
  FileSearchResult,
  ModuleLogger,
} from '@mpanel/shared';
import type { WorkerConfig } from '../../config.js';
import type { PathSandbox } from '../../paths.js';
import { createFileSandbox, mapFsError, normalizeVirtualPath } from './sandbox.js';
import type { FileSandbox } from './sandbox.js';

export interface SearchQuery {
  root: string;
  path?: string;
  q: string;
  mode?: 'name' | 'content';
  caseSensitive?: boolean;
  includeHidden?: boolean;
  limit?: number;
}

export interface SearchService {
  search(q: SearchQuery): Promise<FileSearchResult>;
}

export interface SearchServiceDeps {
  config: WorkerConfig;
  paths: PathSandbox;
  logger: ModuleLogger;
  sandbox?: FileSandbox;
}

/** 任务要求：搜索结果上限 500；查询参数仍按契约限制在 200 以内。 */
export const MAX_SEARCH_RESULTS = 500;
export const MAX_CONTENT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_SCAN_ENTRIES = 100_000;
const MAX_CONTENT_FILES = 5_000;
const SEARCH_LIMIT_DEFAULT = 100;

function buildNameMatcher(query: string, caseSensitive: boolean): (name: string) => boolean {
  if (!/[*?]/.test(query)) {
    const needle = caseSensitive ? query : query.toLowerCase();
    return (name) => (caseSensitive ? name : name.toLowerCase()).includes(needle);
  }
  let pattern = '^';
  for (const character of query) {
    if (character === '*') {
      pattern += '.*';
    } else if (character === '?') {
      pattern += '.';
    } else {
      pattern += character.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    }
  }
  pattern += '$';
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, caseSensitive ? '' : 'i');
  } catch {
    throw new PanelError('BAD_REQUEST', '搜索模式不合法');
  }
  return (name) => regex.test(name);
}

async function contentIncludes(
  absPath: string,
  size: number,
  needle: string,
  caseSensitive: boolean,
): Promise<boolean> {
  if (size <= 0 || size > MAX_CONTENT_FILE_BYTES) return false;
  let handle;
  try {
    handle = await fs.open(absPath, 'r');
  } catch {
    return false;
  }
  try {
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    const data = buffer.subarray(0, bytesRead);
    if (data.includes(0)) return false;
    const text = data.toString('utf8');
    return (caseSensitive ? text : text.toLowerCase()).includes(needle);
  } catch {
    return false;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function compareNames(a: Dirent, b: Dirent): number {
  const aLower = a.name.toLowerCase();
  const bLower = b.name.toLowerCase();
  if (aLower !== bLower) return aLower < bLower ? -1 : 1;
  if (a.name === b.name) return 0;
  return a.name < b.name ? -1 : 1;
}

class SearchServiceImpl implements SearchService {
  private readonly logger: ModuleLogger;
  private readonly sandbox: FileSandbox;

  constructor(deps: SearchServiceDeps) {
    this.logger = deps.logger;
    this.sandbox = deps.sandbox ?? createFileSandbox(deps.config, deps.logger);
  }

  async search(q: SearchQuery): Promise<FileSearchResult> {
    if (typeof q.q !== 'string' || q.q.length === 0) {
      throw new PanelError('BAD_REQUEST', '搜索关键字不能为空');
    }
    const root = q.root;
    const baseRel = normalizeVirtualPath(q.path ?? '/');
    const baseAbs = await this.sandbox.resolve(root, baseRel);
    let baseStats: Stats;
    try {
      baseStats = await fs.lstat(baseAbs);
    } catch (error) {
      throw mapFsError(error, '搜索文件');
    }
    if (!baseStats.isDirectory()) {
      throw new PanelError('BAD_REQUEST', '搜索起点必须是目录');
    }
    const mode = q.mode === 'content' ? 'content' : 'name';
    const caseSensitive = q.caseSensitive === true;
    const includeHidden = q.includeHidden === true;
    const requestedLimit =
      typeof q.limit === 'number' && Number.isInteger(q.limit) && q.limit >= 1
        ? q.limit
        : SEARCH_LIMIT_DEFAULT;
    const limit = Math.min(requestedLimit, MAX_SEARCH_RESULTS);
    const nameMatcher = mode === 'name' ? buildNameMatcher(q.q, caseSensitive) : null;
    const needle = caseSensitive ? q.q : q.q.toLowerCase();
    const items: FileItem[] = [];
    let truncated = false;
    let scanned = 0;
    let contentFiles = 0;
    const pending: Array<{ abs: string; rel: string }> = [{ abs: baseAbs, rel: baseRel }];

    outer: while (pending.length > 0) {
      const current = pending.pop()!;
      let entries: Dirent[];
      try {
        entries = await fs.readdir(current.abs, { withFileTypes: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') continue;
        this.logger.debug('搜索时跳过不可读目录', { code });
        continue;
      }
      entries.sort(compareNames);
      for (const entry of entries) {
        if (entry.name === '.mpanel-tmp') continue;
        if (!includeHidden && entry.name.startsWith('.')) continue;
        scanned += 1;
        if (scanned > MAX_SCAN_ENTRIES) {
          truncated = true;
          break outer;
        }
        const childAbs = path.join(current.abs, entry.name);
        let stats: Stats;
        try {
          stats = await fs.lstat(childAbs);
        } catch {
          continue;
        }
        const childRel =
          current.rel === '/' ? `/${entry.name}` : `${current.rel}/${entry.name}`;
        if (stats.isSymbolicLink()) {
          if (mode === 'name' && nameMatcher !== null && nameMatcher(entry.name)) {
            items.push(await this.sandbox.describe(root, childRel, childAbs, stats));
            if (items.length >= limit) {
              truncated = true;
              break outer;
            }
          }
          continue;
        }
        if (stats.isDirectory()) {
          pending.push({ abs: childAbs, rel: childRel });
          continue;
        }
        if (!stats.isFile()) continue;
        let matched = false;
        if (mode === 'name') {
          matched = nameMatcher !== null && nameMatcher(entry.name);
        } else {
          contentFiles += 1;
          if (contentFiles > MAX_CONTENT_FILES) {
            truncated = true;
            break outer;
          }
          matched = await contentIncludes(childAbs, stats.size, needle, caseSensitive);
        }
        if (matched) {
          items.push(await this.sandbox.describe(root, childRel, childAbs, stats));
          if (items.length >= limit) {
            truncated = true;
            break outer;
          }
        }
      }
    }
    items.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return {
      available: true,
      items,
      query: q.q,
      truncated,
      nextCursor: null,
      total: items.length,
    };
  }
}

export function createSearchService(deps: SearchServiceDeps): SearchService {
  return new SearchServiceImpl(deps);
}

export function searchFiles(
  deps: SearchServiceDeps,
  q: SearchQuery,
): Promise<FileSearchResult> {
  return createSearchService(deps).search(q);
}
