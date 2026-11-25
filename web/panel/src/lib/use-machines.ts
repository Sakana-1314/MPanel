import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import type { ListResult, Machine } from '../api/types';
import { listMachines, machinesKeys } from '../api/machines';
import { useActiveConnection } from './connection-store';
import { useSession } from './use-session';

/** core 连接的机器列表（30s 轮询）；worker 连接不请求。 */
export function useMachines(enabled = true): UseQueryResult<ListResult<Machine>, Error> {
  const connection = useActiveConnection();
  const session = useSession();
  const isCore = connection?.kind === 'core';
  return useQuery<ListResult<Machine>, Error>({
    queryKey: machinesKeys.list({ limit: 200 }),
    queryFn: () => listMachines({ limit: 200 }),
    enabled: enabled && isCore && session.status === 'authenticated',
    staleTime: 15_000,
    refetchInterval: enabled && isCore ? 30_000 : false,
    retry: 1,
  });
}
