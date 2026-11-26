import type {
  ContainerActionInput,
  ContainerCreated,
  ContainerCreateInput,
  ContainerDaemonConfig,
  ContainerDetail,
  ContainerLogsQuery,
  ContainerNetwork,
  ContainerNetworkCreateInput,
  ContainerNetworkDetail,
  ContainerStats,
  ContainerSummary,
  ExecRequest,
  ExecResult,
  ImagePruneRequest,
  ImageSummary,
  JobStarted,
  ListResult,
  PageQuery,
  StackActionInput,
  StackCreateInput,
  StackDetail,
  StackSummary,
  StackUpdateInput,
} from './types';
import type { ApiTransport } from './transport';
import { currentClient } from './current';
import { scopedKey } from '../lib/query-keys';

export type ContainerAction = 'start' | 'stop' | 'restart';

export const containersKeys = {
  list: (params?: object) => scopedKey('containers', 'list', params ?? {}),
  create: () => scopedKey('containers', 'create'),
  detail: (id: string) => scopedKey('containers', 'detail', id),
  stats: (id: string) => scopedKey('containers', 'stats', id),
  images: (params?: object) => scopedKey('images', 'list', params ?? {}),
  stacks: () => scopedKey('stacks', 'list'),
  stack: (name: string) => scopedKey('stacks', 'detail', name),
};

export interface ContainersApi {
  list(q?: PageQuery & { all?: boolean; status?: string; q?: string }): Promise<ListResult<ContainerSummary>>;
  create(input: ContainerCreateInput): Promise<ContainerCreated>;
  createAsync(input: ContainerCreateInput): Promise<JobStarted>;
  get(id: string): Promise<ContainerDetail>;
  action(
    id: string,
    action: ContainerAction,
    opts?: ContainerActionInput,
  ): Promise<{ ok: true; action: ContainerAction; id: string }>;
  remove(
    id: string,
    opts: { force?: boolean; removeVolumes?: boolean },
  ): Promise<{ removed: true; id: string }>;
  logs(id: string, q?: ContainerLogsQuery): Promise<{ logs: string; truncated: boolean }>;
  stats(id: string): Promise<{ stats: ContainerStats }>;
  exec(id: string, req: ExecRequest): Promise<ExecResult>;
  listNetworks(q?: PageQuery): Promise<ListResult<ContainerNetwork>>;
  getNetwork(name: string): Promise<ContainerNetworkDetail>;
  createNetwork(input: ContainerNetworkCreateInput): Promise<ContainerNetworkDetail>;
  removeNetwork(name: string): Promise<{ deleted: true; name: string }>;
  getConfig(): Promise<ContainerDaemonConfig>;
  updateConfig(daemonJson: string): Promise<ContainerDaemonConfig>;
}

export interface ImagesApi {
  list(q?: PageQuery & { all?: boolean; dangling?: boolean; q?: string }): Promise<ListResult<ImageSummary>>;
  pull(reference: string): Promise<{ image: ImageSummary }>;
  pullAsync(reference: string): Promise<JobStarted>;
  remove(id: string, force?: boolean): Promise<{ deleted: true; id: string }>;
  prune(body: ImagePruneRequest): Promise<{ deleted: number; reclaimedBytes: number }>;
}

export interface StacksApi {
  list(q?: PageQuery): Promise<ListResult<StackSummary>>;
  get(name: string): Promise<StackDetail>;
  create(input: StackCreateInput): Promise<StackDetail>;
  update(name: string, input: StackUpdateInput): Promise<StackDetail>;
  action(
    name: string,
    action: 'up' | 'down' | 'restart',
    body: StackActionInput,
  ): Promise<{ ok: true; output: string }>;
  actionAsync(
    name: string,
    action: 'up' | 'down' | 'restart' | 'pull',
    body: StackActionInput,
  ): Promise<JobStarted>;
  delete(name: string, force?: boolean): Promise<{ deleted: true; name: string }>;
}

export function createContainersApi(http: ApiTransport): ContainersApi {
  const base = (id: string): string => `/containers/${encodeURIComponent(id)}`;
  return {
    list: (q = {}) => http.request<ListResult<ContainerSummary>>('/containers', { query: q }),
    create: (input) =>
      http.request<ContainerCreated>('/containers', { method: 'POST', body: input }),
    createAsync: (input) =>
      http.request<JobStarted>('/containers', {
        method: 'POST',
        body: input,
        headers: { prefer: 'respond-async' },
      }),
    get: (id) => http.request<ContainerDetail>(base(id)),
    action: (id, action, opts = {}) =>
      http.request<{ ok: true; action: ContainerAction; id: string }>(`${base(id)}/${action}`, {
        method: 'POST',
        body: opts,
      }),
    remove: (id, opts) =>
      http.request<{ removed: true; id: string }>(base(id), { method: 'DELETE', query: opts }),
    logs: (id, q = {}) =>
      http.request<{ logs: string; truncated: boolean }>(`${base(id)}/logs`, { query: q }),
    stats: (id) => http.request<{ stats: ContainerStats }>(`${base(id)}/stats`),
    exec: (id, req) => http.request<ExecResult>(`${base(id)}/exec`, { method: 'POST', body: req }),
    listNetworks: (q = {}) =>
      http.request<ListResult<ContainerNetwork>>('/containers/networks', { query: q }),
    getNetwork: (name) =>
      http.request<ContainerNetworkDetail>(
        `/containers/networks/${encodeURIComponent(name)}/inspect`,
      ),
    createNetwork: (input) =>
      http.request<ContainerNetworkDetail>('/containers/networks', {
        method: 'POST',
        body: input,
      }),
    removeNetwork: (name) =>
      http.request<{ deleted: true; name: string }>(
        `/containers/networks/${encodeURIComponent(name)}`,
        { method: 'DELETE' },
      ),
    getConfig: () => http.request<ContainerDaemonConfig>('/containers/config'),
    updateConfig: (daemonJson) =>
      http.request<ContainerDaemonConfig>('/containers/config', {
        method: 'PUT',
        body: { daemonJson },
      }),
  };
}

export function createImagesApi(http: ApiTransport): ImagesApi {
  return {
    list: (q = {}) => http.request<ListResult<ImageSummary>>('/images', { query: q }),
    pull: (reference) =>
      http.request<{ image: ImageSummary }>('/images/pull', {
        method: 'POST',
        body: { reference },
        timeoutMs: 620_000,
      }),
    pullAsync: (reference) =>
      http.request<JobStarted>('/images/pull', {
        method: 'POST',
        body: { reference },
        headers: { prefer: 'respond-async' },
      }),
    remove: (id, force) =>
      http.request<{ deleted: true; id: string }>(`/images/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        query: force === undefined ? undefined : { force },
      }),
    prune: (body) =>
      http.request<{ deleted: number; reclaimedBytes: number }>('/images/prune', {
        method: 'POST',
        body,
      }),
  };
}

export function createStacksApi(http: ApiTransport): StacksApi {
  const base = (name: string): string => `/stacks/${encodeURIComponent(name)}`;
  return {
    list: (q = {}) => http.request<ListResult<StackSummary>>('/stacks', { query: q }),
    get: (name) => http.request<StackDetail>(base(name)),
    create: (input) => http.request<StackDetail>('/stacks', { method: 'POST', body: input }),
    update: (name, input) =>
      http.request<StackDetail>(base(name), { method: 'PUT', body: input }),
    action: (name, action, body) =>
      http.request<{ ok: true; output: string }>(`${base(name)}/${action}`, {
        method: 'POST',
        body,
        // 首次 up 可能要拉镜像，与 agent 的 620s 超时保持一致。
        timeoutMs: action === 'up' ? 620_000 : undefined,
      }),
    actionAsync: (name, action, body) =>
      http.request<JobStarted>(`${base(name)}/${action}`, {
        method: 'POST',
        body,
        headers: { prefer: 'respond-async' },
      }),
    delete: (name, force) =>
      http.request<{ deleted: true; name: string }>(base(name), {
        method: 'DELETE',
        query: force === undefined ? undefined : { force },
      }),
  };
}

export function listContainers(
  q: PageQuery & { all?: boolean; status?: string; q?: string } = {},
): Promise<ListResult<ContainerSummary>> {
  return currentClient().containers.list(q);
}

export function getContainer(id: string): Promise<ContainerDetail> {
  return currentClient().containers.get(id);
}

export function containerAction(
  id: string,
  action: ContainerAction,
  opts: ContainerActionInput = {},
): Promise<{ ok: true; action: ContainerAction; id: string }> {
  return currentClient().containers.action(id, action, opts);
}

export function removeContainer(
  id: string,
  opts: { force?: boolean; removeVolumes?: boolean },
): Promise<{ removed: true; id: string }> {
  return currentClient().containers.remove(id, opts);
}

export function getContainerLogs(
  id: string,
  q: ContainerLogsQuery = {},
): Promise<{ logs: string; truncated: boolean }> {
  return currentClient().containers.logs(id, q);
}

export function getContainerStats(id: string): Promise<{ stats: ContainerStats }> {
  return currentClient().containers.stats(id);
}

export function execContainer(id: string, req: ExecRequest): Promise<ExecResult> {
  return currentClient().containers.exec(id, req);
}

export function listImages(
  q: PageQuery & { all?: boolean; dangling?: boolean; q?: string } = {},
): Promise<ListResult<ImageSummary>> {
  return currentClient().images.list(q);
}

export function pullImage(reference: string): Promise<{ image: ImageSummary }> {
  return currentClient().images.pull(reference);
}

export function removeImage(id: string, force?: boolean): Promise<{ deleted: true; id: string }> {
  return currentClient().images.remove(id, force);
}

export function pruneImages(
  body: ImagePruneRequest,
): Promise<{ deleted: number; reclaimedBytes: number }> {
  return currentClient().images.prune(body);
}

export function listStacks(q: PageQuery = {}): Promise<ListResult<StackSummary>> {
  return currentClient().stacks.list(q);
}

export function getStack(name: string): Promise<StackDetail> {
  return currentClient().stacks.get(name);
}

export function createStack(input: StackCreateInput): Promise<StackDetail> {
  return currentClient().stacks.create(input);
}

export function updateStack(name: string, input: StackUpdateInput): Promise<StackDetail> {
  return currentClient().stacks.update(name, input);
}

export function stackAction(
  name: string,
  action: 'up' | 'down' | 'restart',
  body: StackActionInput,
): Promise<{ ok: true; output: string }> {
  return currentClient().stacks.action(name, action, body);
}

export function deleteStack(
  name: string,
  force?: boolean,
): Promise<{ deleted: true; name: string }> {
  return currentClient().stacks.delete(name, force);
}
