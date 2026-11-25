import type {
  EdgeJob,
  EdgeJobCreateInput,
  EdgeJobKind,
  EdgeJobStatus,
  EdgeKey,
  EdgeKeyCreateInput,
  EdgeKeyCreateResult,
  ListResult,
  PageQuery,
  Site,
  Task,
} from './types';
import type { ApiTransport } from './transport';
import { createClient, type ApiClient } from './client';
import { currentClient } from './current';
import { getActiveConnection } from '../lib/connection-store';
import { scopedKey } from '../lib/query-keys';

export interface EdgeJobListQuery extends PageQuery {
  machineId?: string;
  status?: EdgeJobStatus;
}

export const edgeKeys = {
  keys: (params?: object) => scopedKey('edge', 'keys', params ?? {}),
  /** 前缀 key，用于 invalidate 所有 keys 查询。 */
  keysRoot: () => scopedKey('edge', 'keys'),
  jobs: (params?: object) => scopedKey('edge', 'jobs', params ?? {}),
  /** 前缀 key，用于 invalidate 所有 jobs 查询。 */
  jobsRoot: () => scopedKey('edge', 'jobs'),
  job: (id: string) => scopedKey('edge', 'job', id),
  /** 新建作业对话框按目标机器读取任务/站点；与当前选中机器无关。 */
  machineTasks: (machineId: string) => scopedKey('edge', 'machine-tasks', machineId),
  machineSites: (machineId: string) => scopedKey('edge', 'machine-sites', machineId),
};

/**
 * 边缘节点端点全部属于 core 根 /api/v1（§5.4），即使已选中机器也不能走 /proxy。
 * 因而所有方法使用 requestRoot。
 */
export interface EdgeApi {
  listKeys(): Promise<ListResult<EdgeKey>>;
  createKey(input: EdgeKeyCreateInput): Promise<EdgeKeyCreateResult>;
  revokeKey(id: string): Promise<{ revoked: true }>;
  listJobs(q?: EdgeJobListQuery): Promise<ListResult<EdgeJob>>;
  createJob(input: EdgeJobCreateInput): Promise<EdgeJob>;
  getJob(id: string): Promise<EdgeJob>;
  deleteJob(id: string): Promise<{ deleted: true }>;
}

export function createEdgeApi(http: ApiTransport): EdgeApi {
  const job = (id: string): string => `/edge/jobs/${encodeURIComponent(id)}`;
  return {
    listKeys: () => http.requestRoot<ListResult<EdgeKey>>('/edge/keys'),
    createKey: (input) =>
      http.requestRoot<EdgeKeyCreateResult>('/edge/keys', { method: 'POST', body: input }),
    revokeKey: (id) =>
      http.requestRoot<{ revoked: true }>(`/edge/keys/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    listJobs: (q = {}) => http.requestRoot<ListResult<EdgeJob>>('/edge/jobs', { query: q }),
    createJob: (input) =>
      http.requestRoot<EdgeJob>('/edge/jobs', { method: 'POST', body: input }),
    getJob: (id) => http.requestRoot<EdgeJob>(job(id)),
    deleteJob: (id) => http.requestRoot<{ deleted: true }>(job(id), { method: 'DELETE' }),
  };
}

/* --------------------------- 当前 core 连接上的调用 --------------------------- */

function edgeApi(): EdgeApi {
  return createEdgeApi(currentClient());
}

export function listEdgeKeys(): Promise<ListResult<EdgeKey>> {
  return edgeApi().listKeys();
}

export function createEdgeKey(input: EdgeKeyCreateInput): Promise<EdgeKeyCreateResult> {
  return edgeApi().createKey(input);
}

export function revokeEdgeKey(id: string): Promise<{ revoked: true }> {
  return edgeApi().revokeKey(id);
}

export function listEdgeJobs(q: EdgeJobListQuery = {}): Promise<ListResult<EdgeJob>> {
  return edgeApi().listJobs(q);
}

export function createEdgeJob(input: EdgeJobCreateInput): Promise<EdgeJob> {
  return edgeApi().createJob(input);
}

export function getEdgeJob(id: string): Promise<EdgeJob> {
  return edgeApi().getJob(id);
}

export function deleteEdgeJob(id: string): Promise<{ deleted: true }> {
  return edgeApi().deleteJob(id);
}

/**
 * 作业的 run-task / apply-site 下拉需要目标机器上的任务与站点。
 * 边缘页面是 core 级页面，当前工作台标签可能不是目标节点，因此按 machineId
 * 新建一个 core 代理客户端。
 */
function edgeMachineClient(machineId: string): ApiClient {
  const connection = getActiveConnection();
  return createClient({
    baseUrl: connection?.baseUrl ?? '',
    token: connection?.token,
    machineId,
  });
}

export function listEdgeTargetTasks(machineId: string): Promise<ListResult<Task>> {
  return edgeMachineClient(machineId).tasks.list({ limit: 200 });
}

export function listEdgeTargetSites(machineId: string): Promise<ListResult<Site>> {
  return edgeMachineClient(machineId).sites.list({ limit: 200 });
}
