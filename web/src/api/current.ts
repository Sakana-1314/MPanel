import type { ApiClient } from './client';
import { AppError } from './errors';

let supplier: (() => ApiClient) | null = null;

/** client.ts 在模块初始化时注册；资源模块通过 currentClient() 走“当前连接”。 */
export function setCurrentClientSupplier(fn: () => ApiClient): void {
  supplier = fn;
}

export function currentClient(): ApiClient {
  if (supplier === null) {
    throw new AppError('INTERNAL', 'API 客户端尚未初始化', 0, {
      hint: '这是前端初始化顺序问题，请刷新页面；若持续出现请反馈。',
    });
  }
  return supplier();
}
