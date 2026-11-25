<script setup lang="ts">
import { computed } from 'vue';
import { NAlert, NButton, NDropdown, NIcon, NSpin, NTag, NTooltip } from 'naive-ui';
import {
  ChevronDownOutline,
  OpenOutline,
  PlayOutline,
  RefreshOutline,
} from '@vicons/ionicons5';
import type { Capabilities, Machine } from '@/api/types';
import { useAction } from '@/composables/use-action';
import { useCoreApi } from '@/lib/api';
import { useMachineQuery } from '@/lib/machines';
import { coreKey } from '@/lib/query-keys';
import { MACHINE_AREAS, openMachineDetail, openMachinePage } from '@/lib/navigation';
import { machineStatusType } from '@/lib/status';
import MachineStatusTag from './common/MachineStatusTag.vue';
import RelativeTime from './common/RelativeTime.vue';

const props = defineProps<{ machineId: string }>();

const coreApi = useCoreApi();
const machineQuery = useMachineQuery(() => props.machineId);
const machine = computed<Machine | undefined>(() => machineQuery.data.value);

const capabilities = computed<Array<{ key: keyof Capabilities; label: string; available: boolean; reason?: string }>>(() => {
  const caps = machine.value?.capabilities;
  if (caps === null || caps === undefined) return [];
  const labels: Record<keyof Capabilities, string> = {
    caddy: 'Caddy',
    docker: 'Docker',
    postgres: 'PostgreSQL',
    redis: 'Redis',
    pty: 'PTY',
  };
  return (Object.keys(labels) as Array<keyof Capabilities>).map((key) => ({
    key,
    label: labels[key],
    available: caps[key].available,
    reason: caps[key].reason,
  }));
});

const connectAction = useAction(
  () => coreApi.value.machines.connect(props.machineId),
  {
    success: '已请求连接机器',
    invalidate: [coreKey('machines', 'list', { limit: 200 }), coreKey('machines', 'detail', props.machineId)],
  },
);

const pageOptions = MACHINE_AREAS.map((item) => ({ label: item.title, key: item.area }));

function onPageSelect(area: string): void {
  openMachinePage(props.machineId, area, { forceNew: true });
}
</script>

<template>
  <div class="machine-bar">
    <n-spin v-if="machineQuery.isLoading.value" size="small" />
    <template v-else-if="machine">
      <div class="identity">
        <span class="machine-name truncate">{{ machine.name }}</span>
        <MachineStatusTag :status="machine.status" />
        <span class="tiny muted">{{ machine.transport }}</span>
        <span class="tiny muted">心跳 <RelativeTime :value="machine.lastSeenAt" /></span>
        <span v-if="machine.worker" class="tiny muted">
          agent v{{ machine.worker.version }} · {{ machine.worker.platform }}/{{ machine.worker.arch }}
        </span>
      </div>

      <div class="caps">
        <n-tooltip v-for="cap in capabilities" :key="cap.key">
          <template #trigger>
            <n-tag
              size="tiny"
              round
              :bordered="false"
              :type="cap.available ? 'success' : 'default'"
            >
              {{ cap.label }}
            </n-tag>
          </template>
          {{ cap.available ? `${cap.label} 可用` : (cap.reason ?? `${cap.label} 不可用`) }}
        </n-tooltip>
      </div>

      <div class="actions">
        <n-button
          v-if="machine.status !== 'online'"
          size="tiny"
          secondary
          type="primary"
          :loading="connectAction.pending.value"
          @click="connectAction.run()"
        >
          <template #icon><n-icon :component="PlayOutline" /></template>
          连接
        </n-button>
        <n-button size="tiny" quaternary :loading="machineQuery.isFetching.value" @click="machineQuery.refetch()">
          <template #icon><n-icon :component="RefreshOutline" /></template>
        </n-button>
        <n-dropdown trigger="click" :options="pageOptions" @select="onPageSelect">
          <n-button size="tiny" quaternary>
            新开页面
            <template #icon><n-icon :component="ChevronDownOutline" /></template>
          </n-button>
        </n-dropdown>
        <n-button size="tiny" quaternary @click="openMachineDetail(machine.id)">
          <template #icon><n-icon :component="OpenOutline" /></template>
          详情
        </n-button>
      </div>
    </template>
  </div>

  <n-alert
    v-if="machine && machine.status !== 'online'"
    type="warning"
    :bordered="false"
    style="margin: 0 16px 8px"
    :title="`机器当前为“${machine.status}”`"
  >
    页面请求经 core 代理发往该机器，离线时可能失败。
    <span v-if="machine.lastError" class="tiny muted">最近错误：{{ machine.lastError }}</span>
  </n-alert>
</template>

<style scoped>
.machine-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  border-bottom: 1px dashed var(--mpanel-border);
  font-size: 12px;
  min-height: 38px;
}
.identity,
.caps,
.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.identity {
  min-width: 0;
  flex: 1 1 420px;
}
.machine-name {
  font-weight: 650;
  max-width: 220px;
}
</style>
