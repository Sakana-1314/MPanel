<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  NAlert,
  NButton,
  NCard,
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
  EyeOutline,
  KeyOutline,
  PlayOutline,
  RefreshOutline,
  StopOutline,
  TrashOutline,
  WifiOutline,
  OpenOutline,
} from '@vicons/ionicons5';
import type { Machine, MachineEnrollment, MachineTestResult } from '@/api/types';
import { useCoreApi } from '@/lib/api';
import { useMachinesQuery } from '@/lib/machines';
import { coreKey } from '@/lib/query-keys';
import { useAction } from '@/composables/use-action';
import { openMachineDetail, openMachinePage } from '@/lib/navigation';
import { machineStatusType } from '@/lib/status';
import PageHeader from '@/components/common/PageHeader.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import StatCard from '@/components/common/StatCard.vue';
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
const testResults = ref<Record<string, MachineTestResult>>({});

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
  { label: '全部传输', value: 'all' },
  { label: 'http', value: 'http' },
  { label: 'stdio', value: 'stdio' },
  { label: 'reverse-ws', value: 'reverse-ws' },
];

const invalidate = computed(() => [
  coreKey('machines', 'list', { limit: 200 }),
  coreKey('system', 'overview'),
]);

const connectAction = useAction((machine: Machine) => api.value.machines.connect(machine.id), {
  success: (machine) => `已请求连接 ${machine.name}`,
  successDescription: (machine) =>
    machine.transport === 'reverse-ws' ? '等待 agent 主动连回 core。' : 'core 正在建立到 agent 的连接。',
  invalidate: invalidate.value,
});

const disconnectAction = useAction((machine: Machine) => api.value.machines.disconnect(machine.id), {
  success: (machine) => `已断开 ${machine.name}`,
  successDescription: 'desiredState 已设为 stopped。',
  invalidate: invalidate.value,
});

const deleteAction = useAction((machine: Machine) => api.value.machines.delete(machine.id), {
  success: (_result, machine) => `已删除机器 ${machine.name}`,
  successDescription: '机器配置与凭据已移除；agent 进程本身不受影响。',
  invalidate: invalidate.value,
});

const rotateAction = useAction(
  (machine: Machine) => api.value.machines.rotateSecret(machine.id),
  {
    success: (result, machine) => `已轮换 ${machine.name} 的 secret`,
    successDescription: '请保存新的注册信息。',
    invalidate: invalidate.value,
  },
);

async function testMachine(machine: Machine): Promise<void> {
  const result = await testAction.run(machine);
  if (result !== undefined) {
    testResults.value = { ...testResults.value, [machine.id]: result };
  }
}

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
    content: `确定删除“${machine.name}”？将移除机器配置与凭据，所有经 core 代理的请求会立即失效；agent 进程本身不受影响。`,
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
      subtitle="core 通过 http / stdio / reverse-ws 管理 agent。这里的每台机器都可以独立打开一个工作台标签页，多台机器可以同时操作。"
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

    <div class="stat-grid">
      <stat-card label="机器总数" :value="counts.total" :hint="`reverse-ws ${counts.remote} 台`" :loading="machinesQuery.isLoading.value" />
      <stat-card label="在线" :value="counts.online" :type="counts.online > 0 ? 'success' : 'default'" hint="心跳 ≤ 15s" :loading="machinesQuery.isLoading.value" />
      <stat-card label="异常" :value="counts.issues" :type="counts.issues > 0 ? 'error' : 'default'" hint="离线 / 降级 / error" :loading="machinesQuery.isLoading.value" />
    </div>

    <n-alert
      v-if="machinesQuery.data.value?.available === false"
      type="error"
      :bordered="true"
      title="机器存储不可用"
    >
      {{ machinesQuery.data.value.reason ?? 'core 返回 available=false。' }}
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
          placeholder="搜索机器名 / id / 端点…"
          clearable
          style="max-width: 280px"
        />
        <n-select v-model:value="statusFilter" :options="statusOptions" style="width: 140px" />
        <n-select v-model:value="transportFilter" :options="transportOptions" style="width: 150px" />
        <div class="spacer" />
        <span class="small muted">
          共 {{ filtered.length }} 台
          <template v-if="machinesQuery.isFetching.value"> · 刷新中…</template>
        </span>
      </div>
    </n-card>

    <n-empty v-if="machines.length === 0 && !machinesQuery.isLoading.value" description="还没有机器">
      <template #extra>
        <div class="empty-actions">
          <p class="small muted" style="max-width: 560px; line-height: 1.7">
            接入第一台机器后，core 才能代理站点、证书、数据库、容器、文件与终端请求。
            支持 http（直连 agent URL）、stdio（core 拉起本地进程）与 reverse-ws（agent 主动连回，适合 NAT）。
          </p>
          <n-button type="primary" @click="openCreate">新增机器</n-button>
        </div>
      </template>
    </n-empty>

    <n-card v-else size="small" :content-style="{ padding: '0' }">
      <n-table :single-line="false" size="small">
        <thead>
          <tr>
            <th style="min-width: 180px">机器</th>
            <th style="width: 130px">状态</th>
            <th style="min-width: 170px">传输 / 端点</th>
            <th style="min-width: 150px">最近心跳</th>
            <th style="width: 130px">连通性测试</th>
            <th style="width: 260px">操作</th>
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
                  <n-tag v-if="machine.edge" size="tiny" type="info" round :bordered="false">edge</n-tag>
                  <n-tag v-if="machine.group" size="tiny" round :bordered="false">{{ machine.group }}</n-tag>
                </div>
              </div>
            </td>
            <td>
              <div class="stack-tight">
                <MachineStatusTag :status="machine.status" />
                <span class="tiny muted">
                  {{ machine.desiredState === 'running' ? '期望运行' : '期望停止' }}
                  · {{ machine.enabled ? '已启用' : '已禁用' }}
                </span>
                <span v-if="machine.lastError" class="tiny error-text truncate" :title="machine.lastError">
                  {{ machine.lastError }}
                </span>
              </div>
            </td>
            <td>
              <div class="stack-tight">
                <n-tag size="tiny" :type="machine.transport === 'reverse-ws' ? 'info' : 'default'" round :bordered="false">
                  {{ machine.transport }}
                </n-tag>
                <span class="mono tiny muted truncate" :title="machine.endpoint ?? 'stdio 本地进程'">
                  {{ machine.endpoint ?? 'stdio 本地进程' }}
                </span>
              </div>
            </td>
            <td>
              <div class="stack-tight">
                <RelativeTime :value="machine.lastSeenAt" />
                <span class="tiny muted">
                  {{ machine.worker === null ? 'agent 未上报' : `${machine.worker.name} v${machine.worker.version}` }}
                </span>
              </div>
            </td>
            <td>
              <div v-if="testResults[machine.id]" class="stack-tight">
                <n-tag
                  size="tiny"
                  :type="testResults[machine.id]!.reachable ? 'success' : 'error'"
                  round
                  :bordered="false"
                >
                  {{ testResults[machine.id]!.reachable ? '可达' : '不可达' }}
                </n-tag>
                <span class="tiny muted">
                  {{ testResults[machine.id]!.latencyMs ?? '?' }} ms
                </span>
              </div>
              <span v-else class="tiny muted">—</span>
            </td>
            <td>
              <div class="actions">
                <n-tooltip>
                  <template #trigger>
                    <n-button size="tiny" type="primary" secondary @click="openMachinePage(machine.id, 'sites')">
                      <template #icon><n-icon :component="OpenOutline" /></template>
                      打开
                    </n-button>
                  </template>
                  在新标签页打开该机器的站点工作台
                </n-tooltip>
                <n-tooltip>
                  <template #trigger>
                    <n-button size="tiny" quaternary :disabled="isBusy" @click="machine.desiredState === 'running' ? disconnectAction.run(machine) : connectAction.run(machine)">
                      <template #icon>
                        <n-icon :component="machine.desiredState === 'running' ? StopOutline : PlayOutline" />
                      </template>
                    </n-button>
                  </template>
                  {{ machine.desiredState === 'running' ? '断开机器' : '连接机器' }}
                </n-tooltip>
                <n-tooltip>
                  <template #trigger>
                    <n-button size="tiny" quaternary :loading="testAction.pending.value" @click="testMachine(machine)">
                      <template #icon><n-icon :component="WifiOutline" /></template>
                    </n-button>
                  </template>
                  测试连通性
                </n-tooltip>
                <n-tooltip>
                  <template #trigger>
                    <n-button size="tiny" quaternary @click="openMachineDetail(machine.id)">
                      <template #icon><n-icon :component="EyeOutline" /></template>
                    </n-button>
                  </template>
                  详情与健康
                </n-tooltip>
                <n-tooltip>
                  <template #trigger>
                    <n-button size="tiny" quaternary @click="openEdit(machine)">
                      <template #icon><n-icon :component="CreateOutline" /></template>
                    </n-button>
                  </template>
                  编辑
                </n-tooltip>
                <n-tooltip v-if="machine.transport === 'reverse-ws'">
                  <template #trigger>
                    <n-button size="tiny" quaternary @click="rotate(machine)">
                      <template #icon><n-icon :component="KeyOutline" /></template>
                    </n-button>
                  </template>
                  轮换 machine secret
                </n-tooltip>
                <n-tooltip>
                  <template #trigger>
                    <n-button size="tiny" quaternary type="error" @click="confirmDelete(machine)">
                      <template #icon><n-icon :component="TrashOutline" /></template>
                    </n-button>
                  </template>
                  删除机器
                </n-tooltip>
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
