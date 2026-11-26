<script setup lang="ts">
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { NProgress } from 'naive-ui';
import type { Machine } from '@/api/types';
import { useMachineApi } from '@/lib/api';
import { machineKey } from '@/lib/query-keys';
import { formatBytes, formatUptime } from '@/lib/format';

const props = defineProps<{ machine: Machine }>();

const api = useMachineApi(() => props.machine.id);

const metricsQuery = useQuery({
  queryKey: computed(() => machineKey(props.machine.id, 'system', 'metrics')),
  queryFn: () => api.value.system.metrics(),
  enabled: computed(() => props.machine.status === 'online'),
  staleTime: 15_000,
  refetchInterval: 25_000,
  retry: 0,
});

const metrics = computed(() => metricsQuery.data.value ?? null);

const memoryPercent = computed(() => {
  const m = metrics.value;
  if (m === null || m.memTotalBytes <= 0) return null;
  return Math.round(((m.memTotalBytes - m.memFreeBytes) / m.memTotalBytes) * 100);
});

const diskPercent = computed(() => {
  const m = metrics.value;
  if (m === null || m.diskTotalBytes === null || m.diskFreeBytes === null) return null;
  if (m.diskTotalBytes <= 0) return null;
  return Math.round(((m.diskTotalBytes - m.diskFreeBytes) / m.diskTotalBytes) * 100);
});

function status(percent: number | null): 'success' | 'warning' | 'error' {
  if (percent === null) return 'success';
  if (percent > 88) return 'error';
  if (percent > 72) return 'warning';
  return 'success';
}

const memoryText = computed(() => {
  const m = metrics.value;
  if (m === null) return '—';
  return `${formatBytes(m.memTotalBytes - m.memFreeBytes)} / ${formatBytes(m.memTotalBytes)}`;
});

const diskText = computed(() => {
  const m = metrics.value;
  if (m === null || m.diskTotalBytes === null) return '—';
  return `${formatBytes(m.diskTotalBytes - (m.diskFreeBytes ?? 0))} / ${formatBytes(m.diskTotalBytes)}`;
});

const cpuPercent = computed(() => metrics.value?.cpuPercent ?? null);
const cpuCount = computed(() => metrics.value?.cpuCount ?? props.machine.snapshot?.cpuCount ?? null);
const uptimeSec = computed(() => metrics.value?.uptimeSec ?? props.machine.snapshot?.uptimeSec ?? null);
</script>

<template>
  <div class="metrics">
    <div class="metric">
      <div class="metric-head">
        <span class="tiny muted">内存</span>
        <span class="tiny muted truncate">{{ memoryText }}</span>
      </div>
      <n-progress
        type="line"
        :percentage="memoryPercent ?? 0"
        :height="6"
        :border-radius="3"
        :show-indicator="false"
        :status="status(memoryPercent)"
      />
    </div>
    <div class="metric">
      <div class="metric-head">
        <span class="tiny muted">磁盘</span>
        <span class="tiny muted truncate">{{ diskText }}</span>
      </div>
      <n-progress
        type="line"
        :percentage="diskPercent ?? 0"
        :height="6"
        :border-radius="3"
        :show-indicator="false"
        :status="status(diskPercent)"
      />
    </div>
    <div class="facts tiny muted">
      <span v-if="cpuPercent !== null">CPU {{ cpuPercent.toFixed(0) }}%</span>
      <span v-if="cpuCount !== null">{{ cpuCount }} 核</span>
      <span v-if="uptimeSec !== null">运行 {{ formatUptime(uptimeSec) }}</span>
      <span v-if="metricsQuery.isError.value" class="dim">指标不可用</span>
    </div>
  </div>
</template>

<style scoped>
.metrics {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.metric {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.metric-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.facts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
}
.dim {
  opacity: 0.7;
}
</style>
