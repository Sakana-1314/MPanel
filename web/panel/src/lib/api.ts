import { computed, toValue, type ComputedRef, type MaybeRefOrGetter } from 'vue';
import { getCoreClient, getMachineClient, type ApiClient } from '../api/client';

/** core 级 API（machines / edge / overview / auth），永远走 core 根。 */
export function useCoreApi(): ComputedRef<ApiClient> {
  return computed(() => getCoreClient());
}

/**
 * 机器级 API：显式绑定路由里的 machineId。
 * 多机工作台允许多个标签页同时存在，绝不能使用“全局当前机器”。
 */
export function useMachineApi(machineId: MaybeRefOrGetter<string>): ComputedRef<ApiClient> {
  return computed(() => getMachineClient(toValue(machineId)));
}
