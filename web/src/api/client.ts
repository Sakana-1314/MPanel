import type { ApiEnvelope, SystemInfo, WsTicket } from './types';
import { AppError, errorFromStatus } from './errors';
import type { ApiRequestOptions, ApiTransport, QueryParams, QueryValue } from './transport';
import { setCurrentClientSupplier } from './current';
import { createAuthApi, type AuthApi } from './auth';
import { createSystemApi, type SystemApi } from './system';
import { createMachinesApi, type MachinesApi } from './machines';
import { createSitesApi, type SitesApi } from './sites';
import { createCertsApi, type CertsApi } from './certs';
import { createDatabasesApi, type DatabasesApi } from './databases';
import {
  createContainersApi,
  createImagesApi,
  createStacksApi,
  type ContainersApi,
  type ImagesApi,
  type StacksApi,
} from './containers';
import { createFilesApi, type FilesApi } from './files';
import { createTerminalApi, type TerminalApi } from './terminal';
import { createTasksApi, type TasksApi } from './tasks';
import { buildBasePath, getActiveConnection, getSelectedMachineId } from '../lib/connection-store';
import { joinUrl, toWsUrl } from '../lib/paths';

export { AppError, ApiError, describeError, isAppError, errorFromStatus } from './errors';
export type { AppErrorCode, AppErrorDetails, ErrorDescription } from './errors';
export type { ApiRequestOptions, ApiTransport, QueryParams, QueryValue } from './transport';

const envTimeout = Number(import.meta.env.VITE_API_TIMEOUT_MS ?? '');
export const DEFAULT_TIMEOUT_MS =
  Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 120_000;

/** 连接地址 → /api/v1 根。core 的代理特性基路径会被还原成 core 根。 */
function stripProxySuffix(url: string): string {
  return url.replace(/\/machines\/[^/]+\/proxy$/i, '');
}

function stripTrailingSlash(url: string): string {
  return url.length > 1 ? url.replace(/\/+$/, '') : url;
}

function normalizeFeaturePath(featurePath: string): string {
  if (featurePath.length === 0) return '/';
  return featurePath.startsWith('/') ? featurePath : `/${featurePath}`;
}

function stringifyQueryValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function buildQueryString(query?: QueryParams): string {
  if (query === undefined) return '';
  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(query as Record<string, unknown>)) {
    if (raw === undefined || raw === null) continue;
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (item === undefined || item === null) continue;
        params.append(key, stringifyQueryValue(item));
      }
      continue;
    }
    params.set(key, stringifyQueryValue(raw));
  }
  const text = params.toString();
  return text.length === 0 ? '' : `?${text}`;
}

export function buildUrl(base: string, path: string, query?: QueryParams): string {
  const suffix = normalizeFeaturePath(path);
  const head = base.length === 0 ? suffix : joinUrl(base, suffix);
  const qs = buildQueryString(query);
  if (qs.length === 0) return head;
  return head.includes('?') ? `${head}&${qs.slice(1)}` : `${head}${qs}`;
}

function isEnvelope(value: unknown): value is ApiEnvelope<unknown> {
  return typeof value === 'object' && value !== null && 'ok' in value;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

async function parseErrorResponse(response: Response): Promise<AppError> {
  let text = '';
  try {
    text = await response.text();
  } catch {
    text = '';
  }
  if (text.length > 0) {
    try {
      const payload = JSON.parse(text) as unknown;
      if (isEnvelope(payload) && payload.ok === false) {
        return new AppError(
          payload.error.code,
          payload.error.message,
          response.status,
          payload.error.details,
        );
      }
    } catch {
      // 非 JSON：可能是代理/网关 HTML 错误页，下面按状态码映射。
    }
  }
  const trimmed = text.trim();
  return errorFromStatus(
    response.status,
    trimmed.length > 0 ? trimmed.slice(0, 400) : response.statusText,
  );
}

async function execute(
  fetchImpl: typeof fetch,
  url: string,
  token: string | undefined,
  opts: ApiRequestOptions,
  defaultTimeoutMs: number,
): Promise<Response> {
  if (url.length === 0) {
    throw new AppError('UNAVAILABLE', '尚未选择后端连接', 0, {
      hint: '请先在侧边栏选择或新增一个后端连接。',
    });
  }
  if (opts.signal?.aborted === true) {
    throw new AppError('ABORTED', '请求已被取消', 0);
  }

  const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
  if (token !== undefined && token.length > 0) headers.authorization = `Bearer ${token}`;

  let body: BodyInit | undefined;
  const payload = opts.body;
  if (payload !== undefined) {
    if (
      typeof FormData !== 'undefined' &&
      (payload instanceof FormData ||
        payload instanceof Blob ||
        payload instanceof URLSearchParams ||
        payload instanceof ArrayBuffer ||
        ArrayBuffer.isView(payload) ||
        typeof payload === 'string')
    ) {
      body = payload as BodyInit;
    } else {
      body = JSON.stringify(payload);
      if (headers['content-type'] === undefined) {
        headers['content-type'] = 'application/json; charset=utf-8';
      }
    }
  }

  const timeoutMs =
    opts.timeoutMs !== undefined && opts.timeoutMs > 0 ? opts.timeoutMs : defaultTimeoutMs;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onExternalAbort = (): void => controller.abort();
  opts.signal?.addEventListener('abort', onExternalAbort);

  try {
    const response = await fetchImpl(url, {
      method: opts.method ?? 'GET',
      headers,
      body,
      credentials: 'include',
      signal: controller.signal,
    });
    if (!response.ok) throw await parseErrorResponse(response);
    return response;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (timedOut) {
      throw new AppError('TIMEOUT', `请求超时（${Math.round(timeoutMs / 1000)} 秒）`, 0, {
        hint: '请确认后端是否在线、任务是否耗时过长，然后重试。',
      });
    }
    if (isAborted(opts.signal)) {
      throw new AppError('ABORTED', '请求已被取消', 0);
    }
    if (controller.signal.aborted) {
      throw new AppError('ABORTED', '请求已被取消', 0);
    }
    throw new AppError('NETWORK', '无法连接后端', 0, {
      hint: '请确认后端地址可访问、网络连通，以及跨域（CORS）配置正确。',
      reason: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onExternalAbort);
  }
}

async function readEnvelope<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (text.trim().length === 0) return undefined as T;
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new AppError('INTERNAL', '响应不是合法的 JSON', response.status, {
      hint: '后端可能被反向代理改写，或返回了 HTML 错误页。',
      reason: text.slice(0, 200),
    });
  }
  if (!isEnvelope(payload)) {
    throw new AppError('INTERNAL', '响应不是标准信封', response.status, {
      hint: '除 /healthz 与文件下载外，接口必须返回 { ok, data | error } 信封。',
    });
  }
  if (payload.ok === false) {
    throw new AppError(payload.error.code, payload.error.message, response.status, payload.error.details);
  }
  return payload.data as T;
}

export interface CreateClientOptions {
  baseUrl: string;
  token?: string;
  machineId?: string;
  kind?: 'worker' | 'core';
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface ApiClient extends ApiTransport {
  withToken(token?: string): ApiClient;
  withMachine(machineId?: string): ApiClient;
  auth: AuthApi;
  system: SystemApi;
  machines: MachinesApi;
  sites: SitesApi;
  certs: CertsApi;
  databases: DatabasesApi;
  containers: ContainersApi;
  images: ImagesApi;
  stacks: StacksApi;
  files: FilesApi;
  terminal: TerminalApi;
  tasks: TasksApi;
}

/**
 * 创建一个绑定到具体后端（可再绑定机器）的客户端。
 * 页面层一般用 getClient()，测试/连接探测可以独立 createClient。
 */
export function createClient(options: CreateClientOptions): ApiClient {
  const kind = options.kind ?? 'worker';
  const rawBase = stripTrailingSlash(options.baseUrl ?? '');
  const apiBaseUrl = stripProxySuffix(rawBase);
  const machineId = kind === 'core' ? options.machineId : undefined;
  const featureBaseUrl =
    kind === 'core' && machineId !== undefined && machineId.length > 0
      ? `${apiBaseUrl}/machines/${encodeURIComponent(machineId)}/proxy`
      : apiBaseUrl;
  const token = options.token;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const transport: ApiTransport = {
    baseUrl: featureBaseUrl,
    apiBaseUrl,
    token,
    machineId,
    kind,
    url: (path, query) => buildUrl(featureBaseUrl, path, query),
    rootUrl: (path, query) => buildUrl(apiBaseUrl, path, query),
    raw: async (path, opts = {}) =>
      execute(fetchImpl, buildUrl(featureBaseUrl, path, opts.query), token, opts, timeoutMs),
    rawRoot: async (path, opts = {}) =>
      execute(fetchImpl, buildUrl(apiBaseUrl, path, opts.query), token, opts, timeoutMs),
    request: async <T>(path: string, opts: ApiRequestOptions = {}): Promise<T> =>
      readEnvelope<T>(
        await execute(fetchImpl, buildUrl(featureBaseUrl, path, opts.query), token, opts, timeoutMs),
      ),
    requestRoot: async <T>(path: string, opts: ApiRequestOptions = {}): Promise<T> =>
      readEnvelope<T>(
        await execute(fetchImpl, buildUrl(apiBaseUrl, path, opts.query), token, opts, timeoutMs),
      ),
    wsPathFor: (featurePath) => {
      const suffix = normalizeFeaturePath(featurePath);
      if (kind === 'worker') return `/ws${suffix}`;
      if (machineId !== undefined && machineId.length > 0) {
        return `/api/v1/machines/${encodeURIComponent(machineId)}/proxy/ws${suffix}`;
      }
      return `/ws${suffix}`;
    },
    wsUrl: (featurePath, ticket) => {
      if (apiBaseUrl.length === 0) {
        throw new AppError('UNAVAILABLE', '尚未选择后端连接', 0, {
          hint: '请先在侧边栏选择或新增一个后端连接。',
        });
      }
      const suffix = normalizeFeaturePath(featurePath);
      const wsRoot =
        kind === 'core' && machineId !== undefined && machineId.length > 0
          ? `${toWsUrl(featureBaseUrl)}/ws`
          : `${toWsUrl(apiBaseUrl.replace(/\/api\/v1$/i, ''))}/ws`;
      const separator = suffix.includes('?') ? '&' : '?';
      return `${wsRoot}${suffix}${separator}ticket=${encodeURIComponent(ticket)}`;
    },
    getWsTicket: async (featurePath) => {
      const path = transport.wsPathFor(featurePath);
      const body =
        kind === 'core' && machineId !== undefined && machineId.length > 0
          ? { path, machineId }
          : { path };
      return transport.requestRoot<WsTicket>('/auth/ws-ticket', { method: 'POST', body });
    },
  };

  return {
    ...transport,
    withToken: (nextToken) =>
      createClient({
        baseUrl: apiBaseUrl,
        token: nextToken,
        machineId,
        kind,
        timeoutMs,
        fetchImpl,
      }),
    withMachine: (nextMachineId) =>
      createClient({
        baseUrl: apiBaseUrl,
        token,
        machineId: nextMachineId,
        kind,
        timeoutMs,
        fetchImpl,
      }),
    auth: createAuthApi(transport),
    system: createSystemApi(transport),
    machines: createMachinesApi(transport),
    sites: createSitesApi(transport),
    certs: createCertsApi(transport),
    databases: createDatabasesApi(transport),
    containers: createContainersApi(transport),
    images: createImagesApi(transport),
    stacks: createStacksApi(transport),
    files: createFilesApi(transport),
    terminal: createTerminalApi(transport),
    tasks: createTasksApi(transport),
  };
}

/* ------------------------- 当前连接客户端（单例） ------------------------- */

let cached: { key: string; client: ApiClient } | null = null;

/** 按当前 active connection + selected machine 构造客户端；连接切换自动得到新实例。 */
export function getClient(): ApiClient {
  const connection = getActiveConnection();
  if (connection === undefined) {
    return createClient({ baseUrl: '', kind: 'worker' });
  }
  const machineId = connection.kind === 'core' ? getSelectedMachineId(connection.id) : undefined;
  const baseUrl = buildBasePath(connection, machineId);
  const key = `${connection.id}|${machineId ?? ''}|${connection.token ?? ''}`;
  if (cached !== null && cached.key === key) return cached.client;
  const client = createClient({
    baseUrl,
    token: connection.token,
    machineId,
    kind: connection.kind,
  });
  cached = { key, client };
  return client;
}

setCurrentClientSupplier(getClient);

/* ------------------------- 兼容函数式 API ------------------------- */

export function apiUrl(path: string, query?: QueryParams): string {
  return getClient().url(path, query);
}

/** 直接取原始 Response（下载/流式）；非 2xx 抛 AppError。 */
export function apiRaw(path: string, opts: ApiRequestOptions = {}): Promise<Response> {
  return getClient().raw(path, opts);
}

/** 解包信封并返回 data；所有失败映射为 AppError。 */
export function apiRequest<T>(path: string, opts: ApiRequestOptions = {}): Promise<T> {
  return getClient().request<T>(path, opts);
}

/* --------------------------- 连接探测（UI 用） --------------------------- */

export interface ConnectionProbeResult {
  ok: boolean;
  latencyMs: number;
  info?: SystemInfo;
  error?: AppError;
  /** core 可访问但未登录时的提示（仍视为连通）。 */
  notice?: string;
}

/** 测试连接：GET /system/info，返回延迟与版本；失败不抛异常。 */
export async function probeConnection(input: {
  baseUrl: string;
  kind: 'worker' | 'core';
  token?: string;
  timeoutMs?: number;
}): Promise<ConnectionProbeResult> {
  const started = nowMs();
  const client = createClient({
    baseUrl: input.baseUrl,
    kind: input.kind,
    token: input.token,
    timeoutMs: input.timeoutMs ?? 10_000,
  });
  try {
    const info = await client.system.info(true);
    return { ok: true, latencyMs: Math.round(nowMs() - started), info };
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError('INTERNAL', error instanceof Error ? error.message : String(error), 0);
    // core 的 /system/info 需要会话；401/403 说明服务可达，只是尚未登录。
    if (
      input.kind === 'core' &&
      (appError.code === 'UNAUTHORIZED' || appError.code === 'FORBIDDEN')
    ) {
      return {
        ok: true,
        latencyMs: Math.round(nowMs() - started),
        error: appError,
        notice: 'core 可访问，但需要登录（当前会话未建立）。',
      };
    }
    return {
      ok: false,
      latencyMs: Math.round(nowMs() - started),
      error: appError,
    };
  }
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
