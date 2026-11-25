import { useCallback } from 'react';
import { useIsFetching, useQueryClient } from '@tanstack/react-query';

/** 顶栏“刷新”：失效并重新获取当前连接下的全部查询。 */
export function useRefresh(): { refresh(): void; busy: boolean } {
  const queryClient = useQueryClient();
  const busy = useIsFetching() > 0;
  const refresh = useCallback(() => {
    void queryClient.invalidateQueries();
  }, [queryClient]);
  return { refresh, busy };
}
