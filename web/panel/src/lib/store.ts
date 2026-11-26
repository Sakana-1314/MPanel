import { getRuntimeConfig } from './runtime-config';
import type { SiteBootstrapMount } from '@/api/types';

/**
 * web/store 的应用索引与清单。模板通过 GitHub 链接获取：
 * 默认 raw.githubusercontent.com，可在 config.json 中覆盖 storeUrl。
 */
export const DEFAULT_STORE_URL =
  'https://raw.githubusercontent.com/Sakana-1314/MPanel/main/web/store';

export interface StoreAppSummary {
  id: string;
  name: string;
  category?: string;
  tagline?: string;
  manifest: string;
}

export interface StoreIndex {
  schemaVersion?: number;
  updatedAt?: string;
  apps: StoreAppSummary[];
}

export interface StoreVariable {
  key: string;
  label?: string;
  default?: string;
  description?: string;
  secret?: boolean;
  hidden?: boolean;
  generate?: { length?: number; charset?: string };
}

export interface StoreProfileMapping {
  kind: 'postgres' | 'redis';
  name: string;
  host: string;
  portVariable?: string;
  usernameVariable?: string;
  passwordVariable?: string;
  databaseVariable?: string;
  redisDb?: number;
}

export interface StoreAppManifest {
  schemaVersion?: number;
  id: string;
  name: string;
  category?: string;
  tagline?: string;
  description?: string;
  version?: string;
  stack: string;
  service?: string;
  compose: string;
  /** "sites" 时安装前调用 POST /sites/bootstrap 并填充挂载变量。 */
  bootstrap?: string;
  capability?: string;
  variables?: StoreVariable[];
  profile?: StoreProfileMapping;
  links?: { label: string; url: string }[];
}

export interface StoreAppBundle {
  manifest: StoreAppManifest;
  compose: string;
  manifestUrl: string;
}

export function storeBaseUrl(): string {
  const configured = (getRuntimeConfig().storeUrl ?? '').trim();
  return configured.length > 0 ? configured : DEFAULT_STORE_URL;
}

/** 把商店相对路径解析成绝对 URL；同源相对路径按面板 BASE_URL 处理。 */
export function resolveStoreUrl(relative: string): string {
  const base = storeBaseUrl();
  if (/^https?:\/\//i.test(relative)) return relative;
  const clean = relative.replace(/^\/+/, '');
  if (/^https?:\/\//i.test(base)) {
    return new URL(clean, base.endsWith('/') ? base : `${base}/`).toString();
  }
  const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
  const basePath = base.startsWith('/')
    ? base
    : `${(import.meta.env.BASE_URL || '/').replace(/\/+$/, '')}/${base}`;
  const root = new URL(basePath.endsWith('/') ? basePath : `${basePath}/`, origin);
  return new URL(clean, root).toString();
}

async function fetchJSON(url: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { cache: 'no-cache', credentials: 'omit' });
  } catch (error) {
    throw new Error(
      `无法获取应用商店模板：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new Error(`应用商店模板请求失败（HTTP ${response.status}）`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error('应用商店返回的不是合法 JSON');
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export async function fetchStoreIndex(): Promise<StoreIndex> {
  const payload = asRecord(await fetchJSON(resolveStoreUrl('index.json')));
  if (payload === null || !Array.isArray(payload.apps)) {
    throw new Error('应用商店索引格式不正确');
  }
  const apps: StoreAppSummary[] = [];
  for (const entry of payload.apps) {
    const item = asRecord(entry);
    const id = asString(item?.id);
    const manifest = asString(item?.manifest);
    if (item === null || id === undefined || manifest === undefined) continue;
    apps.push({
      id,
      name: asString(item.name) ?? id,
      category: asString(item.category),
      tagline: asString(item.tagline),
      manifest,
    });
  }
  return { schemaVersion: typeof payload.schemaVersion === 'number' ? payload.schemaVersion : undefined, apps };
}

export function findStoreApp(index: StoreIndex, id: string): StoreAppSummary {
  const app = index.apps.find((entry) => entry.id === id);
  if (app === undefined) throw new Error(`应用商店中没有找到 ${id}`);
  return app;
}

export async function fetchStoreApp(summary: StoreAppSummary): Promise<StoreAppBundle> {
  const manifestUrl = resolveStoreUrl(summary.manifest);
  const raw = asRecord(await fetchJSON(manifestUrl));
  if (raw === null) throw new Error('应用清单格式不正确');
  const id = asString(raw.id);
  const stack = asString(raw.stack);
  const compose = asString(raw.compose);
  if (id === undefined || stack === undefined || compose === undefined) {
    throw new Error('应用清单缺少 id、stack 或 compose');
  }
  const variables: StoreVariable[] = [];
  if (Array.isArray(raw.variables)) {
    for (const entry of raw.variables) {
      const item = asRecord(entry);
      const key = asString(item?.key);
      if (item === null || key === undefined) continue;
      const generate = asRecord(item.generate);
      variables.push({
        key,
        label: asString(item.label),
        default: asString(item.default),
        description: asString(item.description),
        secret: item.secret === true,
        hidden: item.hidden === true,
        generate:
          generate === null
            ? undefined
            : {
                length: typeof generate.length === 'number' ? generate.length : undefined,
                charset: asString(generate.charset),
              },
      });
    }
  }
  const profileRaw = asRecord(raw.profile);
  let profile: StoreProfileMapping | undefined;
  if (profileRaw !== null) {
    const kind = asString(profileRaw.kind);
    if (kind === 'postgres' || kind === 'redis') {
      profile = {
        kind,
        name: asString(profileRaw.name) ?? id,
        host: asString(profileRaw.host) ?? '127.0.0.1',
        portVariable: asString(profileRaw.portVariable),
        usernameVariable: asString(profileRaw.usernameVariable),
        passwordVariable: asString(profileRaw.passwordVariable),
        databaseVariable: asString(profileRaw.databaseVariable),
        redisDb: typeof profileRaw.redisDb === 'number' ? profileRaw.redisDb : undefined,
      };
    }
  }
  const links: { label: string; url: string }[] = [];
  if (Array.isArray(raw.links)) {
    for (const entry of raw.links) {
      const item = asRecord(entry);
      const label = asString(item?.label);
      const url = asString(item?.url);
      if (label !== undefined && url !== undefined) links.push({ label, url });
    }
  }
  return {
    manifest: {
      schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : undefined,
      id,
      name: asString(raw.name) ?? id,
      category: asString(raw.category),
      tagline: asString(raw.tagline),
      description: asString(raw.description),
      version: asString(raw.version),
      stack,
      service: asString(raw.service),
      compose,
      bootstrap: asString(raw.bootstrap),
      capability: asString(raw.capability),
      variables,
      profile,
      links,
    },
    compose: await fetchCompose(compose),
    manifestUrl,
  };
}

async function fetchCompose(composePath: string): Promise<string> {
  const url = resolveStoreUrl(composePath);
  let response: Response;
  try {
    response = await fetch(url, { cache: 'no-cache', credentials: 'omit' });
  } catch (error) {
    throw new Error(
      `无法获取编排模板：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) throw new Error(`编排模板请求失败（HTTP ${response.status}）`);
  return response.text();
}

/** 生成 YAML/Compose 中安全的随机密码（字母数字，避免引号转义问题）。 */
export function generateSecret(length = 28): string {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const target = Math.max(16, Math.min(length, 64));
  const values = new Uint32Array(target);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(values);
  } else {
    for (let i = 0; i < target; i += 1) values[i] = Math.floor(Math.random() * 0xffffffff);
  }
  let out = '';
  for (let i = 0; i < target; i += 1) {
    out += charset[values[i] % charset.length];
  }
  return out;
}

/** 校验安装变量，避免换行/引号破坏 YAML 结构。返回错误文案或 null。 */
export function validateStoreValues(
  manifest: StoreAppManifest,
  values: Record<string, string>,
): string | null {
  for (const variable of manifest.variables ?? []) {
    if (variable.hidden) continue;
    const value = values[variable.key] ?? '';
    const label = variable.label ?? variable.key;
    if (value.trim().length === 0) return `请填写 ${label}`;
    if (/[\r\n\t\x00-\x1f]/.test(value)) return `${label} 不能包含换行或控制字符`;
    if (/["'\\]/.test(value)) return `${label} 不能包含引号或反斜杠`;
    if (/port$/i.test(variable.key)) {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return `${label} 需为 1–65535 的整数`;
      }
    }
    if (variable.key === 'MPANEL_DATA_DIR' && !/^(\/|[A-Za-z]:\/)/.test(value)) {
      return `${label} 必须是绝对路径（/ 开头或 X:/ 形式）`;
    }
  }
  return null;
}

export function defaultStoreValues(
  manifest: StoreAppManifest,
  paths?: { home?: string },
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const variable of manifest.variables ?? []) {
    let value = variable.default ?? '';
    if (variable.key === 'MPANEL_DATA_DIR' && paths?.home !== undefined && paths.home.length > 0) {
      // Compose/YAML 里统一用正斜杠；Windows 开发机写 C:/... 也能被 Docker 接受。
      value = `${paths.home.replace(/\\/g, '/').replace(/\/+$/, '')}/data`;
    }
    if (value.length === 0 && variable.generate !== undefined) {
      value = generateSecret(variable.generate.length ?? 28);
    }
    values[variable.key] = value;
  }
  return values;
}

/** 纯文本替换 {{KEY}}；缺失变量直接报错，不静默留空。 */
export function renderComposeTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`编排模板缺少变量 ${key}`);
    return value;
  });
}

/** 把 bootstrap 返回的挂载转成 Compose volumes 列表行（6 空格缩进）。 */
export function renderComposeVolumes(mounts: SiteBootstrapMount[]): string {
  return mounts
    .filter((mount) => mount.source.length > 0 && mount.target.length > 0)
    .map((mount) => {
      const suffix = mount.readOnly ? ':ro' : '';
      return `      - ${JSON.stringify(`${mount.source}:${mount.target}${suffix}`)}`;
    })
    .join('\n');
}
