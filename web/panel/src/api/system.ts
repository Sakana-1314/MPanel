import type { SystemInfo, SystemMetrics, SystemOverview, SystemSnapshot } from './types';
import type { ApiTransport } from './transport';
import { currentClient } from './current';
import { scopedKey } from '../lib/query-keys';

export const systemKeys = {
  info: (refresh?: boolean) => scopedKey('system', 'info', refresh ?? false),
  overview: () => scopedKey('system', 'overview'),
  /** worker `/system/metrics`；core 连接下属于当前选中机器。 */
  metrics: () => scopedKey('system', 'metrics'),
  /** worker `/system/snapshot`；core 连接下属于当前选中机器。 */
  snapshot: () => scopedKey('system', 'snapshot'),
};

export interface SystemApi {
  /** 走特性基路径：core 选中机器时返回该 worker 的能力。 */
  info(refresh?: boolean): Promise<SystemInfo>;
  /** 仅 core 根 /api/v1/system/overview。 */
  overview(): Promise<SystemOverview>;
  /** worker `GET /system/metrics`（core 经机器代理）。 */
  metrics(): Promise<SystemMetrics>;
  /** worker `GET /system/snapshot`（core 经机器代理）。 */
  snapshot(): Promise<SystemSnapshot>;
}

export function createSystemApi(http: ApiTransport): SystemApi {
  return {
    info: (refresh) =>
      http.request<SystemInfo>('/system/info', {
        query: refresh === undefined ? undefined : { refresh: refresh ? '1' : '0' },
      }),
    overview: () => http.requestRoot<SystemOverview>('/system/overview'),
    metrics: () => http.request<SystemMetrics>('/system/metrics'),
    snapshot: () => http.request<SystemSnapshot>('/system/snapshot'),
  };
}

export function getSystemInfo(refresh?: boolean): Promise<SystemInfo> {
  return currentClient().system.info(refresh);
}

export function getSystemOverview(): Promise<SystemOverview> {
  return currentClient().system.overview();
}

export function getSystemMetrics(): Promise<SystemMetrics> {
  return currentClient().system.metrics();
}

export function getSystemSnapshot(): Promise<SystemSnapshot> {
  return currentClient().system.snapshot();
}

