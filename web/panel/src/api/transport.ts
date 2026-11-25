import type { WsTicket } from './types';

export type QueryValue = string | number | boolean | null | undefined;
/**
 * 查询参数对象。使用 `object` 以便站点/证书等具体 query interface 直接传入，
 * 序列化逻辑（buildQueryString）负责展开数组与布尔值。
 */
export type QueryParams = object;

export interface ApiRequestOptions {
  method?: string;
  body?: unknown;
  query?: QueryParams;
  signal?: AbortSignal;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

/**
 * 页面/资源模块只依赖该接口：
 * - `request` 走“机器特性基路径”（core 的 /machines/:id/proxy）；
 * - `requestRoot` 走 core 根 /api/v1（auth/*、machines/*、edge/*、system/overview）。
 */
export interface ApiTransport {
  /** 特性基路径；没有绑定机器时等于 core 根。 */
  readonly baseUrl: string;
  /** core 根 /api/v1。 */
  readonly apiBaseUrl: string;
  readonly token?: string;
  readonly machineId?: string;
  url(path: string, query?: QueryParams): string;
  rootUrl(path: string, query?: QueryParams): string;
  raw(path: string, opts?: ApiRequestOptions): Promise<Response>;
  rawRoot(path: string, opts?: ApiRequestOptions): Promise<Response>;
  request<T>(path: string, opts?: ApiRequestOptions): Promise<T>;
  requestRoot<T>(path: string, opts?: ApiRequestOptions): Promise<T>;
  /** `/ws/terminal/x` → `/api/v1/machines/<id>/proxy/ws/terminal/x`。 */
  wsPathFor(featurePath: string): string;
  wsUrl(featurePath: string, ticket: string): string;
  getWsTicket(featurePath: string): Promise<WsTicket>;
}
