import { getActiveConnection, getSelectedMachineId } from './connection-store';

/**
 * TanStack Query key 规范：
 * `[connectionId, machineId, resource, action, ...params]`
 * 前两段保证直连 worker、core 不同机器之间的缓存天然隔离；切换连接时
 * queryClient.clear() 会清空全部缓存（见 lib/query-client.ts）。
 */
export type ConnectionScope = readonly [connectionId: string, machineId: string | null];

export function connectionScope(): ConnectionScope {
  const connection = getActiveConnection();
  if (connection === undefined) return ['none', null];
  const machineId = getSelectedMachineId(connection.id);
  return [connection.id, machineId === undefined ? null : machineId];
}

export function scopedKey(...parts: unknown[]): readonly unknown[] {
  return [...connectionScope(), ...parts];
}
