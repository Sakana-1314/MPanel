<script setup lang="ts">
import { computed, h, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  NAlert,
  NButton,
  NCard,
  NDrawer,
  NDrawerContent,
  NDropdown,
  NEmpty,
  NIcon,
  NInput,
  NProgress,
  NSelect,
  NSpin,
  NTabPane,
  NTabs,
  NTag,
  NIcon as NIconAlias,
} from 'naive-ui';
import type { Component, VNode } from 'vue';
import {
  AddOutline,
  ChevronDownOutline,
  CopyOutline,
  CreateOutline,
  CubeOutline,
  EllipsisHorizontalOutline,
  FolderOpenOutline,
  GitNetworkOutline,
  GlobeOutline,
  KeyOutline,
  LayersOutline,
  PlayOutline,
  RefreshOutline,
  ReloadOutline,
  ServerOutline,
  SettingsOutline,
  StopOutline,
  TerminalOutline,
  TrashOutline,
  WifiOutline,
} from '@vicons/ionicons5';
import type { Machine, MachineEnrollment } from '@/api/types';
import { useCoreApi } from '@/lib/api';
import { useMachinesQuery } from '@/lib/machines';
import { coreKey } from '@/lib/query-keys';
import { useAction } from '@/composables/use-action';
import { openMachineDetail, openMachinePage } from '@/lib/navigation';
import { machineStatusLabel, machineStatusType } from '@/lib/status';
import { machineAddressLabel, transportLabel } from '@/lib/format';
import { usePageActive } from '@/composables/use-page-active';
import ErrorState from '@/components/common/ErrorState.vue';
import RelativeTime from '@/components/common/RelativeTime.vue';
import MachineFormModal from './MachineFormModal.vue';
import MachineMetrics from './MachineMetrics.vue';
import EnrollmentModal from './EnrollmentModal.vue';
import EdgePanel from '@/pages/edge/EdgePanel.vue';

const router = useRouter();
const api = useCoreApi();
const active = usePageActive();
const machinesQuery = useMachinesQuery();

const search = ref('');
const statusFilter = ref('all');
const transportFilter = ref('all');

const formOpen = ref(false);
const editing = ref<Machine | undefined>(undefined);
const enrollment = ref<MachineEnrollment | null>(null);
const enrollmentOpen = ref(false);
const edgeOpen = ref(false);

const machines = computed(() => machinesQuery.data.value?.items ?? []);

const counts = computed(() => {
  let online = 0;
  let issues = 0;
  let edge = 0;
  for (const machine of machines.value) {
    if (machine.status === 'online') online += 1;
    if (['offline', 'error', 'degraded'].includes(machine.status)) issues += 1;
    if (machine.edge || machine.transport === 'reverse-ws') edge += 1;
  }
  return { total: machines.value.length, online, issues, edge };
});

const filtered = computed(() => {
  const needle = search.value.trim().toLowerCase();
  return machines.value.filter((machine) => {
    if (statusFilter.value !== 'all' && machine.status !== statusFilter.value) return false;
    if (transportFilter.value !== 'all' && machine.transport !== transportFilter.value) return false;
    if (needle.length === 0) return true;
    return (
      machine.name.toLowerCase().includes(needle) ||
      machine.id.toLowerCase().includes(needle) ||
      (machine.endpoint ?? '').toLowerCase().includes(needle)
    );
  });
});

const statusOptions = [
  { label: '全部状态', value: 'all' },
  { label: '在线', value: 'online' },
  { label: '离线', value: 'offline' },
  { label: '启动中', value: 'starting' },
  { label: '降级', value: 'degraded' },
  { label: '错误', value: 'error' },
];
const transportOptions = [
  { label: '全部接入方式', value: 'all' },
  { label: '直连', value: 'http' },
  { label: '本机', value: 'stdio' },
  { label: '隧道', value: 'reverse-ws' },
];

const invalidate = computed(() => [
  coreKey('machines', 'list', { limit: 200 }),
  coreKey('system', 'overview'),
]);

const connectAction = useAction((machine: Machine) => api.value.machines.connect(machine.id), {
  success: (machine) => `已请求连接 ${machine.name}`,
  invalidate: invalidate.value,
});
const disconnectAction = useAction((machine: Machine) => api.value.machines.disconnect(machine.id), {
  success: (machine) => `已断开 ${machine.name}`,
  invalidate: invalidate.value,
});
const testAction = useAction((machine: Machine) => api.value.machines.test(machine.id), {
  success: (result, machine) =>
    result.reachable
      ? `${machine.name} 可达 · ${result.latencyMs ?? '?'} ms`
      : `${machine.name} 不可达`,
  invalidate: invalidate.value,
});
const deleteAction = useAction((machine: Machine) => api.value.machines.delete(machine.id), {
  success: (_result, machine) => `已删除 ${machine.name}`,
  invalidate: invalidate.value,
});
const rotateAction = useAction((machine: Machine) => api.value.machines.rotateSecret(machine.id), {
  success: (_result, machine) => `已轮换 ${machine.name} 的接入密钥`,
  invalidate: invalidate.value,
});

async function refresh(): Promise<void> {
  await machinesQuery.refetch();
}

function openCreate(): void {
  editing.value = undefined;
  formOpen.value = true;
}

function openEdit(machine: Machine): void {
  editing.value = machine;
  formOpen.value = true;
}

async function rotate(machine: Machine): Promise<void> {
  const result = await rotateAction.run(machine);
  if (result === undefined) return;
  enrollment.value = {
    machineId: machine.id,
    url: machine.endpoint ?? '',
    secret: result.secret,
    workerEnv: result.workerEnv,
  };
  enrollmentOpen.value = true;
}

async function remove(machine: Machine): Promise<void> {
  await deleteAction.run(machine);
}

function menuOptions(machine: Machine): Array<{ label: string; key: string; icon: () => VNode }> {
  return [
    { label: '详情', key: 'detail', icon: () => h(NIconAlias, { component: ServerOutline }) },
    { label: '编辑', key: 'edit', icon: () => h(NIconAlias, { component: CreateOutline }) },
    {
      label: machine.status !== 'online' ? '连接' : '断开',
      key: 'toggle',
      icon: () =>
        h(NIconAlias, { component: machine.status !== 'online' ? PlayOutline : StopOutline }),
    },
    { label: '测试连通性', key: 'test', icon: () => h(NIconAlias, { component: WifiOutline }) },
    ...(machine.transport === 'reverse-ws'
      ? [{ label: '轮换接入密钥', key: 'rotate', icon: () => h(NIconAlias, { component: KeyOutline }) }]
      : []),
    { label: '删除机器', key: 'delete', icon: () => h(NIconAlias, { component: TrashOutline }) },
  ];
}

function onMenuSelect(key: string, machine: Machine): void {
  if (key === 'detail') openMachineDetail(machine.id);
  else if (key === 'edit') openEdit(machine);
  else if (key === 'toggle') {
    if (machine.status === 'online') void disconnectAction.run(machine);
    else void connectAction.run(machine);
  } else if (key === 'test') void testAction.run(machine);
  else if (key === 'rotate') void rotate(machine);
  else if (key === 'delete') {
    // 危险操作走二次确认。
    if (window.confirm(`确定删除「${machine.name}」？配置与凭据会被移除，目标服务器不受影响。`)) {
      void remove(machine);
    }
  }
}

function openArea(machine: Machine, area: string): void {
  openMachinePage(machine.id, area);
}

const shortcuts: Array<{ area: string; label: string; icon: Component }> = [
  { area: 'sites', label: '站点', icon: GlobeOutline },
  { area: 'containers', label: '容器', icon: CubeOutline },
  { area: 'files', label: '文件', icon: FolderOpenOutline },
  { area: 'terminal', label: '终端', icon: TerminalOutline },
];
</script>

<template>
  <div class="page">
    <header class="head">
      <div class="head-main">
        <h1>机器</h1>
        <div class="counts">
          <span><strong>{{ counts.total }}</strong> 台</span>
          <span class="ok"><strong>{{ counts.online }}</strong> 在线</span>
          <span v-if="counts.issues > 0" class="bad"><strong>{{ counts.issues }}</strong> 异常</span>
          <span v-if="counts.edge > 0"><strong>{{ counts.edge }}</strong> 边缘</span>
        </div>
      </div>
      <div class="toolbar">
        <n-button size="small" secondary :loading="machinesQuery.isFetching.value" @click="refresh">
          <template #icon><n-icon :component="RefreshOutline" /></template>
          刷新
        </n-button>
        <n-button size="small" secondary @click="edgeOpen = true">
          <template #icon><n-icon :component="GitNetworkOutline" /></template>
          边缘节点
        </n-button>
        <n-button size="small" type="primary" @click="openCreate">
          <template #icon><n-icon :component="AddOutline" /></template>
          新增机器
        </n-button>
      </div>
    </header>

    <n-alert
      v-if="machinesQuery.data.value?.available === false"
      type="error"
      :bordered="true"
      title="机器存储不可用"
    >
      {{ machinesQuery.data.value.reason ?? '服务返回不可用。' }}
    </n-alert>

    <error-state
      v-if="machinesQuery.isError.value"
      :error="machinesQuery.error.value"
      @retry="machinesQuery.refetch()"
    />

    <div class="filters">
      <n-input v-model:value="search" placeholder="搜索机器" clearable size="small" style="max-width: 240px" />
      <n-select v-model:value="statusFilter" :options="statusOptions" size="small" style="width: 128px" />
      <n-select v-model:value="transportFilter" :options="transportOptions" size="small" style="width: 140px" />
    </div>

    <n-spin v-if="machinesQuery.isLoading.value && machines.length === 0" size="small">
      <div style="height: 80px" />
    </n-spin>

    <n-empty
      v-else-if="machines.length === 0"
      description="还没有机器"
      class="empty-block"
    >
      <template #icon><n-icon :component="ServerOutline" size="34" /></template>
      <template #extra>
        <div class="toolbar" style="justify-content: center">
          <n-button size="small" type="primary" @click="openCreate">新增机器</n-button>
          <n-button size="small" secondary @click="edgeOpen = true">边缘接入</n-button>
        </div>
      </template>
    </n-empty>

    <div v-else-if="filtered.length === 0" class="empty-block small muted">没有匹配的机器</div>

    <div v-else class="card-grid">
      <n-card
        v-for="machine in filtered"
        :key="machine.id"
        size="small"
        class="machine-card"
        :class="{ offline: machine.status !== 'online' }"
      >
        <div class="card-head">
          <div class="card-title">
            <span class="status-dot" :class="`dot-${machineStatusType(machine.status)}`" />
            <button type="button" class="name" @click="openMachineDetail(machine.id)">
              {{ machine.name }}
            </button>
            <n-tag v-if="machine.edge || machine.transport === 'reverse-ws'" size="tiny" :bordered="false" round>
              边缘
            </n-tag>
          </div>
          <n-dropdown
            trigger="click"
            placement="bottom-end"
            :options="menuOptions(machine)"
            @select="(key: string) => onMenuSelect(key, machine)"
          >
            <n-button size="tiny" quaternary circle aria-label="更多操作">
              <template #icon><n-icon :component="EllipsisHorizontalOutline" /></template>
            </n-button>
          </n-dropdown>
        </div>

        <div class="card-meta">
          <n-tag size="tiny" round :bordered="false" :type="machine.status === 'online' ? 'success' : 'default'">
            {{ machineStatusLabel(machine.status) }}
          </n-tag>
          <span class="tiny muted">{{ transportLabel(machine.transport) }}</span>
          <span class="tiny muted truncate">{{ machineAddressLabel(machine) }}</span>
        </div>

        <machine-metrics :machine="machine" />

        <div class="facts tiny muted">
          <span>心跳 <relative-time :value="machine.lastSeenAt" /></span>
          <span v-if="machine.worker">v{{ machine.worker.version }}</span>
          <span v-if="machine.snapshot">{{ machine.snapshot.ips[0] ?? '' }}</span>
        </div>

        <div v-if="machine.lastError" class="error-line tiny truncate" :title="machine.lastError">
          {{ machine.lastError }}
        </div>

        <div class="card-actions">
          <n-button
            v-for="item in shortcuts"
            :key="item.area"
            size="tiny"
            quaternary
            @click="openArea(machine, item.area)"
          >
            <template #icon><n-icon :component="item.icon" size="14" /></template>
            {{ item.label }}
          </n-button>
        </div>
      </n-card>
    </div>

    <machine-form-modal v-model:show="formOpen" :machine="editing" />
    <enrollment-modal v-model:show="enrollmentOpen" :enrollment="enrollment" />

    <n-drawer v-model:show="edgeOpen" :width="920" placement="right">
      <n-drawer-content title="边缘节点" closable :native-scrollbar="false">
        <edge-panel @quick-open="openCreate" />
      </n-drawer-content>
    </n-drawer>
  </div>
</template>

<style scoped>
.head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.head-main {
  display: flex;
  align-items: baseline;
  gap: 14px;
  min-width: 0;
  flex-wrap: wrap;
}
.head h1 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.counts {
  display: flex;
  gap: 12px;
  font-size: 12px;
  color: var(--mpanel-muted);
}
.counts strong {
  color: var(--mpanel-text);
  font-variant-numeric: tabular-nums;
}
.counts .ok strong {
  color: var(--mpanel-success);
}
.counts .bad strong {
  color: var(--mpanel-danger);
}
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.empty-block {
  padding: 40px 0;
  text-align: center;
}

/* -------------------------------- cards -------------------------------- */

.machine-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.machine-card:hover {
  box-shadow: var(--mpanel-shadow-raised);
}
.machine-card.offline {
  opacity: 0.86;
}
.card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}
.card-title {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  flex-wrap: wrap;
}
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  flex: 0 0 auto;
  background: var(--mpanel-status-offline);
}
.status-dot.dot-success,
.status-dot.dot-info {
  background: var(--mpanel-status-online);
}
.name {
  border: 0;
  background: transparent;
  padding: 0;
  color: var(--mpanel-text);
  font-size: 13.5px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.name:hover {
  color: var(--mpanel-accent);
  text-decoration: underline;
}
.card-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
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
.error-line {
  color: var(--mpanel-danger);
}
.card-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  margin-top: auto;
  padding: 6px 4px 2px;
  border-radius: 8px;
  background: var(--mpanel-surface-soft);
}
</style>
