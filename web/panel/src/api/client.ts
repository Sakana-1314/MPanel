import type { ApiEnvelope, SystemInfo, WsTicket } from './types';
import { AppError, errorFromStatus } from './errors';
import type { ApiRequestOptions, ApiTransport, QueryParams } from './transport';
import { setCurrentClientSupplier } from './current';
import { getActiveConnection } from '../lib/connection-store';
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
import { joinUrl, toWsUrl } from '../lib/paths';

export { AppError, ApiError, describeError, isAppError, errorFromStatus } from './errors';
export type { AppErrorCode, AppErrorDetails, ErrorDescription } from './errors';
export type { ApiRequestOptions, ApiTransport, QueryParams, QueryValue } from './transport';

const envTimeout = Number(import.meta.env.VITE_API_TIMEOUT_MS ?? '');
export const DEFAULT_TIMEOUT_MS =
  Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 120_000;

/** 连接地址 → /api/v1 根。兼容用户粘贴完整 API/代理地址。 */
function normalizeApiRoot(raw: string): string {
  let url = raw.trim().replace(/\/+$/, '');
  url = url.replace(/\/api\/v1$/i, '');
  url = url.replace(/\/machines\/[^/]+\/proxy$/i, '');
  return url;
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
    throw new AppError('UNAVAILABLE', '尚未选择服务器', 0, {
      hint: '请先填写服务器地址并登录。',
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
      // 面板只用 Authorization: Bearer 鉴权，不需要也不应该带 Cookie。
      credentials: 'omit',
      signal: controller.signal,
    });
    if (!response.ok) throw await parseErrorResponse(response);
    return response;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (timedOut) {
      throw new AppError('TIMEOUT', `请求超时（${Math.round(timeoutMs / 1000)} 秒）`, 0, {
        hint: '请确认服务器在线、目标机器可用、任务耗时是否过长，然后重试。',
      });
    }
    if (isAborted(opts.signal) || controller.signal.aborted) {
      throw new AppError('ABORTED', '请求已被取消', 0);
    }
    throw new AppError('NETWORK', '无法连接服务器', 0, {
      hint: '请确认服务器地址可访问、网络连通，以及跨域（CORS）配置正确。',
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
      hint: '服务器或反向代理可能返回了 HTML 错误页。',
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
  /** core 服务根地址，如 https://panel.example.com（可带 /api/v1，会被规范化）。 */
  baseUrl: string;
  /** 可选：绑定机器后，特性请求走 /api/v1/machines/<id>/proxy。 */
  machineId?: string;
  /** 可选：core Bearer token（脚本/无 cookie 环境）。 */
  token?: string;
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
 * 创建一个绑定到 core（可选再绑定机器）的客户端。
 * 前端不允许直连 agent；所有特性请求都必须经 core 的机器代理。
 */
export function createClient(options: CreateClientOptions): ApiClient {
  const apiRoot = normalizeApiRoot(options.baseUrl ?? '');
  const apiBaseUrl = apiRoot.length === 0 ? '' : `${apiRoot}/api/v1`;
  const machineId = options.machineId;
  const featureBaseUrl =
    machineId !== undefined && machineId.length > 0
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
      const mid = transport.machineId;
      if (mid === undefined || mid.length === 0) {
        throw new AppError('UNAVAILABLE', '尚未绑定机器', 0, {
          hint: 'WebSocket 只能在具体机器的页面中建立。',
        });
      }
      return `/api/v1/machines/${encodeURIComponent(mid)}/proxy/ws${suffix}`;
    },
    wsUrl: (featurePath, ticket) => {
      if (apiRoot.length === 0) {
        throw new AppError('UNAVAILABLE', '尚未选择服务器', 0, {
          hint: '请先填写服务器地址并登录。',
        });
      }
      const mid = transport.machineId;
      if (mid === undefined || mid.length === 0) {
        throw new AppError('UNAVAILABLE', '尚未绑定机器', 0, {
          hint: 'WebSocket 只能在具体机器的页面中建立。',
        });
      }
      const suffix = normalizeFeaturePath(featurePath);
      const wsRoot = `${toWsUrl(apiRoot)}/api/v1/machines/${encodeURIComponent(mid)}/proxy/ws`;
      const separator = suffix.includes('?') ? '&' : '?';
      return `${wsRoot}${suffix}${separator}ticket=${encodeURIComponent(ticket)}`;
    },
    getWsTicket: async (featurePath) => {
      const path = transport.wsPathFor(featurePath);
      return transport.requestRoot<WsTicket>('/auth/ws-ticket', {
        method: 'POST',
        body: { path, machineId: transport.machineId },
      });
    },
  };

  return {
    ...transport,
    withToken: (nextToken) =>
      createClient({
        baseUrl: apiRoot,
        token: nextToken,
        machineId,
        timeoutMs,
        fetchImpl,
      }),
    withMachine: (nextMachineId) =>
      createClient({
        baseUrl: apiRoot,
        token,
        machineId: nextMachineId,
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

/* ------------------------- 当前连接客户端（core 根） ------------------------- */

const cache = new Map<string, ApiClient>();

function clientKey(baseUrl: string, machineId?: string, token?: string): string {
  return `${baseUrl}|${machineId ?? ''}|${token ?? ''}`;
}

/** 当前 core 连接（不带机器上下文）的客户端；资源页面应使用 useMachineApi。 */
export function getCoreClient(): ApiClient {
  const connection = getActiveConnection();
  const baseUrl = connection?.baseUrl ?? '';
  const token = connection?.token;
  const key = clientKey(baseUrl, undefined, token);
  const existing = cache.get(key);
  if (existing !== undefined) return existing;
  const client = createClient({ baseUrl, token });
  cache.set(key, client);
  return client;
}

/** 绑定具体机器的客户端；多机标签页必须使用它，而不是全局“当前机器”。 */
export function getMachineClient(machineId: string): ApiClient {
  const connection = getActiveConnection();
  const baseUrl = connection?.baseUrl ?? '';
  const token = connection?.token;
  const key = clientKey(baseUrl, machineId, token);
  const existing = cache.get(key);
  if (existing !== undefined) return existing;
  const client = createClient({ baseUrl, token, machineId });
  cache.set(key, client);
  return client;
}

setCurrentClientSupplier(getCoreClient);

/* ------------------------- 兼容函数式 API（core 根） ------------------------- */

export function apiUrl(path: string, query?: QueryParams): string {
  return getCoreClient().rootUrl(path, query);
}

export function apiRaw(path: string, opts: ApiRequestOptions = {}): Promise<Response> {
  return getCoreClient().rawRoot(path, opts);
}

export function apiRequest<T>(path: string, opts: ApiRequestOptions = {}): Promise<T> {
  return getCoreClient().requestRoot<T>(path, opts);
}

/* --------------------------- 连接探测（UI 用） --------------------------- */

export interface ConnectionProbeResult {
  ok: boolean;
  latencyMs: number;
  /** /healthz 返回的 core 信息。 */
  info?: { status: string; version: string; role: string };
  error?: AppError;
  /** core 可访问但未登录时的提示（仍视为连通）。 */
  notice?: string;
}

/** 测试 core 连通性：GET <base>/healthz，返回延迟与版本；失败不抛异常。 */
export async function probeConnection(input: {
  baseUrl: string;
  timeoutMs?: number;
}): Promise<ConnectionProbeResult> {
  const started = nowMs();
  const base = normalizeApiRoot(input.baseUrl);
  if (base.length === 0) {
    return {
      ok: false,
      latencyMs: 0,
      error: new AppError('BAD_REQUEST', '请填写服务器地址', 0, {
        hint: '例如 https://panel.example.com 或 http://127.0.0.1:10086。',
      }),
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 10_000);
  try {
    const response = await fetch(joinUrl(base, '/healthz'), {
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
    });
    if (!response.ok) {
      throw errorFromStatus(response.status, `服务器 /healthz 返回 HTTP ${response.status}`);
    }
    const payload = (await response.json()) as {
      status?: string;
      version?: string;
      role?: string;
      data?: { status?: string; version?: string; role?: string };
    };
    // 兼容非信封（契约）与实际 Go core 的信封两种 healthz 形态。
    const body = payload.data ?? payload;
    if (body.role !== 'core') {
      return {
        ok: false,
        latencyMs: Math.round(nowMs() - started),
        error: new AppError('BAD_REQUEST', '该地址不是 MPanel 面板', 0, {
          hint: `返回类型为 ${body.role ?? '未知'}；请填写 MPanel 面板服务地址。`,
        }),
      };
    }
    return {
      ok: true,
      latencyMs: Math.round(nowMs() - started),
      info: { status: body.status ?? 'ok', version: body.version ?? '?', role: body.role },
    };
  } catch (error) {
    const appError =
      error instanceof AppError
        ? error
        : new AppError('NETWORK', '无法连接服务器', 0, {
            hint: '请确认地址、网络与 CORS 配置；面板服务默认端口 10086。',
            reason: error instanceof Error ? error.message : String(error),
          });
    return { ok: false, latencyMs: Math.round(nowMs() - started), error: appError };
  } finally {
    clearTimeout(timer);
  }
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
