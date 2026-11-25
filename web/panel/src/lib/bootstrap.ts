import type { RuntimeConfig } from '../api/types';
import {
  addConnection,
  getConnectionById,
  listConnections,
  setActiveConnection,
  setConnectionToken,
} from './connection-store';
import { getRuntimeConfig } from './runtime-config';

/**
 * 启动时把编译期 / config.json 的默认 core 写入连接 store。
 * 已存在的连接不覆盖（保留用户重命名与当前选择），env 提供的 token 只在内存中补充。
 */
export function bootstrapConnections(config: RuntimeConfig = getRuntimeConfig()): void {
  const seeds = config.backendSeeds ?? [];
  if (seeds.length === 0) return;

  for (const seed of seeds) {
    if (getConnectionById(seed.id) === undefined) {
      addConnection({
        id: seed.id,
        name: seed.name,
        baseUrl: seed.baseUrl,
        username: seed.username,
        token: seed.token,
      });
    } else if (seed.token !== undefined && seed.token.length > 0) {
      setConnectionToken(seed.id, seed.token);
    }
  }

  if (listConnections().length > 0) {
    const preferred = seeds.find((seed) => getConnectionById(seed.id) !== undefined);
    if (preferred !== undefined) setActiveConnection(preferred.id);
  }
}
