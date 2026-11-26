import type { Job, ListResult, PageQuery } from './types';
import type { ApiTransport } from './transport';
import { currentClient } from './current';
import { scopedKey } from '../lib/query-keys';

export interface JobListQuery extends PageQuery {
  status?: Job['status'];
  kind?: string;
}

export interface JobsApi {
  list(q?: JobListQuery): Promise<ListResult<Job>>;
  get(id: string): Promise<Job>;
  cancel(id: string): Promise<{ cancelled: true; job: Job }>;
}

export const jobsKeys = {
  list: (params?: object) => scopedKey('jobs', 'list', params ?? {}),
  job: (id: string) => scopedKey('jobs', 'job', id),
};

export function createJobsApi(http: ApiTransport): JobsApi {
  const base = (id: string): string => `/jobs/${encodeURIComponent(id)}`;
  return {
    list: (q = {}) => http.request<ListResult<Job>>('/jobs', { query: q }),
    get: (id) => http.request<Job>(base(id)),
    cancel: (id) => http.request<{ cancelled: true; job: Job }>(`${base(id)}/cancel`, { method: 'POST' }),
  };
}

export function listJobs(q: JobListQuery = {}): Promise<ListResult<Job>> {
  return currentClient().jobs.list(q);
}

export function getJob(id: string): Promise<Job> {
  return currentClient().jobs.get(id);
}

export function cancelJob(id: string): Promise<{ cancelled: true; job: Job }> {
  return currentClient().jobs.cancel(id);
}
