import type { CertificateInfo, CertificateStatus, ListResult, PageQuery } from './types';
import type { ApiTransport } from './transport';
import { currentClient } from './current';
import { scopedKey } from '../lib/query-keys';

export interface CertListQuery extends PageQuery {
  domain?: string;
  status?: CertificateStatus;
  includeExpired?: boolean;
}

export interface CertsApi {
  list(q?: CertListQuery): Promise<ListResult<CertificateInfo>>;
  get(id: string): Promise<CertificateInfo>;
}

export const certsKeys = {
  list: (params?: object) => scopedKey('certs', 'list', params ?? {}),
  detail: (id: string) => scopedKey('certs', 'detail', id),
};

export function createCertsApi(http: ApiTransport): CertsApi {
  return {
    list: (q = {}) => http.request<ListResult<CertificateInfo>>('/certs', { query: q }),
    get: (id) => http.request<CertificateInfo>(`/certs/${encodeURIComponent(id)}`),
  };
}

export function listCerts(q: CertListQuery = {}): Promise<ListResult<CertificateInfo>> {
  return currentClient().certs.list(q);
}

export function getCert(id: string): Promise<CertificateInfo> {
  return currentClient().certs.get(id);
}
