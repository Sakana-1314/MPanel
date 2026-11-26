import type {
  ListResult,
  PageQuery,
  Site,
  SiteApplyResult,
  SiteBootstrapResult,
  SiteConfig,
  SiteExportBundle,
  SiteImportResult,
  SitePreviewResult,
} from './types';
import type { ApiTransport } from './transport';
import { currentClient } from './current';
import { scopedKey } from '../lib/query-keys';

export interface SiteCreateInput {
  name: string;
  enabled?: boolean;
  config: SiteConfig;
}

export interface SiteUpdateInput {
  name?: string;
  enabled?: boolean;
  config?: SiteConfig;
}

export interface SitePreviewRequest {
  site?: SiteConfig;
  siteId?: string;
  validate?: boolean;
}

export interface SiteApplyRequest {
  siteIds?: string[];
  force?: boolean;
}

export interface SiteImportRequest {
  bundle: SiteExportBundle;
  mode?: 'merge' | 'replace';
}

export interface SiteListQuery extends PageQuery {
  enabled?: boolean;
  q?: string;
}

export interface SitesApi {
  list(q?: SiteListQuery): Promise<ListResult<Site>>;
  /** 安装 Caddy 容器前准备受管目录与挂载；未部署时唯一可用的站点端点。 */
  bootstrap(): Promise<SiteBootstrapResult>;
  create(input: SiteCreateInput): Promise<Site>;
  get(id: string): Promise<Site>;
  update(id: string, input: SiteUpdateInput): Promise<Site>;
  delete(id: string): Promise<{ deleted: true; pendingApply: boolean }>;
  preview(req: SitePreviewRequest): Promise<SitePreviewResult>;
  apply(req: SiteApplyRequest): Promise<SiteApplyResult>;
  exportBundle(): Promise<SiteExportBundle>;
  importBundle(req: SiteImportRequest): Promise<SiteImportResult>;
}

export const sitesKeys = {
  list: (params?: object) => scopedKey('sites', 'list', params ?? {}),
  detail: (id: string) => scopedKey('sites', 'detail', id),
  preview: (params?: object) => scopedKey('sites', 'preview', params ?? {}),
};

export function createSitesApi(http: ApiTransport): SitesApi {
  const base = (id: string): string => `/sites/${encodeURIComponent(id)}`;
  return {
    list: (q = {}) => http.request<ListResult<Site>>('/sites', { query: q }),
    bootstrap: () => http.request<SiteBootstrapResult>('/sites/bootstrap', { method: 'POST' }),
    create: (input) => http.request<Site>('/sites', { method: 'POST', body: input }),
    get: (id) => http.request<Site>(base(id)),
    update: (id, input) => http.request<Site>(base(id), { method: 'PUT', body: input }),
    delete: (id) =>
      http.request<{ deleted: true; pendingApply: boolean }>(base(id), { method: 'DELETE' }),
    preview: (req) => http.request<SitePreviewResult>('/sites/preview', { method: 'POST', body: req }),
    apply: (req) => http.request<SiteApplyResult>('/sites/apply', { method: 'POST', body: req }),
    exportBundle: () => http.request<SiteExportBundle>('/sites/export'),
    importBundle: (req) =>
      http.request<SiteImportResult>('/sites/import', { method: 'POST', body: req }),
  };
}

export function listSites(q: SiteListQuery = {}): Promise<ListResult<Site>> {
  return currentClient().sites.list(q);
}

export function createSite(input: SiteCreateInput): Promise<Site> {
  return currentClient().sites.create(input);
}

export function getSite(id: string): Promise<Site> {
  return currentClient().sites.get(id);
}

export function updateSite(id: string, input: SiteUpdateInput): Promise<Site> {
  return currentClient().sites.update(id, input);
}

export function deleteSite(id: string): Promise<{ deleted: true; pendingApply: boolean }> {
  return currentClient().sites.delete(id);
}

export function previewSite(req: SitePreviewRequest): Promise<SitePreviewResult> {
  return currentClient().sites.preview(req);
}

export function applySites(req: SiteApplyRequest): Promise<SiteApplyResult> {
  return currentClient().sites.apply(req);
}

export function exportSites(): Promise<SiteExportBundle> {
  return currentClient().sites.exportBundle();
}

export function importSites(req: SiteImportRequest): Promise<SiteImportResult> {
  return currentClient().sites.importBundle(req);
}
