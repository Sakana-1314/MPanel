import type {
  FileArchiveResult,
  FileChmodRequest,
  FileCopyRequest,
  FileDeleteQuery,
  FileDownloadQuery,
  FileExtractResult,
  FileItem,
  FileListResult,
  FileMkdirRequest,
  FileReadResult,
  FileRenameRequest,
  FileRoot,
  FileSearchQuery,
  FileSearchResult,
  FileWriteRequest,
  ListResult,
  PageQuery,
  TrashEntry,
} from './types';
import type { ApiTransport } from './transport';
import { currentClient } from './current';
import { scopedKey } from '../lib/query-keys';
import { saveBlob } from '../lib/download';

export interface FileListQuery {
  root: string;
  path?: string;
  showHidden?: boolean;
  limit?: number;
  cursor?: string;
}

export interface FileStatQuery {
  root: string;
  path: string;
}

export interface FileReadQuery {
  root: string;
  path: string;
  encoding?: 'utf8' | 'base64';
  maxBytes?: number;
}

export interface FileRestoreTrashRequest {
  trashId: string;
  overwrite?: boolean;
}

export interface FileEmptyTrashRequest {
  trashIds?: string[];
  all?: boolean;
}

export interface FileArchiveRequest {
  root: string;
  paths: string[];
  destination: string;
  format: 'zip' | 'tar' | 'tar.gz';
}

export interface FileExtractRequest {
  root: string;
  path: string;
  destination: string;
  format?: 'zip' | 'tar' | 'tar.gz';
}

export const filesKeys = {
  roots: () => scopedKey('files', 'roots'),
  list: (params: FileListQuery) => scopedKey('files', 'list', params),
  stat: (params: FileStatQuery) => scopedKey('files', 'stat', params),
  trash: (params?: object) => scopedKey('files', 'trash', params ?? {}),
};

export interface FilesApi {
  roots(): Promise<ListResult<FileRoot>>;
  list(q: FileListQuery): Promise<FileListResult>;
  stat(q: FileStatQuery): Promise<FileItem>;
  read(q: FileReadQuery): Promise<FileReadResult>;
  write(req: FileWriteRequest): Promise<FileItem>;
  mkdir(req: FileMkdirRequest): Promise<FileItem>;
  rename(req: FileRenameRequest): Promise<FileItem>;
  copy(req: FileCopyRequest): Promise<FileItem>;
  chmod(req: FileChmodRequest): Promise<FileItem>;
  delete(q: FileDeleteQuery): Promise<{ trashed: boolean; trashId?: string; path: string }>;
  listTrash(q?: PageQuery): Promise<ListResult<TrashEntry>>;
  restoreTrash(req: FileRestoreTrashRequest): Promise<{ restored: true; path: string }>;
  emptyTrash(req: FileEmptyTrashRequest): Promise<{ deleted: number }>;
  upload(root: string, path: string, file: File, overwrite?: boolean): Promise<FileItem>;
  download(q: FileDownloadQuery): Promise<void>;
  archive(req: FileArchiveRequest): Promise<FileArchiveResult>;
  extract(req: FileExtractRequest): Promise<FileExtractResult>;
  search(q: FileSearchQuery): Promise<FileSearchResult>;
}

export function createFilesApi(http: ApiTransport): FilesApi {
  return {
    roots: () => http.request<ListResult<FileRoot>>('/files/roots'),
    list: (q) => http.request<FileListResult>('/files/list', { query: q }),
    stat: (q) => http.request<FileItem>('/files/stat', { query: q }),
    read: (q) => http.request<FileReadResult>('/files/read', { query: q }),
    write: (req) =>
      http.request<FileItem>('/files/write', { method: 'PUT', body: req, timeoutMs: 120_000 }),
    mkdir: (req) => http.request<FileItem>('/files/mkdir', { method: 'POST', body: req }),
    rename: (req) => http.request<FileItem>('/files/rename', { method: 'POST', body: req }),
    copy: (req) => http.request<FileItem>('/files/copy', { method: 'POST', body: req }),
    chmod: (req) => http.request<FileItem>('/files/chmod', { method: 'POST', body: req }),
    delete: (q) =>
      http.request<{ trashed: boolean; trashId?: string; path: string }>('/files', {
        method: 'DELETE',
        query: q,
      }),
    listTrash: (q = {}) => http.request<ListResult<TrashEntry>>('/files/trash', { query: q }),
    restoreTrash: (req) =>
      http.request<{ restored: true; path: string }>('/files/trash/restore', {
        method: 'POST',
        body: req,
      }),
    emptyTrash: (req) =>
      http.request<{ deleted: number }>('/files/trash/empty', { method: 'POST', body: req }),
    upload: (root, path, file, overwrite) => {
      const form = new FormData();
      form.append('file', file);
      return http.request<FileItem>('/files/upload', {
        method: 'POST',
        body: form,
        query: overwrite === undefined ? { root, path } : { root, path, overwrite },
        timeoutMs: 620_000,
      });
    },
    download: async (q) => {
      const response = await http.raw('/files/download', { query: { root: q.root, path: q.path } });
      const blob = await response.blob();
      const name = q.path.split('/').filter((part) => part.length > 0).pop() ?? 'download';
      saveBlob(blob, name);
    },
    archive: (req) =>
      http.request<FileArchiveResult>('/files/archive', {
        method: 'POST',
        body: req,
        timeoutMs: 620_000,
      }),
    extract: (req) =>
      http.request<FileExtractResult>('/files/extract', {
        method: 'POST',
        body: req,
        timeoutMs: 620_000,
      }),
    search: (q) => http.request<FileSearchResult>('/files/search', { query: q }),
  };
}

export function listRoots(): Promise<ListResult<FileRoot>> {
  return currentClient().files.roots();
}

export function listFiles(q: FileListQuery): Promise<FileListResult> {
  return currentClient().files.list(q);
}

export function statFile(q: FileStatQuery): Promise<FileItem> {
  return currentClient().files.stat(q);
}

export function readFile(q: FileReadQuery): Promise<FileReadResult> {
  return currentClient().files.read(q);
}

export function writeFile(req: FileWriteRequest): Promise<FileItem> {
  return currentClient().files.write(req);
}

export function mkdir(req: FileMkdirRequest): Promise<FileItem> {
  return currentClient().files.mkdir(req);
}

export function rename(req: FileRenameRequest): Promise<FileItem> {
  return currentClient().files.rename(req);
}

export function copy(req: FileCopyRequest): Promise<FileItem> {
  return currentClient().files.copy(req);
}

export function chmod(req: FileChmodRequest): Promise<FileItem> {
  return currentClient().files.chmod(req);
}

export function deleteFile(
  q: FileDeleteQuery,
): Promise<{ trashed: boolean; trashId?: string; path: string }> {
  return currentClient().files.delete(q);
}

export function listTrash(q: PageQuery = {}): Promise<ListResult<TrashEntry>> {
  return currentClient().files.listTrash(q);
}

export function restoreTrash(
  req: FileRestoreTrashRequest,
): Promise<{ restored: true; path: string }> {
  return currentClient().files.restoreTrash(req);
}

export function emptyTrash(req: FileEmptyTrashRequest): Promise<{ deleted: number }> {
  return currentClient().files.emptyTrash(req);
}

export function uploadFile(
  root: string,
  path: string,
  file: File,
  overwrite?: boolean,
): Promise<FileItem> {
  return currentClient().files.upload(root, path, file, overwrite);
}

export async function downloadFile(q: FileDownloadQuery): Promise<void> {
  await currentClient().files.download(q);
}

export function archiveFiles(req: FileArchiveRequest): Promise<FileArchiveResult> {
  return currentClient().files.archive(req);
}

export function extractFile(req: FileExtractRequest): Promise<FileExtractResult> {
  return currentClient().files.extract(req);
}

export function searchFiles(q: FileSearchQuery): Promise<FileSearchResult> {
  return currentClient().files.search(q);
}
