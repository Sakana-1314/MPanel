/**
 * TanStack Query key 规范（多机工作台）：
 * - core 级：`['core', resource, action, ...params]`
 * - 机器级：`['machine', machineId, resource, action, ...params]`
 * 连接切换时会 queryClient.clear()，因此 key 不需要连接 id。
 */
export function coreKey(...parts: unknown[]): readonly unknown[] {
  return ['core', ...parts];
}

export function machineKey(machineId: string, ...parts: unknown[]): readonly unknown[] {
  return ['machine', machineId, ...parts];
}

/** 兼容旧资源模块导出的 key 工厂；新页面请使用 coreKey/machineKey。 */
export function scopedKey(...parts: unknown[]): readonly unknown[] {
  return ['scoped', ...parts];
}
