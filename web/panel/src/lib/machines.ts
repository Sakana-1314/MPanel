import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import type { MaybeRefOrGetter } from 'vue';
import { toValue } from 'vue';
import { useCoreApi, useMachineApi } from './api';
import { coreKey, machineKey } from './query-keys';
import { sessionSnapshot } from './session';

/** 登录后才启用的查询条件。 */
export function authenticated() {
  return computed(() => sessionSnapshot().status === 'authenticated');
}

/** core 机器列表（200 上限）；多个页面共享同一 query key。 */
export function useMachinesQuery() {
  const api = useCoreApi();
  return useQuery({
    queryKey: coreKey('machines', 'list', { limit: 200 }),
    queryFn: () => api.value.machines.list({ limit: 200 }),
    enabled: authenticated(),
    staleTime: 10_000,
  });
}

export function useMachineQuery(machineId: MaybeRefOrGetter<string>) {
  const api = useCoreApi();
  return useQuery({
    queryKey: computed(() => coreKey('machines', 'detail', toValue(machineId))),
    queryFn: () => api.value.machines.get(toValue(machineId)),
    enabled: computed(() => authenticated().value && toValue(machineId).length > 0),
    staleTime: 10_000,
  });
}

export function useSystemOverviewQuery() {
  const api = useCoreApi();
  return useQuery({
    queryKey: coreKey('system', 'overview'),
    queryFn: () => api.value.system.overview(),
    enabled: authenticated(),
    staleTime: 10_000,
  });
}

/** 目标机器的 /system/info（经 core 代理），用于能力与平台信息。 */
export function useMachineInfoQuery(machineId: MaybeRefOrGetter<string>) {
  const api = useMachineApi(machineId);
  return useQuery({
    queryKey: computed(() => machineKey(toValue(machineId), 'system', 'info')),
    queryFn: () => api.value.system.info(),
    enabled: computed(() => authenticated().value && toValue(machineId).length > 0),
    staleTime: 30_000,
    retry: 0,
  });
}

/** 目标机器的实时指标（经 core 代理）。 */
export function useMachineMetricsQuery(
  machineId: MaybeRefOrGetter<string>,
  options: { refetchInterval?: number | false; enabled?: () => boolean } = {},
) {
  const api = useMachineApi(machineId);
  return useQuery({
    queryKey: computed(() => machineKey(toValue(machineId), 'system', 'metrics')),
    queryFn: () => api.value.system.metrics(),
    enabled: computed(
      () =>
        authenticated().value &&
        toValue(machineId).length > 0 &&
        (options.enabled === undefined || options.enabled()),
    ),
    staleTime: 5_000,
    refetchInterval: options.refetchInterval ?? false,
    retry: 0,
  });
}
