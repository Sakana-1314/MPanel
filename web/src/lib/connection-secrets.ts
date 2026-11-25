import type { ConnectionSecret } from '../api/types';
import { emitConnectionChange } from './connection-events';

const SESSION_KEY = 'mpanel.secrets.session.v1';
const LOCAL_KEY = 'mpanel.secrets.local.v1';

/**
 * worker token 与连接对象严格分离：
 * - 默认 sessionStorage（关闭标签页即失效）；
 * - localStorage 必须用户显式勾选“记住”，UI 会给出 XSS 风险提示；
 * - 绝不写入 mpanel.connections.v1。
 */
function readMap(key: string): Record<string, string> {
  try {
    const storage = key === LOCAL_KEY ? localStorage : sessionStorage;
    const raw = storage.getItem(key);
    if (raw === null) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return {};
    const result: Record<string, string> = {};
    for (const [entryKey, entryValue] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof entryValue === 'string' && entryValue.length > 0) result[entryKey] = entryValue;
    }
    return result;
  } catch {
    return {};
  }
}

function writeMap(key: string, value: Record<string, string>): void {
  try {
    const storage = key === LOCAL_KEY ? localStorage : sessionStorage;
    if (Object.keys(value).length === 0) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(value));
  } catch {
    // 隐私模式/配额不足时静默失败，token 仍可用当前会话手动重填。
  }
}

export function getSecret(connectionId: string): string | undefined {
  return readMap(SESSION_KEY)[connectionId] ?? readMap(LOCAL_KEY)[connectionId];
}

export function getSecretStorage(connectionId: string): 'session' | 'local' | null {
  if (readMap(LOCAL_KEY)[connectionId] !== undefined) return 'local';
  if (readMap(SESSION_KEY)[connectionId] !== undefined) return 'session';
  return null;
}

/** 默认 sessionStorage；localStorage 需要显式 opt-in。 */
export function setSecret(
  connectionId: string,
  token: string,
  storage: 'session' | 'local' = 'session',
): void {
  const targetKey = storage === 'local' ? LOCAL_KEY : SESSION_KEY;
  const otherKey = storage === 'local' ? SESSION_KEY : LOCAL_KEY;
  if (token.length === 0) {
    removeSecret(connectionId);
    return;
  }
  const map = readMap(targetKey);
  map[connectionId] = token;
  writeMap(targetKey, map);
  const other = readMap(otherKey);
  if (other[connectionId] !== undefined) {
    delete other[connectionId];
    writeMap(otherKey, other);
  }
  emitConnectionChange('secret');
}

export function removeSecret(connectionId: string): void {
  let changed = false;
  for (const key of [SESSION_KEY, LOCAL_KEY]) {
    const map = readMap(key);
    if (map[connectionId] === undefined) continue;
    delete map[connectionId];
    writeMap(key, map);
    changed = true;
  }
  if (changed) emitConnectionChange('secret');
}

export function listSecrets(): ConnectionSecret[] {
  const session = readMap(SESSION_KEY);
  const local = readMap(LOCAL_KEY);
  return [
    ...Object.entries(session).map(([connectionId, token]) => ({
      connectionId,
      token,
      storage: 'session' as const,
    })),
    ...Object.entries(local).map(([connectionId, token]) => ({
      connectionId,
      token,
      storage: 'local' as const,
    })),
  ];
}

/** 兼容旧命名（文件布局约定中称 useConnectionSecrets）。 */
export function useConnectionSecrets(): ConnectionSecret[] {
  return listSecrets();
}
