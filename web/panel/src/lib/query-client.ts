import { QueryClient } from '@tanstack/vue-query';

/** 全局查询缓存；连接切换时由 App 清理，避免跨 core 污染。 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 5_000,
    },
    mutations: {
      retry: 0,
    },
  },
});
