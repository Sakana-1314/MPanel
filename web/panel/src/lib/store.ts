import { getRuntimeConfig } from './runtime-config';
import type { SiteBootstrapMount } from '@/api/types';

/**
 * web/store 的应用索引与清单。模板通过 GitHub 链接获取：
 * 默认 raw.githubusercontent.com，可在 config.json 中覆盖 storeUrl；
 * 未显式配置时依次回退到 jsDelivr 与面板同源 /store。
 */
export const DEFAULT_STORE_URL =
  'https://raw.githubusercontent.com/Sakana-1314/MPanel/main/web/store';
export const FALLBACK_STORE_URL =
  'https://cdn.jsdelivr.net/gh/Sakana-1314/MPanel@main/web/store';

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
  /** 实际成功读取索引的商店根地址。 */
  baseUrl?: string;
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

function sameOriginStoreBase(): string {
  return `${(import.meta.env.BASE_URL || '/').replace(/\/+$/, '')}/store`;
}

/** 候选商店根地址：显式配置优先，否则 raw → jsDelivr → 同源。 */
export function storeBaseUrls(): string[] {
  const configured = (getRuntimeConfig().storeUrl ?? '').trim();
  if (configured.length > 0) return [configured];
  return [DEFAULT_STORE_URL, FALLBACK_STORE_URL, sameOriginStoreBase()];
}

export function storeBaseUrl(): string {
  return storeBaseUrls()[0];
}

/** 把商店相对路径解析成绝对 URL；同源相对路径按面板 BASE_URL 处理。 */
export function resolveStoreUrl(relative: string, base = storeBaseUrl()): string {
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

async function fetchStoreResponse(url: string, timeoutMs = 10_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      cache: 'no-cache',
      credentials: 'omit',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchStoreJSON(relative: string): Promise<{ payload: unknown; base: string; url: string }> {
  const errors: string[] = [];
  for (const base of storeBaseUrls()) {
    const url = resolveStoreUrl(relative, base);
    try {
      const response = await fetchStoreResponse(url);
      if (!response.ok) {
        errors.push(`${url} → HTTP ${response.status}`);
        continue;
      }
      const text = await response.text();
      try {
        return { payload: JSON.parse(text) as unknown, base, url };
      } catch {
        errors.push(`${url} → 不是合法 JSON`);
      }
    } catch (error) {
      errors.push(`${url} → ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`无法获取应用商店模板：${errors.join('；')}`);
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
  const { payload: raw, base } = await fetchStoreJSON('index.json');
  const payload = asRecord(raw);
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
  return {
    schemaVersion: typeof payload.schemaVersion === 'number' ? payload.schemaVersion : undefined,
    apps,
    baseUrl: base,
  };
}

export function findStoreApp(index: StoreIndex, id: string): StoreAppSummary {
  const app = index.apps.find((entry) => entry.id === id);
  if (app === undefined) throw new Error(`应用商店中没有找到 ${id}`);
  return app;
}

export async function fetchStoreApp(
  summary: StoreAppSummary,
  baseUrl?: string,
): Promise<StoreAppBundle> {
  // 索引成功读取的那个 base 最可靠；没有时回退到候选列表。
  const base = baseUrl ?? storeBaseUrl();
  const manifestUrl = resolveStoreUrl(summary.manifest, base);
  const manifestResult = await fetchStoreJSONFromBase(manifestUrl);
  const raw = asRecord(manifestResult.payload);
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
    compose: await fetchTextURL(resolveStoreUrl(compose, base), '无法获取编排模板'),
    manifestUrl: manifestResult.url,
  };
}

async function fetchTextURL(url: string, label: string): Promise<string> {
  let response: Response;
  try {
    response = await fetchStoreResponse(url);
  } catch (error) {
    throw new Error(`${label}：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) throw new Error(`${label}：HTTP ${response.status}`);
  return response.text();
}

async function fetchStoreJSONFromBase(url: string): Promise<{ payload: unknown; url: string }> {
  const text = await fetchTextURL(url, '无法获取应用清单');
  try {
    return { payload: JSON.parse(text) as unknown, url };
  } catch {
    throw new Error(`应用清单不是合法 JSON：${url}`);
  }
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
