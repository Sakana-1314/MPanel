<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  NAlert,
  NButton,
  NCard,
  NDropdown,
  NEmpty,
  NIcon,
  NInput,
  NSelect,
  NTable,
  NTag,
  NTooltip,
  useDialog,
} from 'naive-ui';
import {
  AddOutline,
  CreateOutline,
  EllipsisHorizontalOutline,
  EyeOutline,
  KeyOutline,
  PlayOutline,
  RefreshOutline,
  ServerOutline,
  StopOutline,
  TrashOutline,
  WifiOutline,
  OpenOutline,
} from '@vicons/ionicons5';
import type { Machine, MachineEnrollment } from '@/api/types';
import { useCoreApi } from '@/lib/api';
import { useMachinesQuery } from '@/lib/machines';
import { coreKey } from '@/lib/query-keys';
import { useAction } from '@/composables/use-action';
import { openMachineDetail, openMachinePage } from '@/lib/navigation';
import { machineStatusType } from '@/lib/status';
import { machineAddressLabel, transportLabel } from '@/lib/format';
import PageHeader from '@/components/common/PageHeader.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import MachineStatusTag from '@/components/common/MachineStatusTag.vue';
import RelativeTime from '@/components/common/RelativeTime.vue';
import MachineFormModal from './MachineFormModal.vue';
import EnrollmentModal from './EnrollmentModal.vue';

const api = useCoreApi();
const dialog = useDialog();
const machinesQuery = useMachinesQuery();

const search = ref('');
const statusFilter = ref('all');
const transportFilter = ref('all');
const formOpen = ref(false);
const editing = ref<Machine | undefined>(undefined);
const enrollment = ref<MachineEnrollment | null>(null);
const enrollmentOpen = ref(false);

const machines = computed(() => machinesQuery.data.value?.items ?? []);

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

const counts = computed(() => {
  let online = 0;
  let issues = 0;
  let remote = 0;
  for (const machine of machines.value) {
    if (machine.status === 'online') online += 1;
    if (['offline', 'error', 'degraded'].includes(machine.status)) issues += 1;
    if (machine.transport === 'reverse-ws') remote += 1;
  }
  return { total: machines.value.length, online, issues, remote };
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
  successDescription: (machine) =>
    machine.transport === 'reverse-ws' ? '等待节点主动连回。' : '正在建立到节点的连接。',
  invalidate: invalidate.value,
});

const disconnectAction = useAction((machine: Machine) => api.value.machines.disconnect(machine.id), {
  success: (machine) => `已断开 ${machine.name}`,
  successDescription: 'desiredState 已设为 stopped。',
  invalidate: invalidate.value,
});

const deleteAction = useAction((machine: Machine) => api.value.machines.delete(machine.id), {
  success: (_result, machine) => `已删除机器 ${machine.name}`,
  successDescription: '机器配置与凭据已移除；目标服务器上的服务不受影响。',
  invalidate: invalidate.value,
});

const rotateAction = useAction(
  (machine: Machine) => api.value.machines.rotateSecret(machine.id),
  {
    success: (result, machine) => `已轮换 ${machine.name} 的接入密钥`,
    successDescription: '请保存新的注册信息。',
    invalidate: invalidate.value,
  },
);

const testAction = useAction((machine: Machine) => api.value.machines.test(machine.id), {
  success: (result, machine) =>
    result.reachable
      ? `测试成功 · ${machine.name} · ${result.latencyMs ?? '?'} ms`
      : `测试失败 · ${machine.name}`,
  invalidate: invalidate.value,
});

function openCreate(): void {
  editing.value = undefined;
  formOpen.value = true;
}

function openEdit(machine: Machine): void {
  editing.value = machine;
  formOpen.value = true;
}

function confirmDelete(machine: Machine): void {
  dialog.warning({
    title: '删除机器',
    content: `确定删除“${machine.name}”？将移除机器配置与凭据，所有经面板转发的请求会立即失效；目标服务器上的服务不受影响。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: () => {
      void deleteAction.run(machine);
    },
  });
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

function rowMenuOptions(machine: Machine): Array<{ label: string; key: string }> {
  return [
    { label: '详情与健康', key: 'detail' },
    { label: '编辑机器', key: 'edit' },
    ...(machine.transport === 'reverse-ws' ? [{ label: '轮换接入密钥', key: 'rotate' }] : []),
    { label: '删除机器', key: 'delete' },
  ];
}

function onRowMenu(key: string, machine: Machine): void {
  if (key === 'detail') openMachineDetail(machine.id);
  else if (key === 'edit') openEdit(machine);
  else if (key === 'rotate') void rotate(machine);
  else if (key === 'delete') confirmDelete(machine);
}

function onSaved(result: { machine: Machine; enrollment?: MachineEnrollment }): void {
  if (result.enrollment !== undefined) {
    enrollment.value = result.enrollment;
    enrollmentOpen.value = true;
  }
}

const isBusy = computed(
  () =>
    connectAction.pending.value ||
    disconnectAction.pending.value ||
    testAction.pending.value ||
    deleteAction.pending.value ||
    rotateAction.pending.value,
);
</script>

<template>
  <div class="page">
    <PageHeader
      title="机器"
    >
      <template #actions>
        <n-button size="small" secondary :loading="machinesQuery.isFetching.value" @click="machinesQuery.refetch()">
          <template #icon><n-icon :component="RefreshOutline" /></template>
          刷新
        </n-button>
        <n-button size="small" type="primary" @click="openCreate">
          <template #icon><n-icon :component="AddOutline" /></template>
          新增机器
        </n-button>
      </template>
    </PageHeader>

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

    <n-card size="small">
      <div class="toolbar">
        <n-input
          v-model:value="search"
          placeholder="搜索机器名 / ID / 地址…"
          clearable
          style="max-width: 280px"
        />
        <n-select v-model:value="statusFilter" :options="statusOptions" style="width: 140px" />
        <n-select v-model:value="transportFilter" :options="transportOptions" style="width: 150px" />
        <div class="spacer" />
        <span class="small muted">
          {{ filtered.length }} 台 · 在线 {{ counts.online }} · 异常 {{ counts.issues }}
          <template v-if="machinesQuery.isFetching.value"> · 刷新中…</template>
        </span>
      </div>
    </n-card>

    <n-empty v-if="machines.length === 0 && !machinesQuery.isLoading.value" description="还没有机器">
      <template #icon><n-icon :component="ServerOutline" size="36" /></template>
      <template #extra>
        <n-button type="primary" @click="openCreate">新增机器</n-button>
      </template>
    </n-empty>

    <n-card v-else size="small" :content-style="{ padding: '0' }">
      <n-table :single-line="false" size="small">
        <thead>
          <tr>
            <th style="min-width: 180px">机器</th>
            <th style="width: 130px">状态</th>
            <th style="min-width: 170px">接入方式 / 地址</th>
            <th style="min-width: 150px">最近心跳</th>
            <th style="width: 170px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="machine in filtered" :key="machine.id">
            <td>
              <div class="name-cell">
                <button type="button" class="link-name" @click="openMachineDetail(machine.id)">
                  {{ machine.name }}
                </button>
                <span class="mono tiny muted">{{ machine.id }}</span>
                <div class="tags">
                  <n-tag v-if="machine.edge" size="tiny" type="info" round :bordered="false">边缘</n-tag>
                  <n-tag v-if="machine.group" size="tiny" round :bordered="false">{{ machine.group }}</n-tag>
                </div>
              </div>
            </td>
            <td>
              <div class="stack-tight">
                <MachineStatusTag :status="machine.status" />
                <n-tag v-if="!machine.enabled" size="tiny" round :bordered="false">已禁用</n-tag>
                <span v-if="machine.lastError" class="tiny error-text truncate" :title="machine.lastError">
                  {{ machine.lastError }}
                </span>
              </div>
            </td>
            <td>
              <div class="stack-tight">
                <n-tag size="tiny" :type="machine.transport === 'reverse-ws' ? 'info' : 'default'" round :bordered="false">
                  {{ transportLabel(machine.transport) }}
                </n-tag>
                <span class="mono tiny muted truncate" :title="machineAddressLabel(machine)">
                  {{ machineAddressLabel(machine) }}
                </span>
              </div>
            </td>
            <td>
              <div class="stack-tight">
                <RelativeTime :value="machine.lastSeenAt" />
                <span class="tiny muted">
                  {{ machine.worker === null ? '未上报' : `v${machine.worker.version}` }}
                </span>
              </div>
            </td>
            <td>
              <div class="actions">
                <n-button size="tiny" type="primary" secondary @click="openMachinePage(machine.id, 'sites')">
                  <template #icon><n-icon :component="OpenOutline" /></template>
                  打开
                </n-button>
                <n-tooltip>
                  <template #trigger>
                    <n-button
                      size="tiny"
                      quaternary
                      :disabled="isBusy"
                      @click="machine.desiredState === 'running' ? disconnectAction.run(machine) : connectAction.run(machine)"
                    >
                      <template #icon>
                        <n-icon :component="machine.desiredState === 'running' ? StopOutline : PlayOutline" />
                      </template>
                    </n-button>
                  </template>
                  {{ machine.desiredState === 'running' ? '断开机器' : '连接机器' }}
                </n-tooltip>
                <n-tooltip>
                  <template #trigger>
                    <n-button size="tiny" quaternary :loading="testAction.pending.value" @click="testAction.run(machine)">
                      <template #icon><n-icon :component="WifiOutline" /></template>
                    </n-button>
                  </template>
                  测试连通性
                </n-tooltip>
                <n-dropdown
                  trigger="click"
                  :options="rowMenuOptions(machine)"
                  @select="(key: string) => onRowMenu(key, machine)"
                >
                  <n-button size="tiny" quaternary aria-label="更多操作">
                    <template #icon><n-icon :component="EllipsisHorizontalOutline" /></template>
                  </n-button>
                </n-dropdown>
              </div>
            </td>
          </tr>
        </tbody>
      </n-table>
      <div v-if="filtered.length === 0" class="empty-row small muted">没有匹配的机器。</div>
    </n-card>

    <MachineFormModal
      v-model:show="formOpen"
      :machine="editing"
      @saved="onSaved"
    />
    <EnrollmentModal v-model:show="enrollmentOpen" :enrollment="enrollment" />
  </div>
</template>

<style scoped>
.name-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.link-name {
  border: 0;
  background: transparent;
  padding: 0;
  color: var(--mpanel-text);
  font-weight: 600;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.link-name:hover {
  color: var(--mpanel-accent);
}
.tags {
  display: flex;
  gap: 4px;
}
.stack-tight {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  min-width: 0;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
}
.error-text {
  color: #e05561;
  max-width: 180px;
}
.empty-actions {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}
.empty-row {
  padding: 18px;
  text-align: center;
}
</style>
