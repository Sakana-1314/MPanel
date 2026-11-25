import type {
  ListResult,
  Machine,
  MachineCreateInput,
  MachineCreateResult,
  MachineHealth,
  MachineTestResult,
  MachineUpdateInput,
  PageQuery,
} from './types';
import type { ApiTransport } from './transport';
import { currentClient } from './current';
import { scopedKey } from '../lib/query-keys';

export const machinesKeys = {
  list: (params?: object) => scopedKey('machines', 'list', params ?? {}),
  detail: (id: string) => scopedKey('machines', 'detail', id),
  health: (id: string) => scopedKey('machines', 'health', id),
};

export interface MachineListQuery extends PageQuery {
  status?: string;
  transport?: string;
  q?: string;
}

export interface MachinesApi {
  list(q?: MachineListQuery): Promise<ListResult<Machine>>;
  create(input: MachineCreateInput): Promise<MachineCreateResult>;
  get(id: string): Promise<Machine>;
  update(id: string, input: MachineUpdateInput): Promise<Machine>;
  delete(id: string): Promise<{ deleted: true }>;
  connect(id: string): Promise<Machine>;
  disconnect(id: string): Promise<Machine>;
  test(id: string): Promise<MachineTestResult>;
  health(id: string): Promise<MachineHealth>;
  rotateSecret(id: string): Promise<{ secret: string; workerEnv: Record<string, string> }>;
}

/** 机器管理只存在于 core，且必须走根 /api/v1（代理前缀下没有 /machines）。 */
export function createMachinesApi(http: ApiTransport): MachinesApi {
  const base = (id: string): string => `/machines/${encodeURIComponent(id)}`;
  return {
    list: (q = {}) => http.requestRoot<ListResult<Machine>>('/machines', { query: q }),
    create: (input) =>
      http.requestRoot<MachineCreateResult>('/machines', { method: 'POST', body: input }),
    get: (id) => http.requestRoot<Machine>(base(id)),
    update: (id, input) =>
      http.requestRoot<Machine>(base(id), { method: 'PATCH', body: input }),
    delete: (id) => http.requestRoot<{ deleted: true }>(base(id), { method: 'DELETE' }),
    connect: (id) => http.requestRoot<Machine>(`${base(id)}/connect`, { method: 'POST', body: {} }),
    disconnect: (id) =>
      http.requestRoot<Machine>(`${base(id)}/disconnect`, { method: 'POST', body: {} }),
    test: (id) => http.requestRoot<MachineTestResult>(`${base(id)}/test`, { method: 'POST', body: {} }),
    health: (id) => http.requestRoot<MachineHealth>(`${base(id)}/health`),
    rotateSecret: (id) =>
      http.requestRoot<{ secret: string; workerEnv: Record<string, string> }>(
        `${base(id)}/secret/rotate`,
        { method: 'POST', body: {} },
      ),
  };
}

export function listMachines(q: MachineListQuery = {}): Promise<ListResult<Machine>> {
  return currentClient().machines.list(q);
}

export function createMachine(input: MachineCreateInput): Promise<MachineCreateResult> {
  return currentClient().machines.create(input);
}

export function getMachine(id: string): Promise<Machine> {
  return currentClient().machines.get(id);
}

export function updateMachine(id: string, input: MachineUpdateInput): Promise<Machine> {
  return currentClient().machines.update(id, input);
}

export function deleteMachine(id: string): Promise<{ deleted: true }> {
  return currentClient().machines.delete(id);
}

export function connectMachine(id: string): Promise<Machine> {
  return currentClient().machines.connect(id);
}

export function disconnectMachine(id: string): Promise<Machine> {
  return currentClient().machines.disconnect(id);
}

export function testMachine(id: string): Promise<MachineTestResult> {
  return currentClient().machines.test(id);
}

export function getMachineHealth(id: string): Promise<MachineHealth> {
  return currentClient().machines.health(id);
}

export function rotateMachineSecret(
  id: string,
): Promise<{ secret: string; workerEnv: Record<string, string> }> {
  return currentClient().machines.rotateSecret(id);
}
