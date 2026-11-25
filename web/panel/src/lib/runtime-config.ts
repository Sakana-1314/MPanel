import type { RuntimeBackendSeed, RuntimeConfig } from '../api/types';
import { normalizeBaseUrl } from './connection-store';

/**
 * 默认后端来源（优先级从高到低）：
 * 1. config.json（运行时静态文件，可覆盖同 id 的后端，不含 token）；
 * 2. VITE_DEFAULT_BACKENDS（JSON 数组，优先于单个默认后端）；
 * 3. VITE_DEFAULT_BACKEND + VITE_DEFAULT_BACKEND_NAME/TOKEN/KIND。
 * config.json 与编译期默认按 id 合并，同 id 覆盖，其余追加。
 */

let current: RuntimeConfig = mergeRuntimeConfig(undefined, import.meta.env);

export function backendSeedId(kind: 'worker' | 'core', baseUrl: string): string {
  return `b:${kind}:${normalizeBaseUrl(baseUrl)}`;
}

/** 编译期环境变量 → 连接种子。 */
export function envBackendSeeds(env: ImportMetaEnv): RuntimeBackendSeed[] {
  const seeds: RuntimeBackendSeed[] = [];
  const multi = parseBackendsJson(env.VITE_DEFAULT_BACKENDS);
  for (const item of multi) {
    const baseUrl = normalizeBaseUrl(item.baseUrl ?? '');
    if (baseUrl.length === 0) continue;
    const kind = item.kind === 'core' ? 'core' : 'worker';
    seeds.push({
      id: item.id !== undefined && item.id.length > 0 ? item.id : backendSeedId(kind, baseUrl),
      name: item.name ?? item.label ?? `${kind.toUpperCase()} 后端`,
      kind,
      baseUrl,
      token: item.token,
      username: item.username,
    });
  }
  if (seeds.length > 0) return seeds;

  const single = env.VITE_DEFAULT_BACKEND;
  if (single !== undefined && single.trim().length > 0) {
    const baseUrl = normalizeBaseUrl(single);
    const kind = env.VITE_DEFAULT_BACKEND_KIND === 'core' ? 'core' : 'worker';
    seeds.push({
      id: backendSeedId(kind, baseUrl),
      name: env.VITE_DEFAULT_BACKEND_NAME ?? env.VITE_DEFAULT_BACKEND_LABEL ?? '默认后端',
      kind,
      baseUrl,
      token: env.VITE_DEFAULT_BACKEND_TOKEN,
    });
  }
  return seeds;
}

interface RawBackendEntry {
  id?: string;
  url?: string;
  baseUrl?: string;
  kind?: 'worker' | 'core';
  label?: string;
  name?: string;
  token?: string;
  username?: string;
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
    // 非法 JSON 静默忽略，回退到单个默认后端。
    return [];
  }
}

function configFileSeeds(configFile: Partial<RuntimeConfig> | undefined): RuntimeBackendSeed[] {
  if (configFile === undefined) return [];
  const seeds: RuntimeBackendSeed[] = [];
  const entries: RawBackendEntry[] = [];
  if (configFile.defaultBackend !== undefined) entries.push({ ...configFile.defaultBackend });
  for (const item of configFile.backends ?? []) entries.push({ ...item });
  for (const item of entries) {
    const baseUrl = normalizeBaseUrl(item.baseUrl ?? item.url ?? '');
    if (baseUrl.length === 0) continue;
    const kind = item.kind === 'core' ? 'core' : 'worker';
    seeds.push({
      id: item.id !== undefined && item.id.length > 0 ? item.id : backendSeedId(kind, baseUrl),
      name: item.name ?? item.label ?? '默认后端',
      kind,
      baseUrl,
      // config.json 是公开文件，不允许携带凭据。
      token: undefined,
      username: undefined,
    });
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
    allowUserConnections: file.allowUserConnections ?? true,
    backendSeeds,
    defaultBackend:
      first === undefined
        ? undefined
        : { url: first.baseUrl, kind: first.kind, label: first.name },
    backends: backendSeeds.map((seed) => ({
      id: seed.id,
      url: seed.baseUrl,
      kind: seed.kind,
      label: seed.name,
    })),
  };
}

/**
 * 启动时读取 `${BASE_URL}config.json`（cache: no-store）。
 * 使用绝对基路径，深链路由不会把 config.json 解析到错误目录；404/网络失败静默忽略。
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

/** 内置默认之外，是否允许用户在 UI 中自由增删连接。 */
export function allowUserConnections(): boolean {
  return current.allowUserConnections !== false;
}
