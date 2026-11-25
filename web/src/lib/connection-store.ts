import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { BackendConnection } from '../api/types';
import { clearAuth } from './auth-store';
import { emitConnectionChange } from './connection-events';
import { getSecret, removeSecret } from './connection-secrets';

const PERSIST_KEY = 'mpanel.connections.v1';

export interface ConnectionState {
  connections: BackendConnection[];
  activeId: string | null;
  /** 机器选择按连接保存，不跨连接复用（core 代理）。 */
  selectedMachineByConnection: Record<string, string | undefined>;
  add(connection: BackendConnection): void;
  update(id: string, patch: Partial<Omit<BackendConnection, 'id' | 'token'>>): void;
  remove(id: string): void;
  setActive(id: string): void;
  setDefault(id: string): void;
  rename(id: string, name: string): void;
  selectMachine(connectionId: string, machineId?: string): void;
}

interface PersistedState {
  connections: BackendConnection[];
  activeId: string | null;
  selectedMachineByConnection: Record<string, string | undefined>;
}

/** 只持久化连接元数据；token 永不进入 mpanel.connections.v1。 */
export const useConnectionStore = create<ConnectionState>()(
  persist<ConnectionState, [], [], PersistedState>(
    (set, get) => ({
      connections: [],
      activeId: null,
      selectedMachineByConnection: {},

      add: (connection) => {
        const next = sanitizeConnection(connection);
        const exists = get().connections.some((item) => item.id === next.id);
        if (exists) {
          get().update(next.id, next);
          return;
        }
        set((state) => ({
          connections: [...state.connections, next],
          activeId: state.activeId ?? next.id,
        }));
        emitConnectionChange('update');
      },

      update: (id, patch) => {
        set((state) => ({
          connections: state.connections.map((connection) =>
            connection.id === id
              ? sanitizeConnection({ ...connection, ...patch, id } as BackendConnection)
              : connection,
          ),
        }));
        emitConnectionChange('update');
      },

      remove: (id) => {
        removeSecret(id);
        clearAuth(id);
        set((state) => {
          const connections = state.connections.filter((connection) => connection.id !== id);
          const selected = { ...state.selectedMachineByConnection };
          delete selected[id];
          return {
            connections,
            selectedMachineByConnection: selected,
            activeId: state.activeId === id ? (connections[0]?.id ?? null) : state.activeId,
          };
        });
        emitConnectionChange('remove');
      },

      setActive: (id) => {
        if (!get().connections.some((connection) => connection.id === id)) return;
        if (get().activeId === id) return;
        set({ activeId: id });
        emitConnectionChange('activate');
      },

      setDefault: (id) => {
        get().setActive(id);
      },

      rename: (id, name) => {
        const trimmed = name.trim();
        if (trimmed.length === 0) return;
        set((state) => ({
          connections: state.connections.map((connection) =>
            connection.id === id ? { ...connection, name: trimmed } : connection,
          ),
        }));
        emitConnectionChange('update');
      },

      selectMachine: (connectionId, machineId) => {
        set((state) => {
          const selected = { ...state.selectedMachineByConnection };
          if (machineId === undefined || machineId.length === 0) delete selected[connectionId];
          else selected[connectionId] = machineId;
          return { selectedMachineByConnection: selected };
        });
        emitConnectionChange('machine');
      },
    }),
    {
      name: PERSIST_KEY,
      version: 2,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        connections: state.connections.map(stripToken),
        activeId: state.activeId,
        selectedMachineByConnection: state.selectedMachineByConnection,
      }),
      migrate: (persisted) => migratePersisted(persisted),
      merge: (persisted, current) => {
        const value = persisted as Partial<PersistedState> | undefined;
        if (value === undefined) return current;
        return {
          ...current,
          connections: (value.connections ?? []).map((item) =>
            sanitizeConnection(stripToken(item as BackendConnection)),
          ),
          activeId: value.activeId ?? null,
          selectedMachineByConnection: value.selectedMachineByConnection ?? {},
        };
      },
    },
  ),
);

/* ------------------------------- helpers ------------------------------- */

export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim();
  if (url.length === 0) return '';
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  url = url.replace(/\/+$/, '');
  // 用户常把完整 API 地址粘进来；去掉统一的 /api/v1 后缀，连接只保存服务根地址。
  url = url.replace(/\/api\/v1$/i, '');
  return url;
}

function sanitizeConnection(connection: BackendConnection): BackendConnection {
  return {
    ...connection,
    name: connection.name.trim(),
    baseUrl: normalizeBaseUrl(connection.baseUrl),
    token: undefined,
  };
}

function stripToken(connection: BackendConnection): BackendConnection {
  const { token: _token, ...rest } = connection;
  return rest;
}

function migratePersisted(raw: unknown): PersistedState {
  const value = (raw ?? {}) as Record<string, unknown>;
  const legacy = Array.isArray(value.connections) ? value.connections : [];
  const connections: BackendConnection[] = [];
  for (const item of legacy) {
    if (typeof item !== 'object' || item === null) continue;
    const entry = item as Record<string, unknown>;
    const urlValue = typeof entry.baseUrl === 'string' ? entry.baseUrl : entry.url;
    const nameValue = typeof entry.name === 'string' ? entry.name : entry.label;
    if (typeof urlValue !== 'string' || typeof nameValue !== 'string') continue;
    const kind = entry.kind === 'core' ? 'core' : 'worker';
    connections.push(
      sanitizeConnection({
        id: typeof entry.id === 'string' ? entry.id : makeConnectionId(),
        name: nameValue,
        kind,
        baseUrl: urlValue,
        createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : undefined,
      }),
    );
  }
  return {
    connections,
    activeId: typeof value.activeId === 'string' ? value.activeId : (connections[0]?.id ?? null),
    selectedMachineByConnection:
      typeof value.selectedMachineByConnection === 'object' &&
      value.selectedMachineByConnection !== null
        ? (value.selectedMachineByConnection as Record<string, string | undefined>)
        : {},
  };
}

export function makeConnectionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `conn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function getConnectionById(id: string | null | undefined): BackendConnection | undefined {
  if (id === null || id === undefined) return undefined;
  return useConnectionStore.getState().connections.find((connection) => connection.id === id);
}

/** 在内存中合并 secret；连接对象本身永远不含 token。 */
export function getActiveConnection(): BackendConnection | undefined {
  const state = useConnectionStore.getState();
  const connection = state.connections.find((item) => item.id === state.activeId);
  if (connection === undefined) return undefined;
  const token = getSecret(connection.id);
  return token === undefined ? connection : { ...connection, token };
}

export function getSelectedMachineId(connectionId?: string): string | undefined {
  const state = useConnectionStore.getState();
  const id = connectionId ?? state.activeId;
  if (id === null) return undefined;
  return state.selectedMachineByConnection[id];
}

/** 页面只使用该 basePath；worker = /api/v1，core 已选机器 = /proxy。 */
export function buildBasePath(
  connection: BackendConnection | undefined,
  machineId: string | undefined,
): string {
  if (connection === undefined) return '';
  const root = normalizeBaseUrl(connection.baseUrl);
  if (connection.kind === 'worker') return `${root}/api/v1`;
  if (machineId === undefined || machineId.length === 0) return `${root}/api/v1`;
  return `${root}/api/v1/machines/${encodeURIComponent(machineId)}/proxy`;
}

export function getBasePath(): string {
  const connection = getActiveConnection();
  if (connection === undefined) return '';
  return buildBasePath(connection, getSelectedMachineId(connection.id));
}

export function getWsBasePath(): string {
  const connection = getActiveConnection();
  if (connection === undefined) return '';
  const wsUrl = toWs(connection.baseUrl);
  if (connection.kind === 'worker') return `${wsUrl}/ws`;
  const machineId = getSelectedMachineId(connection.id);
  return machineId === undefined
    ? wsUrl
    : `${wsUrl}/api/v1/machines/${encodeURIComponent(machineId)}/proxy/ws`;
}

function toWs(url: string): string {
  if (url.startsWith('https://')) return `wss://${url.slice('https://'.length)}`;
  if (url.startsWith('http://')) return `ws://${url.slice('http://'.length)}`;
  return url;
}

/* -------------------------------- hooks -------------------------------- */

export function useActiveConnection(): BackendConnection | undefined {
  const connections = useConnectionStore((state) => state.connections);
  const activeId = useConnectionStore((state) => state.activeId);
  const connection = connections.find((item) => item.id === activeId);
  if (connection === undefined) return undefined;
  // 订阅 connections，token 通过 getSecret 读取（其变化由 connection-events 触发重渲染的页面刷新）。
  const token = getSecret(connection.id);
  return token === undefined ? connection : { ...connection, token };
}

export function useSelectedMachineId(): string | undefined {
  const activeId = useConnectionStore((state) => state.activeId);
  return useConnectionStore((state) =>
    activeId === null ? undefined : state.selectedMachineByConnection[activeId],
  );
}

export function useBasePath(): string {
  const connection = useActiveConnection();
  const machineId = useSelectedMachineId();
  return buildBasePath(connection, machineId);
}

export function useIsCore(): boolean {
  return useActiveConnection()?.kind === 'core';
}
