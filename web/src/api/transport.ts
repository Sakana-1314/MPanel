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
 * - `request` 走“特性 API 基路径”（worker /api/v1 或 core 的 /proxy 前缀）；
 * - `requestRoot` 走连接根 /api/v1（auth/*、machines/*、system/overview 必须用它，
 *   否则选中机器后会被代理到 worker 而 404）。
 */
export interface ApiTransport {
  readonly baseUrl: string;
  readonly apiBaseUrl: string;
  readonly token?: string;
  readonly machineId?: string;
  readonly kind: 'worker' | 'core';
  url(path: string, query?: QueryParams): string;
  rootUrl(path: string, query?: QueryParams): string;
  raw(path: string, opts?: ApiRequestOptions): Promise<Response>;
  rawRoot(path: string, opts?: ApiRequestOptions): Promise<Response>;
  request<T>(path: string, opts?: ApiRequestOptions): Promise<T>;
  requestRoot<T>(path: string, opts?: ApiRequestOptions): Promise<T>;
  wsPathFor(featurePath: string): string;
  wsUrl(featurePath: string, ticket: string): string;
  getWsTicket(featurePath: string): Promise<WsTicket>;
}
