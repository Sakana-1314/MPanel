/**
 * 站点草稿存储：单文件原子 JSON（tmp + fsync + rename，写前保留 .bak）。
 *
 * 契约（docs/file-layout.md §1.3）要求 createSiteStore(file) 的形态；本模块
 * 直接持有 `$MPANEL_HOME/state/sites.json`，不依赖 worker 核心 store 的运行时
 * 实现，避免模块与核心轨道联合调试时互相阻塞。所有写操作经进程内队列串行化，
 * 读操作依赖 rename 的原子性。
 */
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { PanelError } from '@mpanel/shared';
import type {
  ModuleLogger,
  Site,
  SiteCreateInput,
  SiteExportBundle,
  SiteImportResult,
  SiteUpdateInput,
} from '@mpanel/shared';
import { assertDistinctDomains } from './caddyfile.js';

const SCHEMA_VERSION = 1;

interface SitesFile {
  schemaVersion: number;
  sites: Site[];
}

export interface SiteStore {
  list(): Promise<Site[]>;
  get(id: string): Promise<Site | undefined>;
  create(input: SiteCreateInput): Promise<Site>;
  update(id: string, input: SiteUpdateInput): Promise<Site>;
  remove(id: string): Promise<void>;
  exportBundle(): Promise<SiteExportBundle>;
  importBundle(bundle: SiteExportBundle, mode: 'merge' | 'replace'): Promise<SiteImportResult>;
  /** appliedRevision = each site's current revision. */
  markApplied(ids: string[], applyRevision: number, at: string): Promise<void>;
  markApplyError(ids: string[], at: string, error: string): Promise<void>;
}

/** 站点状态由存储字段推导，不单独持久化（docs/api-contract.md §6.1）。 */
export function computeSiteStatus(
  site: Pick<Site, 'enabled' | 'appliedRevision' | 'revision' | 'lastApply'>,
): Site['status'] {
  if (!site.enabled) return 'disabled';
  if (site.lastApply !== null && !site.lastApply.ok) return 'error';
  if (site.appliedRevision === null) return 'draft';
  if (site.appliedRevision !== site.revision) return 'pending';
  return 'applied';
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cloneConfig<T>(value: T): T {
  return structuredClone(value);
}

function looksLikeSite(value: unknown): value is Site {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Site>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.enabled === 'boolean' &&
    typeof candidate.revision === 'number' &&
    (candidate.appliedRevision === null || typeof candidate.appliedRevision === 'number') &&
    typeof candidate.config === 'object' &&
    candidate.config !== null &&
    typeof candidate.createdAt === 'string' &&
    typeof candidate.updatedAt === 'string'
  );
}

function parseSitesFile(text: string): SitesFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as { schemaVersion?: unknown; sites?: unknown };
  if (!Array.isArray(candidate.sites)) return null;
  if (!candidate.sites.every(looksLikeSite)) return null;
  const sites = candidate.sites.map((site) => {
    const normalized: Site = {
      ...site,
      appliedRevision: site.appliedRevision ?? null,
      lastApply: site.lastApply ?? null,
    };
    normalized.status = computeSiteStatus(normalized);
    return normalized;
  });
  return {
    schemaVersion: typeof candidate.schemaVersion === 'number' ? candidate.schemaVersion : SCHEMA_VERSION,
    sites,
  };
}

async function readTextOrNull(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    throw error;
  }
}

function newSiteId(): string {
  return `st_${randomBytes(12).toString('hex')}`;
}

function normalizeName(name: string): string {
  return name.trim();
}

function nameKey(name: string): string {
  return name.toLowerCase();
}

function buildSite(
  name: string,
  enabled: boolean,
  config: Site['config'],
  now: string,
): Site {
  const revision = 1;
  const draft: Site = {
    id: newSiteId(),
    name,
    enabled,
    config: cloneConfig(config),
    revision,
    appliedRevision: null,
    status: 'draft',
    lastApply: null,
    createdAt: now,
    updatedAt: now,
  };
  draft.status = computeSiteStatus(draft);
  return draft;
}

export function createSiteStore(file: string, logger?: ModuleLogger): SiteStore {
  const backupFile = `${file}.bak`;
  let tail: Promise<unknown> = Promise.resolve();

  /** 串行化全部写事务，避免并发 create/update 丢更新。 */
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = tail.then(task, task);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function readState(): Promise<SitesFile> {
    const primary = await readTextOrNull(file);
    if (primary !== null) {
      const parsed = parseSitesFile(primary);
      if (parsed) return parsed;
      logger?.warn('站点存储文件损坏，尝试从备份恢复', { file });
    }
    const backup = await readTextOrNull(backupFile);
    if (backup !== null) {
      const parsed = parseSitesFile(backup);
      if (parsed) {
        if (primary !== null) logger?.warn('已从 .bak 恢复站点存储', { file, backupFile });
        return parsed;
      }
      logger?.error('站点存储与备份均不可解析', { file, backupFile });
    }
    if (primary === null) return { schemaVersion: SCHEMA_VERSION, sites: [] };
    throw new PanelError('INTERNAL', '站点存储不可读且无法从备份恢复', { file });
  }

  async function writeState(state: SitesFile): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const payload = `${JSON.stringify(state, null, 2)}\n`;
    const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const handle = await open(tmp, 'w', 0o600);
    try {
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await copyFile(file, backupFile);
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) {
        await rm(tmp, { force: true });
        throw error;
      }
    }
    try {
      await rename(tmp, file);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  }

  function findDuplicateName(sites: Site[], name: string, exceptId?: string): Site | undefined {
    const key = nameKey(name);
    return sites.find((site) => site.id !== exceptId && nameKey(site.name) === key);
  }

  return {
    async list(): Promise<Site[]> {
      return (await readState()).sites;
    },

    async get(id: string): Promise<Site | undefined> {
      return (await readState()).sites.find((site) => site.id === id);
    },

    async create(input: SiteCreateInput): Promise<Site> {
      const name = normalizeName(input.name);
      if (name.length === 0) {
        throw new PanelError('BAD_REQUEST', '站点名称不能为空', { field: 'name' });
      }
      assertDistinctDomains(input.config.domains);
      return enqueue(async () => {
        const state = await readState();
        const duplicate = findDuplicateName(state.sites, name);
        if (duplicate) {
          throw new PanelError('CONFLICT', `站点名称「${name}」已存在`, {
            resource: 'site',
            field: 'name',
            id: duplicate.id,
          });
        }
        const now = new Date().toISOString();
        const site = buildSite(name, input.enabled ?? true, input.config, now);
        state.sites.push(site);
        await writeState(state);
        return site;
      });
    },

    async update(id: string, input: SiteUpdateInput): Promise<Site> {
      const nextName = input.name === undefined ? undefined : normalizeName(input.name);
      if (nextName !== undefined && nextName.length === 0) {
        throw new PanelError('BAD_REQUEST', '站点名称不能为空', { field: 'name' });
      }
      if (input.config) assertDistinctDomains(input.config.domains);
      return enqueue(async () => {
        const state = await readState();
        const index = state.sites.findIndex((site) => site.id === id);
        if (index === -1) {
          throw new PanelError('NOT_FOUND', '站点不存在', { resource: 'site', id });
        }
        const current = state.sites[index]!;
        if (nextName !== undefined) {
          const duplicate = findDuplicateName(state.sites, nextName, id);
          if (duplicate) {
            throw new PanelError('CONFLICT', `站点名称「${nextName}」已存在`, {
              resource: 'site',
              field: 'name',
              id: duplicate.id,
            });
          }
        }
        const now = new Date().toISOString();
        const updated: Site = {
          ...current,
          name: nextName ?? current.name,
          enabled: input.enabled ?? current.enabled,
          config: input.config ? cloneConfig(input.config) : current.config,
          revision: current.revision + 1,
          updatedAt: now,
        };
        updated.status = computeSiteStatus(updated);
        state.sites[index] = updated;
        await writeState(state);
        return updated;
      });
    },

    async remove(id: string): Promise<void> {
      await enqueue(async () => {
        const state = await readState();
        const index = state.sites.findIndex((site) => site.id === id);
        if (index === -1) {
          throw new PanelError('NOT_FOUND', '站点不存在', { resource: 'site', id });
        }
        state.sites.splice(index, 1);
        await writeState(state);
      });
    },

    async exportBundle(): Promise<SiteExportBundle> {
      const state = await readState();
      return {
        version: 1,
        exportedAt: new Date().toISOString(),
        sites: state.sites.map((site) => ({
          name: site.name,
          enabled: site.enabled,
          config: cloneConfig(site.config),
        })),
      };
    },

    async importBundle(
      bundle: SiteExportBundle,
      mode: 'merge' | 'replace',
    ): Promise<SiteImportResult> {
      return enqueue(async () => {
        const state = await readState();
        const sites: Site[] = mode === 'replace' ? [] : [...state.sites];
        const now = new Date().toISOString();
        const result: SiteImportResult = { imported: 0, skipped: 0, errors: [] };
        bundle.sites.forEach((item, index) => {
          const name = normalizeName(item.name);
          if (name.length === 0) {
            result.errors.push({ index, name: item.name, message: '站点名称不能为空' });
            return;
          }
          if (findDuplicateName(sites, name)) {
            if (mode === 'merge') {
              result.skipped += 1;
            } else {
              result.errors.push({ index, name, message: `站点名称「${name}」重复` });
            }
            return;
          }
          try {
            assertDistinctDomains(item.config.domains);
          } catch (error) {
            result.errors.push({ index, name, message: messageOf(error) });
            return;
          }
          sites.push(buildSite(name, item.enabled, item.config, now));
          result.imported += 1;
        });
        await writeState({ schemaVersion: SCHEMA_VERSION, sites });
        return result;
      });
    },

    async markApplied(ids: string[], applyRevision: number, at: string): Promise<void> {
      const targets = new Set(ids);
      await enqueue(async () => {
        const state = await readState();
        let changed = false;
        for (const site of state.sites) {
          if (!targets.has(site.id)) continue;
          site.appliedRevision = site.revision;
          site.lastApply = { at, ok: true, revision: applyRevision };
          site.status = computeSiteStatus(site);
          changed = true;
        }
        if (changed) await writeState(state);
      });
    },

    async markApplyError(ids: string[], at: string, error: string): Promise<void> {
      const targets = new Set(ids);
      const message = error.length > 500 ? `${error.slice(0, 500)}…` : error;
      await enqueue(async () => {
        const state = await readState();
        let changed = false;
        for (const site of state.sites) {
          if (!targets.has(site.id)) continue;
          site.lastApply = {
            at,
            ok: false,
            revision: site.lastApply?.revision ?? 0,
            error: message,
          };
          site.status = computeSiteStatus(site);
          changed = true;
        }
        if (changed) await writeState(state);
      });
    },
  };
}
