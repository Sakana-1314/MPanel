import { QueryClient } from '@tanstack/react-query';
import { AppError } from '../api/errors';
import { onConnectionChange } from './connection-events';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: (failureCount, error) => {
        // 4xx（凭据/参数/不存在）重试没有意义；网络/5xx 最多重试 1 次。
        if (error instanceof AppError) {
          if (error.code === 'ABORTED') return false;
          if (error.status >= 400 && error.status < 500) return false;
        }
        return failureCount < 1;
      },
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 0,
    },
  },
});

/**
 * 连接/机器变化后清空缓存，避免不同后端的数据串台。
 * token 变化（登录/换 token）只做失效，不销毁仍在进行中的 mutation。
 */
onConnectionChange((reason) => {
  if (reason === 'secret') {
    void queryClient.invalidateQueries();
    return;
  }
  queryClient.clear();
});
