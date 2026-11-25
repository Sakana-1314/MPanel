import type { RuntimeConfig } from '../api/types';
import { useConnectionStore } from './connection-store';
import { getSecret, setSecret } from './connection-secrets';
import { getRuntimeConfig } from './runtime-config';

/**
 * 启动时把编译期 / config.json 的默认后端写入连接 store。
 * 已存在的连接不覆盖（保留用户重命名与当前选择），env 提供的 token 只在本地没有时写入。
 */
export function bootstrapConnections(config: RuntimeConfig = getRuntimeConfig()): void {
  const seeds = config.backendSeeds ?? [];
  if (seeds.length === 0) return;

  for (const seed of seeds) {
    const state = useConnectionStore.getState();
    const exists = state.connections.some((connection) => connection.id === seed.id);
    if (!exists) {
      state.add({
        id: seed.id,
        name: seed.name,
        kind: seed.kind,
        baseUrl: seed.baseUrl,
        username: seed.username,
        createdAt: new Date().toISOString(),
      });
    }
    if (seed.token !== undefined && seed.token.length > 0 && getSecret(seed.id) === undefined) {
      setSecret(seed.id, seed.token, 'session');
    }
  }

  const after = useConnectionStore.getState();
  if (after.activeId === null) {
    const preferred = seeds.find((seed) =>
      after.connections.some((connection) => connection.id === seed.id),
    );
    const fallback = after.connections[0];
    const id = preferred?.id ?? fallback?.id;
    if (id !== undefined) after.setActive(id);
  }
}
