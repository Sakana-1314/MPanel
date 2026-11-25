/**
 * 站点应用服务：生成 staging → caddy validate → 备份 → 原子替换 → reload → 失败回滚。
 *
 * 线上目录结构（architecture §8.1）：
 *   <configDir>/Caddyfile            受管根配置，含 import sites.d/*.caddy
 *   <configDir>/sites.d/<id>.caddy   每站点片段
 * staging 与备份分别位于 config.caddy.stagingDir / backupDir。
 */
import { randomBytes } from 'node:crypto';
import {
  cp,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { PanelError } from '@mpanel/shared';
import type {
  CommandResult,
  Site,
  SiteApplyRequest,
  SiteApplyResult,
  SitePreviewRequest,
  SitePreviewResult,
  SiteStatus,
} from '@mpanel/shared';
import type { CommandRunner } from '@mpanel/shared';
import type { WorkerConfig } from '../../config.js';
import type { WorkerLogger } from '../../logger.js';
import type { SiteStore } from './store.js';
import type { CaddyClient } from './caddy.js';
import {
  collectConfigWarnings,
  renderRootConfig,
  renderSiteConfig,
  siteWarnings,
} from './caddyfile.js';
import { CADDY_HINT, summarizeCommandOutput } from './caddy.js';

const EMPTY_FRAGMENT_NAME = '_mpanel-empty.caddy';
const EMPTY_FRAGMENT = '# MPanel: 当前没有启用的站点\n';
const MAX_FRAGMENT_BYTES = 1024 * 1024;

/**
 * staging -> validate -> backup -> swap -> reload -> rollback.
 * Omitting siteIds renders every enabled site and prunes removed ones.
 */
export interface SiteApplyService {
  preview(req: SitePreviewRequest): Promise<SitePreviewResult>;
  apply(req: SiteApplyRequest): Promise<SiteApplyResult>;
}

export interface SiteApplyDeps {
  config: WorkerConfig;
  store: SiteStore;
  caddy: CaddyClient;
  runner: CommandRunner;
  logger: WorkerLogger;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === code
  );
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
}

async function readFileOrNull(target: string): Promise<string | null> {
  try {
    return await readFile(target, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return null;
    throw error;
  }
}

async function writeFileAtomicLocal(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const handle = await open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, target);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

function fragmentFileName(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  return `${safe.length === 0 ? 'site' : safe}.caddy`;
}

async function readFragmentMap(dir: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return map;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.caddy')) continue;
    // 占位文件只用于保证 import glob 有匹配，不参与“配置是否变化”的比较。
    if (entry.name === EMPTY_FRAGMENT_NAME) continue;
    const fullPath = path.join(dir, entry.name);
    const info = await stat(fullPath);
    if (!info.isFile() || info.size > MAX_FRAGMENT_BYTES) continue;
    map.set(entry.name, await readFile(fullPath, 'utf8'));
  }
  return map;
}

function mapsEqual(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
}

function maxApplyRevision(sites: Site[]): number {
  return sites.reduce((max, site) => Math.max(max, site.lastApply?.revision ?? 0), 0);
}

function combinedOutput(results: CommandResult[]): string {
  const merged = results
    .map((result) => summarizeCommandOutput(result, 4_000))
    .filter((value) => value.length > 0)
    .join('\n')
    .trim();
  return merged.length > 8_000 ? `${merged.slice(0, 8_000)}\n…（输出已截断）` : merged;
}

function backupStamp(now: Date): string {
  const base = now.toISOString().replace(/[:.]/g, '-');
  return `${base}-${randomBytes(3).toString('hex')}`;
}

function hintFromProbe(probe: { details?: Record<string, unknown> }): string {
  const hint = probe.details?.hint;
  return typeof hint === 'string' && hint.length > 0 ? hint : CADDY_HINT;
}

function renderError(error: unknown): PanelError {
  if (error instanceof PanelError) return error;
  return new PanelError('BAD_REQUEST', '生成 Caddyfile 失败', {
    stage: 'render',
    output: messageOf(error),
  });
}

export function createSiteApplyService(deps: SiteApplyDeps): SiteApplyService {
  const { config, store, caddy, logger } = deps;
  const caddyConfig = config.caddy;
  const liveCaddyfile = path.join(caddyConfig.configDir, 'Caddyfile');
  const liveSitesDir = path.join(caddyConfig.configDir, 'sites.d');
  const stagingSitesDir = path.join(caddyConfig.stagingDir, 'sites.d');
  const stagingCaddyfile = path.join(caddyConfig.stagingDir, 'Caddyfile');
  let applying = false;

  async function markApplyError(ids: string[], at: string, error: string): Promise<void> {
    if (ids.length === 0) return;
    try {
      await store.markApplyError(ids, at, error);
    } catch (markErrorValue) {
      logger.warn('记录站点 apply 失败状态时出错', { error: messageOf(markErrorValue) });
    }
  }

  async function preview(req: SitePreviewRequest): Promise<SitePreviewResult> {
    const hasSite = req.site !== undefined;
    const hasSiteId = req.siteId !== undefined;
    if (hasSite === hasSiteId) {
      throw new PanelError('BAD_REQUEST', '必须且只能提供 site 或 siteId 之一', {
        field: 'site',
      });
    }

    let caddyfile: string;
    let warnings: string[];
    if (hasSite) {
      caddyfile = renderSiteConfig(req.site!);
      warnings = collectConfigWarnings(req.site!);
    } else {
      const site = await store.get(req.siteId!);
      if (!site) {
        throw new PanelError('NOT_FOUND', '站点不存在', { resource: 'site', id: req.siteId });
      }
      const all = await store.list();
      caddyfile = renderSiteConfig(site.config);
      warnings = siteWarnings(site, all);
    }

    if (req.validate !== true) {
      return { caddyfile, warnings, validation: null };
    }

    const probe = await caddy.probe();
    if (!probe.available) {
      return {
        caddyfile,
        warnings,
        validation: null,
        validationUnavailableReason: `${probe.reason ?? 'Caddy 不可用'}；${hintFromProbe(probe)}`,
      };
    }

    await mkdir(path.join(caddyConfig.stagingDir, 'preview'), { recursive: true });
    const previewFile = path.join(
      caddyConfig.stagingDir,
      'preview',
      `preview-${Date.now()}-${randomBytes(4).toString('hex')}.caddy`,
    );
    await writeFile(previewFile, caddyfile, { mode: 0o600 });
    try {
      const result = await caddy.validate(previewFile);
      return {
        caddyfile,
        warnings,
        validation: { ok: result.code === 0, output: summarizeCommandOutput(result) },
      };
    } catch (error) {
      return {
        caddyfile,
        warnings,
        validation: { ok: false, output: messageOf(error) },
      };
    } finally {
      await rm(previewFile, { force: true }).catch(() => undefined);
    }
  }

  async function runApply(req: SiteApplyRequest): Promise<SiteApplyResult> {
    const all = await store.list();
    const selectedIds = req.siteIds === undefined ? null : [...new Set(req.siteIds)];
    let targets: Site[];
    if (selectedIds === null) {
      targets = all;
    } else {
      const byId = new Map(all.map((site) => [site.id, site]));
      const missing = selectedIds.filter((id) => !byId.has(id));
      if (missing.length > 0) {
        throw new PanelError('NOT_FOUND', '部分站点不存在', { resource: 'site', ids: missing });
      }
      targets = selectedIds.map((id) => byId.get(id)!);
    }
    const targetIds = targets.map((site) => site.id);
    const now = new Date();
    const at = now.toISOString();

    const probe = await caddy.probe();
    if (!probe.available) {
      throw new PanelError('UNAVAILABLE', 'Caddy 不可用，无法应用站点配置', {
        capability: 'caddy',
        reason: probe.reason,
        hint: hintFromProbe(probe),
      });
    }

    const liveFragments = await readFragmentMap(liveSitesDir);
    const liveSitesExists = await pathExists(liveSitesDir);
    const liveRoot = await readFileOrNull(liveCaddyfile);

    const warnings = [
      ...new Set(targets.flatMap((site) => siteWarnings(site, all))),
    ];

    let desired: Map<string, string>;
    let rootContent: string;
    try {
      desired = selectedIds === null ? new Map<string, string>() : new Map(liveFragments);
      for (const site of targets) {
        const name = fragmentFileName(site.id);
        if (site.enabled) {
          desired.set(name, renderSiteConfig(site.config));
        } else {
          desired.delete(name);
        }
      }
      rootContent = renderRootConfig(all, { adminAddress: caddyConfig.adminAddress });
    } catch (error) {
      await markApplyError(targetIds, at, messageOf(error));
      throw renderError(error);
    }

    const upToDate = targets.every(
      (site) => !site.enabled || site.appliedRevision === site.revision,
    );
    if (
      req.force !== true &&
      upToDate &&
      liveRoot === rootContent &&
      mapsEqual(desired, liveFragments)
    ) {
      return {
        revision: maxApplyRevision(all),
        appliedAt: at,
        caddyfilePath: liveCaddyfile,
        backupPath: null,
        reloaded: false,
        rolledBack: false,
        sites: targets.map((site) => ({
          id: site.id,
          name: site.name,
          status: site.status,
        })),
        warnings,
        caddyOutput: '配置未变化，跳过 apply',
      };
    }

    await rm(stagingSitesDir, { recursive: true, force: true });
    await mkdir(stagingSitesDir, { recursive: true });
    for (const [name, content] of desired) {
      await writeFile(path.join(stagingSitesDir, name), content, { mode: 0o600 });
    }
    if (desired.size === 0) {
      await writeFile(path.join(stagingSitesDir, EMPTY_FRAGMENT_NAME), EMPTY_FRAGMENT, {
        mode: 0o600,
      });
    }
    await writeFile(stagingCaddyfile, rootContent, { mode: 0o600 });

    const validation = await caddy.validate(stagingCaddyfile);
    if (validation.code !== 0) {
      const output = summarizeCommandOutput(validation);
      await markApplyError(targetIds, at, `Caddyfile 校验失败：${output}`);
      throw new PanelError('BAD_REQUEST', 'Caddyfile 校验失败，线上配置未修改', {
        stage: 'validate',
        output,
      });
    }

    let backupPath: string | null = null;
    if (liveRoot !== null || liveFragments.size > 0 || liveSitesExists) {
      backupPath = path.join(caddyConfig.backupDir, backupStamp(now));
      try {
        await mkdir(backupPath, { recursive: true });
        if (liveRoot !== null) {
          await writeFile(path.join(backupPath, 'Caddyfile'), liveRoot, { mode: 0o600 });
        }
        if (liveSitesExists) {
          await cp(liveSitesDir, path.join(backupPath, 'sites.d'), {
            recursive: true,
            force: true,
          });
        }
      } catch (error) {
        const output = messageOf(error);
        await markApplyError(targetIds, at, `备份 Caddy 配置失败：${output}`);
        throw new PanelError('UPSTREAM_ERROR', '备份 Caddy 配置失败，线上配置未修改', {
          stage: 'backup',
          output,
        });
      }
    }

    const suffix = `${now.getTime()}-${randomBytes(3).toString('hex')}`;
    const oldSitesDir = path.join(caddyConfig.configDir, `sites.d.old-${suffix}`);
    const nextSitesDir = path.join(caddyConfig.configDir, `sites.d.next-${suffix}`);
    let movedOld = false;
    let installedNew = false;

    /**
     * 恢复线上文件并再次 reload。ok 只表示文件恢复成功：Caddy 已挂掉时
     * 第二次 reload 也会失败，但那仍是一次成功回滚（契约要求 502 而非 500）。
     */
    async function restoreLive(): Promise<{ ok: boolean; detail: string }> {
      const fileFailures: string[] = [];
      const reloadFailures: string[] = [];
      try {
        if (installedNew) {
          await rm(liveSitesDir, { recursive: true, force: true });
          installedNew = false;
        }
        if (movedOld) {
          await rename(oldSitesDir, liveSitesDir);
          movedOld = false;
        }
      } catch (error) {
        fileFailures.push(`恢复 sites.d 失败：${messageOf(error)}`);
      }
      try {
        if (liveRoot !== null) {
          await writeFileAtomicLocal(liveCaddyfile, liveRoot);
        } else {
          await rm(liveCaddyfile, { force: true });
        }
      } catch (error) {
        fileFailures.push(`恢复根 Caddyfile 失败：${messageOf(error)}`);
      }
      if (fileFailures.length === 0 && liveRoot !== null) {
        try {
          const reloaded = await caddy.reload(liveCaddyfile);
          if (reloaded.code !== 0) {
            reloadFailures.push(`回滚后 reload 失败：${summarizeCommandOutput(reloaded)}`);
          }
        } catch (error) {
          reloadFailures.push(`回滚后 reload 异常：${messageOf(error)}`);
        }
      }
      return {
        ok: fileFailures.length === 0,
        detail: [...fileFailures, ...reloadFailures].join('；'),
      };
    }

    try {
      await mkdir(caddyConfig.configDir, { recursive: true });
      await cp(stagingSitesDir, nextSitesDir, { recursive: true, force: true });
      if (liveSitesExists) {
        await rename(liveSitesDir, oldSitesDir);
        movedOld = true;
      }
      await rename(nextSitesDir, liveSitesDir);
      installedNew = true;
      await writeFileAtomicLocal(liveCaddyfile, rootContent);
    } catch (error) {
      const restored = await restoreLive();
      const output = messageOf(error);
      await markApplyError(targetIds, at, `替换 Caddy 配置失败：${output}`);
      if (!restored.ok) {
        throw new PanelError('INTERNAL', '替换 Caddy 配置失败且回滚未完成', {
          stage: 'reload',
          rolledBack: false,
          output: `${output}；${restored.detail}`,
        });
      }
      throw new PanelError('UPSTREAM_ERROR', '替换 Caddy 配置失败，已回滚', {
        stage: 'reload',
        rolledBack: true,
        output: restored.detail.length > 0 ? `${output}；${restored.detail}` : output,
      });
    }

    let reloadResult: CommandResult;
    try {
      reloadResult = await caddy.reload(liveCaddyfile);
    } catch (error) {
      reloadResult = {
        command: 'caddy reload',
        args: [liveCaddyfile],
        code: 1,
        signal: null,
        stdout: '',
        stderr: messageOf(error),
        durationMs: 0,
        truncated: false,
        timedOut: false,
      };
    }

    if (reloadResult.code !== 0) {
      const output = summarizeCommandOutput(reloadResult);
      const restored = await restoreLive();
      await markApplyError(targetIds, at, `Caddy reload 失败：${output}`);
      if (!restored.ok) {
        throw new PanelError('INTERNAL', 'Caddy reload 失败且回滚未完成', {
          stage: 'reload',
          rolledBack: false,
          output: `${output}；${restored.detail}`,
        });
      }
      throw new PanelError('UPSTREAM_ERROR', 'Caddy reload 失败，已回滚到上一版配置', {
        stage: 'reload',
        rolledBack: true,
        output: restored.detail.length > 0 ? `${output}；${restored.detail}` : output,
      });
    }

    if (movedOld) {
      await rm(oldSitesDir, { recursive: true, force: true }).catch((error: unknown) => {
        logger.warn('清理旧 sites.d 目录失败', { error: messageOf(error) });
      });
    }

    const revision = maxApplyRevision(all) + 1;
    const renderedIds = targets.filter((site) => site.enabled).map((site) => site.id);
    await store.markApplied(renderedIds, revision, at);

    const refreshed = await store.list();
    const statusById = new Map<string, SiteStatus>(
      refreshed.map((site) => [site.id, site.status]),
    );

    return {
      revision,
      appliedAt: at,
      caddyfilePath: liveCaddyfile,
      backupPath,
      reloaded: true,
      rolledBack: false,
      sites: targets.map((site) => ({
        id: site.id,
        name: site.name,
        status: statusById.get(site.id) ?? site.status,
      })),
      warnings,
      caddyOutput: combinedOutput([validation, reloadResult]),
    };
  }

  return {
    preview,
    async apply(req: SiteApplyRequest): Promise<SiteApplyResult> {
      if (applying) {
        throw new PanelError('CONFLICT', '已有站点 apply 正在执行', { retryAfterMs: 2_000 });
      }
      applying = true;
      try {
        return await runApply(req);
      } finally {
        applying = false;
      }
    },
  };
}
