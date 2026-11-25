import type {
  BackupFormat,
  BackupRecord,
  DatabaseJob,
  DatabaseProfile,
  DatabaseProfileCreateInput,
  DatabaseProfileUpdateInput,
  DatabaseStats,
  DatabaseTestResult,
  HandoffTicket,
  ListResult,
  PageQuery,
} from './types';
import type { ApiTransport } from './transport';
import { currentClient } from './current';
import { scopedKey } from '../lib/query-keys';

export interface BackupRequestInput {
  format?: BackupFormat;
  label?: string;
}

export interface RestoreRequestInput {
  backupId: string;
  confirm: true;
}

export const databasesKeys = {
  profiles: (params?: object) => scopedKey('databases', 'profiles', params ?? {}),
  profile: (id: string) => scopedKey('databases', 'profile', id),
  stats: (id: string) => scopedKey('databases', 'stats', id),
  backups: (profileId: string, params?: object) =>
    scopedKey('databases', 'backups', profileId, params ?? {}),
  jobs: (params?: object) => scopedKey('databases', 'jobs', params ?? {}),
  job: (id: string) => scopedKey('databases', 'job', id),
};

export interface DatabasesApi {
  list(q?: PageQuery & { kind?: 'postgres' | 'redis'; q?: string }): Promise<ListResult<DatabaseProfile>>;
  create(input: DatabaseProfileCreateInput): Promise<DatabaseProfile>;
  get(id: string): Promise<DatabaseProfile>;
  update(id: string, input: DatabaseProfileUpdateInput): Promise<DatabaseProfile>;
  delete(id: string): Promise<{ deleted: true }>;
  test(id: string): Promise<DatabaseTestResult>;
  stats(id: string): Promise<DatabaseStats>;
  handoff(id: string, ttlSec?: number): Promise<HandoffTicket>;
  listBackups(profileId: string, q?: PageQuery): Promise<ListResult<BackupRecord>>;
  createBackup(id: string, body: BackupRequestInput): Promise<{ job: DatabaseJob }>;
  restore(id: string, body: RestoreRequestInput): Promise<{ job: DatabaseJob }>;
  getJob(id: string): Promise<DatabaseJob>;
  listJobs(q?: PageQuery & { profileId?: string; status?: string }): Promise<ListResult<DatabaseJob>>;
  deleteBackup(id: string): Promise<{ deleted: true }>;
  backupDownloadUrl(id: string): string;
}

export function createDatabasesApi(http: ApiTransport): DatabasesApi {
  const profile = (id: string): string => `/databases/profiles/${encodeURIComponent(id)}`;
  return {
    list: (q = {}) => http.request<ListResult<DatabaseProfile>>('/databases/profiles', { query: q }),
    create: (input) =>
      http.request<DatabaseProfile>('/databases/profiles', { method: 'POST', body: input }),
    get: (id) => http.request<DatabaseProfile>(profile(id)),
    update: (id, input) =>
      http.request<DatabaseProfile>(profile(id), { method: 'PATCH', body: input }),
    delete: (id) => http.request<{ deleted: true }>(profile(id), { method: 'DELETE' }),
    test: (id) =>
      http.request<DatabaseTestResult>(`${profile(id)}/test`, { method: 'POST', body: {} }),
    stats: (id) => http.request<DatabaseStats>(`${profile(id)}/stats`),
    handoff: (id, ttlSec) =>
      http.request<HandoffTicket>(`${profile(id)}/handoff`, {
        method: 'POST',
        body: ttlSec === undefined ? {} : { ttlSec },
      }),
    listBackups: (profileId, q = {}) =>
      http.request<ListResult<BackupRecord>>(`${profile(profileId)}/backups`, { query: q }),
    createBackup: (id, body) =>
      http.request<{ job: DatabaseJob }>(`${profile(id)}/backup`, { method: 'POST', body }),
    restore: (id, body) =>
      http.request<{ job: DatabaseJob }>(`${profile(id)}/restore`, { method: 'POST', body }),
    getJob: (id) => http.request<DatabaseJob>(`/databases/jobs/${encodeURIComponent(id)}`),
    listJobs: (q = {}) => http.request<ListResult<DatabaseJob>>('/databases/jobs', { query: q }),
    deleteBackup: (id) =>
      http.request<{ deleted: true }>(`/databases/backups/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    backupDownloadUrl: (id) =>
      `/databases/backups/${encodeURIComponent(id)}/download`,
  };
}

export function listProfiles(
  q: PageQuery & { kind?: 'postgres' | 'redis'; q?: string } = {},
): Promise<ListResult<DatabaseProfile>> {
  return currentClient().databases.list(q);
}

export function createProfile(input: DatabaseProfileCreateInput): Promise<DatabaseProfile> {
  return currentClient().databases.create(input);
}

export function getProfile(id: string): Promise<DatabaseProfile> {
  return currentClient().databases.get(id);
}

export function updateProfile(
  id: string,
  input: DatabaseProfileUpdateInput,
): Promise<DatabaseProfile> {
  return currentClient().databases.update(id, input);
}

export function deleteProfile(id: string): Promise<{ deleted: true }> {
  return currentClient().databases.delete(id);
}

export function testProfile(id: string): Promise<DatabaseTestResult> {
  return currentClient().databases.test(id);
}

export function getProfileStats(id: string): Promise<DatabaseStats> {
  return currentClient().databases.stats(id);
}

export function createHandoff(id: string, ttlSec?: number): Promise<HandoffTicket> {
  return currentClient().databases.handoff(id, ttlSec);
}

export function listBackups(
  profileId: string,
  q: PageQuery = {},
): Promise<ListResult<BackupRecord>> {
  return currentClient().databases.listBackups(profileId, q);
}

export function createBackup(
  id: string,
  body: BackupRequestInput,
): Promise<{ job: DatabaseJob }> {
  return currentClient().databases.createBackup(id, body);
}

export function restoreBackup(
  id: string,
  body: RestoreRequestInput,
): Promise<{ job: DatabaseJob }> {
  return currentClient().databases.restore(id, body);
}

export function getJob(id: string): Promise<DatabaseJob> {
  return currentClient().databases.getJob(id);
}

export function listJobs(
  q: PageQuery & { profileId?: string; status?: string } = {},
): Promise<ListResult<DatabaseJob>> {
  return currentClient().databases.listJobs(q);
}

export function deleteBackup(id: string): Promise<{ deleted: true }> {
  return currentClient().databases.deleteBackup(id);
}

/** 特性基路径下的相对下载路径；配合 lib/download.ts 的 downloadRaw 使用。 */
export function backupDownloadUrl(id: string): string {
  return currentClient().databases.backupDownloadUrl(id);
}
