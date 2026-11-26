import { computed, reactive } from 'vue';
import type { BackendConnection } from '../api/types';

const PERSIST_KEY = 'mpanel.core-connections.v1';
const LEGACY_KEY = 'mpanel.connections.v1';

interface PersistedState {
  connections: BackendConnection[];
  activeId: string | null;
}

interface ConnectionState {
  connections: BackendConnection[];
  activeId: string | null;
}

/** 编译期/config.json 种子提供的 core token，只存在内存中。 */
const memoryTokens = new Map<string, string>();

function loadPersisted(): PersistedState {
  const empty: PersistedState = { connections: [], activeId: null };
  if (typeof localStorage === 'undefined') return empty;
  const raw = localStorage.getItem(PERSIST_KEY) ?? localStorage.getItem(LEGACY_KEY);
  if (raw === null) return empty;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return empty;
    const value = parsed as Record<string, unknown>;
    const entries = Array.isArray(value.connections) ? value.connections : [];
    const connections: BackendConnection[] = [];
    for (const item of entries) {
      if (typeof item !== 'object' || item === null) continue;
      const entry = item as Record<string, unknown>;
      // 旧版本可能保存过 worker 直连连接；前端已不再支持，直接丢弃。
      if (entry.kind !== undefined && entry.kind !== 'core') continue;
      const rawUrl = typeof entry.baseUrl === 'string' ? entry.baseUrl : entry.url;
      const name = typeof entry.name === 'string' ? entry.name : entry.label;
      if (typeof rawUrl !== 'string' || typeof name !== 'string') continue;
      const normalized = normalizeBaseUrl(rawUrl);
      if (normalized.length === 0) continue;
      connections.push({
        id: typeof entry.id === 'string' ? entry.id : makeConnectionId(),
        name,
        baseUrl: normalized,
        username: typeof entry.username === 'string' ? entry.username : undefined,
        createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : undefined,
        lastUsedAt: typeof entry.lastUsedAt === 'string' ? entry.lastUsedAt : undefined,
      });
    }
    return {
      connections,
      activeId:
        typeof value.activeId === 'string' && connections.some((item) => item.id === value.activeId)
          ? value.activeId
          : (connections[0]?.id ?? null),
    };
  } catch {
    return empty;
  }
}

const state = reactive<ConnectionState>(loadPersisted());

function persist(): void {
  if (typeof localStorage === 'undefined') return;
  const payload: PersistedState = {
    connections: state.connections.map(({ token: _token, ...rest }) => rest),
    activeId: state.activeId,
  };
  try {
    localStorage.setItem(PERSIST_KEY, JSON.stringify(payload));
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    // 隐私模式/配额不足时静默失败。
  }
}

export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim();
  if (url.length === 0) return '';
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  url = url.replace(/\/+$/, '');
  // 用户常把完整 API 地址粘进来；连接只保存服务根地址。
  url = url.replace(/\/api\/v1$/i, '');
  url = url.replace(/\/machines\/[^/]+\/proxy$/i, '');
  return url;
}

export function makeConnectionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `conn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function listConnections(): BackendConnection[] {
  return state.connections;
}

export function getConnectionById(id: string | null | undefined): BackendConnection | undefined {
  if (id === null || id === undefined) return undefined;
  return state.connections.find((connection) => connection.id === id);
}

/** 在内存中合并 token；持久化对象永远不含 token。 */
export function getActiveConnection(): BackendConnection | undefined {
  const connection = state.connections.find((item) => item.id === state.activeId);
  if (connection === undefined) return undefined;
  const token = memoryTokens.get(connection.id);
  return token === undefined ? connection : { ...connection, token };
}

export const activeConnection = computed<BackendConnection | undefined>(() => getActiveConnection());
export const activeConnectionId = computed<string | null>(() => state.activeId);

export function setConnectionToken(id: string, token: string | undefined): void {
  if (token === undefined || token.length === 0) memoryTokens.delete(id);
  else memoryTokens.set(id, token);
}

export function addConnection(input: {
  id?: string;
  name: string;
  baseUrl: string;
  username?: string;
  token?: string;
}): BackendConnection {
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  if (baseUrl.length === 0) throw new Error('服务器地址不能为空');
  const id = input.id ?? makeConnectionId();
  const connection: BackendConnection = {
    id,
    name: input.name.trim().length > 0 ? input.name.trim() : baseUrl,
    baseUrl,
    username: input.username,
    createdAt: new Date().toISOString(),
  };
  const existingIndex = state.connections.findIndex((item) => item.id === id);
  if (existingIndex >= 0) state.connections.splice(existingIndex, 1, connection);
  else state.connections.push(connection);
  if (input.token !== undefined) setConnectionToken(id, input.token);
  if (state.activeId === null) state.activeId = id;
  persist();
  return connection;
}

export function updateConnection(
  id: string,
  patch: Partial<Pick<BackendConnection, 'name' | 'baseUrl' | 'username' | 'token'>>,
): void {
  const index = state.connections.findIndex((item) => item.id === id);
  if (index < 0) return;
  const current = state.connections[index]!;
  const next: BackendConnection = {
    ...current,
    name: patch.name !== undefined ? patch.name.trim() || current.name : current.name,
    baseUrl: patch.baseUrl !== undefined ? normalizeBaseUrl(patch.baseUrl) : current.baseUrl,
    username: patch.username !== undefined ? patch.username : current.username,
  };
  if (patch.token !== undefined) setConnectionToken(id, patch.token);
  state.connections.splice(index, 1, next);
  persist();
}

export function removeConnection(id: string): void {
  const index = state.connections.findIndex((item) => item.id === id);
  if (index < 0) return;
  state.connections.splice(index, 1);
  memoryTokens.delete(id);
  if (state.activeId === id) state.activeId = state.connections[0]?.id ?? null;
  persist();
}

export function setActiveConnection(id: string): void {
  if (!state.connections.some((connection) => connection.id === id)) return;
  if (state.activeId === id) return;
  state.activeId = id;
  persist();
}

/** 成功登录后把服务器移到记录顶部，作为“最近登录”排序。 */
export function touchConnection(id: string): void {
  const index = state.connections.findIndex((connection) => connection.id === id);
  if (index < 0) return;
  const [connection] = state.connections.splice(index, 1);
  if (connection === undefined) return;
  connection.lastUsedAt = new Date().toISOString();
  state.connections.unshift(connection);
  persist();
}

export function renameConnection(id: string, name: string): void {
  updateConnection(id, { name });
}
