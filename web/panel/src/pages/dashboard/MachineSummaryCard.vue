<script setup lang="ts">
import { computed } from 'vue';
import { NButton, NCard, NIcon, NProgress, NTag, NTooltip } from 'naive-ui';
import {
  CubeOutline,
  FolderOpenOutline,
  GlobeOutline,
  OpenOutline,
  TerminalOutline,
} from '@vicons/ionicons5';
import type { Machine } from '@/api/types';
import { formatBytes, formatUptime, machineAddressLabel, transportLabel } from '@/lib/format';
import { openMachineDetail, openMachinePage } from '@/lib/navigation';
import MachineStatusTag from '@/components/common/MachineStatusTag.vue';
import RelativeTime from '@/components/common/RelativeTime.vue';

const props = defineProps<{ machine: Machine }>();

const snapshot = computed(() => props.machine.snapshot);

const memPercent = computed(() => {
  const item = snapshot.value;
  if (item === null || item.memTotalBytes <= 0) return null;
  return Math.round(((item.memTotalBytes - item.memFreeBytes) / item.memTotalBytes) * 100);
});

const diskPercent = computed(() => {
  const item = snapshot.value;
  if (item === null || item.diskTotalBytes === null || item.diskTotalBytes <= 0) return null;
  if (item.diskFreeBytes === null) return null;
  return Math.round(((item.diskTotalBytes - item.diskFreeBytes) / item.diskTotalBytes) * 100);
});

const capabilities = computed(() => {
  const caps = props.machine.capabilities;
  if (caps === null) return [];
  return [
    { label: 'Caddy', available: caps.caddy.available },
    { label: 'Docker', available: caps.docker.available },
    { label: 'PostgreSQL', available: caps.postgres.available },
    { label: 'Redis', available: caps.redis.available },
    { label: '终端', available: caps.pty.available },
  ];
});

const memoryText = computed(() => {
  const item = snapshot.value;
  if (item === null) return '—';
  return `${formatBytes(item.memTotalBytes - item.memFreeBytes)} / ${formatBytes(item.memTotalBytes)}`;
});

const diskText = computed(() => {
  const item = snapshot.value;
  if (item === null || item.diskTotalBytes === null) return '—';
  const free = item.diskFreeBytes ?? 0;
  return `${formatBytes(item.diskTotalBytes - free)} / ${formatBytes(item.diskTotalBytes)}`;
});
</script>

<template>
  <n-card size="small" class="machine-card" :class="{ offline: machine.status === 'offline' }">
    <div class="head">
      <div class="title-row">
        <span class="name truncate" :title="machine.name">{{ machine.name }}</span>
        <MachineStatusTag :status="machine.status" />
        <n-tag v-if="machine.edge" size="tiny" type="info" round :bordered="false">边缘</n-tag>
        <n-tag v-if="machine.group" size="tiny" round :bordered="false">{{ machine.group }}</n-tag>
      </div>
      <div class="sub tiny muted truncate">
        {{ transportLabel(machine.transport) }} · {{ machineAddressLabel(machine) }}
      </div>
      <div class="sub tiny muted">
        心跳 <RelativeTime :value="machine.lastSeenAt" />
        <span v-if="machine.worker"> · v{{ machine.worker.version }}</span>
        <span v-if="machine.worker"> · {{ machine.worker.platform }}/{{ machine.worker.arch }}</span>
      </div>
    </div>

    <div v-if="snapshot" class="metrics">
      <div class="metric">
        <span class="tiny muted">内存</span>
        <n-progress
          type="line"
          :percentage="memPercent ?? 0"
          :height="6"
          :border-radius="3"
          :show-indicator="false"
          :status="(memPercent ?? 0) > 85 ? 'error' : (memPercent ?? 0) > 70 ? 'warning' : 'success'"
        />
        <span class="tiny muted truncate">{{ memoryText }}</span>
      </div>
      <div class="metric">
        <span class="tiny muted">磁盘</span>
        <n-progress
          type="line"
          :percentage="diskPercent ?? 0"
          :height="6"
          :border-radius="3"
          :show-indicator="false"
          :status="(diskPercent ?? 0) > 85 ? 'error' : (diskPercent ?? 0) > 70 ? 'warning' : 'success'"
        />
        <span class="tiny muted truncate">{{ diskText }}</span>
      </div>
      <div class="meta-grid tiny muted">
        <span>CPU {{ snapshot.cpuCount }} 核</span>
        <span v-if="snapshot.loadavg">负载 {{ snapshot.loadavg.map((v) => v.toFixed(2)).join(' / ') }}</span>
        <span>运行 {{ formatUptime(snapshot.uptimeSec) }}</span>
        <span v-if="snapshot.ips.length > 0" class="truncate" :title="snapshot.ips.join(', ')">
          IP {{ snapshot.ips[0] }}
        </span>
      </div>
    </div>

    <div v-if="capabilities.length > 0" class="caps">
      <n-tooltip v-for="cap in capabilities" :key="cap.label">
        <template #trigger>
          <n-tag size="tiny" round :bordered="false" :type="cap.available ? 'success' : 'default'">
            {{ cap.label }}
          </n-tag>
        </template>
        {{ cap.available ? `${cap.label} 可用` : `${cap.label} 不可用` }}
      </n-tooltip>
    </div>

    <div class="actions">
      <n-button size="tiny" type="primary" secondary @click="openMachinePage(machine.id, 'sites')">
        <template #icon><n-icon :component="GlobeOutline" /></template>
        站点
      </n-button>
      <n-button size="tiny" secondary @click="openMachinePage(machine.id, 'containers')">
        <template #icon><n-icon :component="CubeOutline" /></template>
        容器
      </n-button>
      <n-button size="tiny" secondary @click="openMachinePage(machine.id, 'files')">
        <template #icon><n-icon :component="FolderOpenOutline" /></template>
        文件
      </n-button>
      <n-button size="tiny" secondary @click="openMachinePage(machine.id, 'terminal')">
        <template #icon><n-icon :component="TerminalOutline" /></template>
        终端
      </n-button>
      <n-button size="tiny" quaternary @click="openMachineDetail(machine.id)">
        <template #icon><n-icon :component="OpenOutline" /></template>
        详情
      </n-button>
    </div>
  </n-card>
</template>

<style scoped>
.machine-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.machine-card.offline {
  opacity: 0.82;
}
.head {
  min-width: 0;
}
.title-row {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  min-width: 0;
}
.name {
  font-size: 14px;
  font-weight: 650;
  max-width: 220px;
}
.sub {
  margin-top: 2px;
}
.metrics {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.metric {
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr);
  grid-template-rows: auto auto;
  gap: 2px 8px;
  align-items: center;
}
.metric > .tiny:first-child {
  grid-row: 1 / span 2;
}
.meta-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
}
.no-snapshot {
  padding: 8px 0;
}
.caps {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: auto;
}
</style>
