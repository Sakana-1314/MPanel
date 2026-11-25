import type {
  ListResult,
  PageQuery,
  Task,
  TaskCreateInput,
  TaskNextRunsResult,
  TaskRun,
  TaskRunNowResult,
  TaskUpdateInput,
} from './types';
import type { ApiTransport } from './transport';
import { currentClient } from './current';
import { scopedKey } from '../lib/query-keys';

export const tasksKeys = {
  list: (params?: object) => scopedKey('tasks', 'list', params ?? {}),
  detail: (id: string) => scopedKey('tasks', 'detail', id),
  history: (id: string, params?: object) => scopedKey('tasks', 'history', id, params ?? {}),
  runs: (params?: object) => scopedKey('tasks', 'runs', params ?? {}),
  nextRuns: (id: string, count?: number) => scopedKey('tasks', 'next-runs', id, count ?? 5),
};

export interface TasksApi {
  list(q?: PageQuery & { enabled?: boolean; q?: string }): Promise<ListResult<Task>>;
  create(input: TaskCreateInput): Promise<Task>;
  get(id: string): Promise<Task>;
  update(id: string, input: TaskUpdateInput): Promise<Task>;
  delete(id: string): Promise<{ deleted: true; id: string; killedRun?: string }>;
  run(id: string): Promise<TaskRunNowResult>;
  history(id: string, q?: PageQuery & { status?: string }): Promise<ListResult<TaskRun>>;
  runs(q?: PageQuery & { status?: string; taskId?: string }): Promise<ListResult<TaskRun>>;
  nextRuns(id: string, count?: number): Promise<TaskNextRunsResult>;
}

export function createTasksApi(http: ApiTransport): TasksApi {
  const base = (id: string): string => `/tasks/${encodeURIComponent(id)}`;
  return {
    list: (q = {}) => http.request<ListResult<Task>>('/tasks', { query: q }),
    create: (input) => http.request<Task>('/tasks', { method: 'POST', body: input }),
    get: (id) => http.request<Task>(base(id)),
    update: (id, input) => http.request<Task>(base(id), { method: 'PUT', body: input }),
    delete: (id) =>
      http.request<{ deleted: true; id: string; killedRun?: string }>(base(id), {
        method: 'DELETE',
      }),
    run: (id) => http.request<TaskRunNowResult>(`${base(id)}/run`, { method: 'POST', body: {} }),
    history: (id, q = {}) =>
      http.request<ListResult<TaskRun>>(`${base(id)}/history`, { query: q }),
    runs: (q = {}) => http.request<ListResult<TaskRun>>('/tasks/runs', { query: q }),
    nextRuns: (id, count) =>
      http.request<TaskNextRunsResult>(`${base(id)}/next-runs`, {
        query: count === undefined ? undefined : { count },
      }),
  };
}

export function listTasks(
  q: PageQuery & { enabled?: boolean; q?: string } = {},
): Promise<ListResult<Task>> {
  return currentClient().tasks.list(q);
}

export function createTask(input: TaskCreateInput): Promise<Task> {
  return currentClient().tasks.create(input);
}

export function getTask(id: string): Promise<Task> {
  return currentClient().tasks.get(id);
}

export function updateTask(id: string, input: TaskUpdateInput): Promise<Task> {
  return currentClient().tasks.update(id, input);
}

export function deleteTask(
  id: string,
): Promise<{ deleted: true; id: string; killedRun?: string }> {
  return currentClient().tasks.delete(id);
}

export function runTask(id: string): Promise<TaskRunNowResult> {
  return currentClient().tasks.run(id);
}

export function listTaskHistory(
  id: string,
  q: PageQuery & { status?: string } = {},
): Promise<ListResult<TaskRun>> {
  return currentClient().tasks.history(id, q);
}

export function listTaskRuns(
  q: PageQuery & { status?: string; taskId?: string } = {},
): Promise<ListResult<TaskRun>> {
  return currentClient().tasks.runs(q);
}

export function getNextRuns(id: string, count?: number): Promise<TaskNextRunsResult> {
  return currentClient().tasks.nextRuns(id, count);
}
