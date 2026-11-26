import type { RuntimeBackendSeed, RuntimeConfig } from '../api/types';
import { normalizeBaseUrl } from './connection-store';

/**
 * core 连接种子来源（优先级从高到低）：
 * 1. config.json（运行时静态文件，可覆盖同 id 的 core，不含 token）；
 * 2. VITE_DEFAULT_BACKENDS（JSON 数组，优先于单个默认后端）；
 * 3. VITE_DEFAULT_BACKEND + VITE_DEFAULT_BACKEND_NAME/TOKEN。
 *
 * 前端只连接 core；带 kind=worker 的旧配置会被忽略。
 */

let current: RuntimeConfig = mergeRuntimeConfig(undefined, import.meta.env);

export function backendSeedId(baseUrl: string): string {
  return `b:core:${normalizeBaseUrl(baseUrl)}`;
}

interface RawBackendEntry {
  id?: string;
  url?: string;
  baseUrl?: string;
  kind?: string;
  label?: string;
  name?: string;
  token?: string;
  username?: string;
}

export function envBackendSeeds(env: ImportMetaEnv): RuntimeBackendSeed[] {
  const seeds: RuntimeBackendSeed[] = [];
  for (const item of parseBackendsJson(env.VITE_DEFAULT_BACKENDS)) {
    const seed = seedFromEntry(item);
    if (seed !== undefined) seeds.push(seed);
  }
  if (seeds.length > 0) return seeds;

  const single = env.VITE_DEFAULT_BACKEND;
  if (single !== undefined && single.trim().length > 0) {
    const baseUrl = normalizeBaseUrl(single);
    if (baseUrl.length === 0) return [];
    // 旧变量 VITE_DEFAULT_BACKEND_KIND=worker 不再支持；只接受 core/未指定。
    if (env.VITE_DEFAULT_BACKEND_KIND === 'worker') return [];
    seeds.push({
      id: backendSeedId(baseUrl),
      name: env.VITE_DEFAULT_BACKEND_NAME ?? env.VITE_DEFAULT_BACKEND_LABEL ?? '默认服务器',
      baseUrl,
      token: env.VITE_DEFAULT_BACKEND_TOKEN,
    });
  }
  return seeds;
}

function seedFromEntry(item: RawBackendEntry): RuntimeBackendSeed | undefined {
  const baseUrl = normalizeBaseUrl(item.baseUrl ?? item.url ?? '');
  if (baseUrl.length === 0) return undefined;
  // 前端已不再直连 agent；旧配置里的 worker 条目直接忽略。
  if (item.kind !== undefined && item.kind !== 'core') return undefined;
  return {
    id: item.id !== undefined && item.id.length > 0 ? item.id : backendSeedId(baseUrl),
    name: item.name ?? item.label ?? '服务器',
    baseUrl,
    token: item.token,
    username: item.username,
  };
}

function parseBackendsJson(raw: string | undefined): RawBackendEntry[] {
  if (raw === undefined || raw.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is RawBackendEntry => typeof item === 'object' && item !== null)
      .map((item) => item as RawBackendEntry);
  } catch {
    return [];
  }
}

function configFileSeeds(configFile: Partial<RuntimeConfig> | undefined): RuntimeBackendSeed[] {
  if (configFile === undefined) return [];
  const entries: RawBackendEntry[] = [];
  if (configFile.defaultBackend !== undefined) entries.push({ ...configFile.defaultBackend });
  for (const item of configFile.backends ?? []) entries.push({ ...item });
  const seeds: RuntimeBackendSeed[] = [];
  for (const item of entries) {
    const seed = seedFromEntry({ ...item, token: undefined, username: undefined });
    if (seed !== undefined) seeds.push(seed);
  }
  return seeds;
}

/** 纯函数：合并 config.json 与编译期默认。 */
export function mergeRuntimeConfig(
  configFile: Partial<RuntimeConfig> | undefined,
  env: ImportMetaEnv,
): RuntimeConfig {
  const file = configFile ?? {};
  const envSeeds = envBackendSeeds(env);
  const fileSeeds = configFileSeeds(file);

  const merged = new Map<string, RuntimeBackendSeed>();
  for (const seed of envSeeds) merged.set(seed.id, seed);
  for (const seed of fileSeeds) {
    const existing = merged.get(seed.id);
    merged.set(seed.id, {
      ...existing,
      ...seed,
      // 文件不能提供凭据，保留编译期 token。
      token: seed.token ?? existing?.token,
      username: seed.username ?? existing?.username,
    });
  }
  const backendSeeds = [...merged.values()];
  const first = backendSeeds[0];

  return {
    appName: file.appName ?? 'MPanel',
    dbxUrl: file.dbxUrl ?? env.VITE_DBX_URL,
    storeUrl: file.storeUrl ?? env.VITE_STORE_URL,
    allowUserConnections: file.allowUserConnections ?? true,
    backendSeeds,
    defaultBackend: first === undefined ? undefined : { url: first.baseUrl, label: first.name },
    backends: backendSeeds.map((seed) => ({
      id: seed.id,
      url: seed.baseUrl,
      label: seed.name,
    })),
  };
}

/**
 * 启动时读取 `${BASE_URL}config.json`（cache: no-store）。
 * 404/网络失败静默忽略。
 */
export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  const base = import.meta.env.BASE_URL || '/';
  const url = new URL(`${base.endsWith('/') ? base : `${base}/`}config.json`, window.location.origin);
  let configFile: Partial<RuntimeConfig> | undefined;
  try {
    const response = await fetch(url.toString(), { cache: 'no-store', credentials: 'omit' });
    if (response.ok) {
      const body = (await response.json()) as unknown;
      if (typeof body === 'object' && body !== null) {
        configFile = body as Partial<RuntimeConfig>;
      }
    }
  } catch {
    // 没有 config.json 是正常部署形态。
  }
  current = mergeRuntimeConfig(configFile, import.meta.env);
  return current;
}

export function getRuntimeConfig(): RuntimeConfig {
  return current;
}

export function allowUserConnections(): boolean {
  return current.allowUserConnections !== false;
}
