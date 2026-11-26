<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import {
  NAlert,
  NButton,
  NCard,
  NDrawer,
  NDrawerContent,
  NEmpty,
  NFormItem,
  NIcon,
  NInput,
  NInputNumber,
  NModal,
  NSelect,
  NSpin,
  NTabPane,
  NTabs,
  NTable,
  NTag,
  useDialog,
} from 'naive-ui';
import {
  AddOutline,
  BanOutline,
  CreateOutline,
  EyeOutline,
  GitNetworkOutline,
  KeyOutline,
  OpenOutline,
  RefreshOutline,
  TerminalOutline,
  TrashOutline,
} from '@vicons/ionicons5';
import type {
  EdgeJob,
  EdgeJobKind,
  EdgeJobStatus,
  EdgeKey,
  EdgeKeyCreateResult,
  Machine,
} from '@/api/types';
import {
  createEdgeJob,
  createEdgeKey,
  deleteEdgeJob,
  listEdgeJobs,
  listEdgeKeys,
  listEdgeTargetSites,
  listEdgeTargetTasks,
  revokeEdgeKey,
} from '@/api/edge';
import { useCoreApi } from '@/lib/api';
import { useMachinesQuery } from '@/lib/machines';
import { coreKey } from '@/lib/query-keys';
import { authenticated } from '@/lib/machines';
import { usePageActive } from '@/composables/use-page-active';
import { useAction } from '@/composables/use-action';
import { openMachinePage } from '@/lib/navigation';
import { formatDate, formatDuration, formatUptime } from '@/lib/format';
import { edgeJobStatusLabel, edgeJobStatusType, machineStatusType } from '@/lib/status';
import PageHeader from '@/components/common/PageHeader.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import MachineStatusTag from '@/components/common/MachineStatusTag.vue';
import RelativeTime from '@/components/common/RelativeTime.vue';
import CodeBlock from '@/components/common/CodeBlock.vue';
import SecretReveal from '@/components/common/SecretReveal.vue';
import CopyButton from '@/components/common/CopyButton.vue';

const api = useCoreApi();
const active = usePageActive();
const dialog = useDialog();
const machinesQuery = useMachinesQuery();

const tab = ref('nodes');
const refreshing = ref(false);

const machines = computed(() => machinesQuery.data.value?.items ?? []);
const edgeNodes = computed(() => machines.value.filter((machine) => machine.edge));

/* ------------------------------- keys ------------------------------- */

const keysQuery = useQuery({
  queryKey: coreKey('edge', 'keys'),
  queryFn: () => listEdgeKeys(),
  enabled: authenticated(),
  staleTime: 15_000,
  refetchInterval: computed(() => (active.value ? 30_000 : false)),
  retry: 0,
});

const keys = computed(() => keysQuery.data.value?.items ?? []);

/* ------------------------------- jobs ------------------------------- */

const jobMachineFilter = ref('all');
const jobStatusFilter = ref<EdgeJobStatus | 'all'>('all');

const jobParams = computed(() => ({
  limit: 200,
  ...(jobMachineFilter.value === 'all' ? {} : { machineId: jobMachineFilter.value }),
  ...(jobStatusFilter.value === 'all' ? {} : { status: jobStatusFilter.value }),
}));

const jobsQuery = useQuery({
  queryKey: computed(() => coreKey('edge', 'jobs', jobParams.value)),
  queryFn: () => listEdgeJobs(jobParams.value),
  enabled: authenticated(),
  retry: 0,
  refetchInterval: computed(() => (active.value ? 5_000 : false)),
});

const jobs = computed(() => jobsQuery.data.value?.items ?? []);
const pendingCount = computed(() => jobs.value.filter((job) => job.status === 'pending').length);

const machineOptions = computed(() => [
  { label: '全部机器', value: 'all' },
  ...machines.value.map((machine) => ({
    label: `${machine.name}${machine.edge ? '（edge）' : ''}`,
    value: machine.id,
  })),
]);
const jobStatusOptions = [
  { label: '全部状态', value: 'all' },
  ...(['pending', 'running', 'succeeded', 'failed', 'canceled'] as EdgeJobStatus[]).map((status) => ({
    label: edgeJobStatusLabel(status),
    value: status,
  })),
];

const jobKindLabel: Record<EdgeJobKind, string> = {
  snapshot: '快照',
  'run-task': '执行任务',
  'apply-site': '应用站点',
};

function machineName(id: string): string {
  return machines.value.find((machine) => machine.id === id)?.name ?? id;
}

function jobDuration(job: EdgeJob): string {
  const start = job.startedAt ?? job.createdAt;
  const end = job.finishedAt ?? (job.status === 'running' ? new Date().toISOString() : null);
  if (end === null) return '—';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  return Number.isFinite(ms) && ms >= 0 ? formatDuration(ms) : '—';
}

/* ------------------------------- refresh ------------------------------- */

async function refreshAll(): Promise<void> {
  refreshing.value = true;
  try {
    await Promise.all([
      machinesQuery.refetch(),
      keysQuery.refetch(),
      jobsQuery.refetch(),
    ]);
  } finally {
    refreshing.value = false;
  }
}

/* ------------------------------- key create ------------------------------- */

const keyModal = ref(false);
const keyName = ref('');
const keyGroup = ref('');
const keyTtl = ref(86400);
const keyMaxUses = ref(0);
const keyFormError = ref<string | null>(null);
const createdKey = ref<EdgeKeyCreateResult | null>(null);
const keySecretOpen = ref(false);

const ttlOptions = [
  { label: '1 小时', value: 3600 },
  { label: '1 天', value: 86400 },
  { label: '7 天', value: 604800 },
  { label: '30 天', value: 2592000 },
  { label: '不过期', value: 0 },
];

watch(keyModal, (show) => {
  if (!show) return;
  keyName.value = '';
  keyGroup.value = '';
  keyTtl.value = 86400;
  keyMaxUses.value = 0;
  keyFormError.value = null;
});

const createKeyAction = useAction(
  (input: { name: string; group?: string; ttlSec?: number; maxUses?: number }) =>
    createEdgeKey(input),
  {
    success: (result) => `已创建入网密钥 ${result.key.name}`,
    successDescription: 'secret 只显示一次，请立即保存。',
    invalidate: [coreKey('edge', 'keys')],
  },
);

async function submitKey(): Promise<void> {
  if (keyName.value.trim().length === 0) {
    keyFormError.value = '请填写密钥名称。';
    return;
  }
  keyFormError.value = null;
  const result = await createKeyAction.run({
    name: keyName.value.trim(),
    ...(keyGroup.value.trim().length > 0 ? { group: keyGroup.value.trim() } : {}),
    ...(keyTtl.value > 0 ? { ttlSec: keyTtl.value } : {}),
    ...(keyMaxUses.value > 0 ? { maxUses: keyMaxUses.value } : {}),
  });
  if (result !== undefined) {
    createdKey.value = result;
    keyModal.value = false;
    keySecretOpen.value = true;
  }
}

const enrolledCommand = computed(() => {
  const key = createdKey.value?.secret;
  if (key === undefined) return '';
  return [
    '# 在目标机器上使用 core 地址 + 入网密钥启动 agent',
    `export MPANEL_TRANSPORT=reverse-ws`,
    `export MPANEL_CORE_URL=${window.location.origin.replace(/^http/, 'ws')}`,
    `export MPANEL_EDGE_KEY=${key}`,
    'mpanel-agent serve',
  ].join('\n');
});

/* ------------------------------- key revoke ------------------------------- */

type KeyState = 'active' | 'revoked' | 'expired' | 'exhausted';

function keyState(key: EdgeKey): KeyState {
  if (key.revokedAt !== null) return 'revoked';
  if (key.expiresAt !== null && new Date(key.expiresAt).getTime() < Date.now()) return 'expired';
  if (key.maxUses > 0 && key.uses >= key.maxUses) return 'exhausted';
  return 'active';
}

function keyStateLabel(key: EdgeKey): string {
  return {
    active: '可用',
    revoked: '已吊销',
    expired: '已过期',
    exhausted: '已用尽',
  }[keyState(key)];
}

function keyStateType(key: EdgeKey): 'success' | 'default' | 'warning' | 'error' {
  return {
    active: 'success',
    revoked: 'default',
    expired: 'warning',
    exhausted: 'warning',
  }[keyState(key)] as 'success' | 'default' | 'warning' | 'error';
}

const revokeAction = useAction((key: EdgeKey) => revokeEdgeKey(key.id), {
  success: (_result, key) => `已吊销密钥 ${key.name}`,
  successDescription: '已入网节点不受影响。',
  invalidate: [coreKey('edge', 'keys')],
});

function confirmRevoke(key: EdgeKey): void {
  dialog.warning({
    title: '吊销入网密钥',
    content: `确定吊销“${key.name}”？已入网节点不受影响，新节点无法再使用该密钥。`,
    positiveText: '吊销',
    negativeText: '取消',
    onPositiveClick: () => {
      void revokeAction.run(key);
    },
  });
}

/* ------------------------------- job create ------------------------------- */

const jobModal = ref(false);
const jobMachineId = ref('');
const jobKind = ref<EdgeJobKind>('snapshot');
const jobTaskId = ref('');
const jobSiteId = ref('');
const jobFormError = ref<string | null>(null);

watch(jobModal, (show) => {
  if (!show) return;
  jobMachineId.value = edgeNodes.value[0]?.id ?? '';
  jobKind.value = 'snapshot';
  jobTaskId.value = '';
  jobSiteId.value = '';
  jobFormError.value = null;
});

const taskOptionsQuery = useQuery({
  queryKey: computed(() => coreKey('edge', 'target-tasks', jobMachineId.value)),
  queryFn: () => listEdgeTargetTasks(jobMachineId.value),
  enabled: computed(
    () => jobModal.value && jobKind.value === 'run-task' && jobMachineId.value.length > 0,
  ),
  retry: 0,
});

const siteOptionsQuery = useQuery({
  queryKey: computed(() => coreKey('edge', 'target-sites', jobMachineId.value)),
  queryFn: () => listEdgeTargetSites(jobMachineId.value),
  enabled: computed(
    () => jobModal.value && jobKind.value === 'apply-site' && jobMachineId.value.length > 0,
  ),
  retry: 0,
});

const taskOptions = computed(() => [
  ...(taskOptionsQuery.data.value?.items ?? []).map((task) => ({
    label: `${task.name}（${task.id}）`,
    value: task.id,
  })),
  ...(jobTaskId.value.length > 0 &&
  !(taskOptionsQuery.data.value?.items ?? []).some((task) => task.id === jobTaskId.value)
    ? [{ label: `手动 ID：${jobTaskId.value}`, value: jobTaskId.value }]
    : []),
]);

const siteOptions = computed(() => [
  ...(siteOptionsQuery.data.value?.items ?? []).map((site) => ({
    label: `${site.name}（${site.id}）`,
    value: site.id,
  })),
  ...(jobSiteId.value.length > 0 &&
  !(siteOptionsQuery.data.value?.items ?? []).some((site) => site.id === jobSiteId.value)
    ? [{ label: `手动 ID：${jobSiteId.value}`, value: jobSiteId.value }]
    : []),
]);

const jobKindOptions = [
  { label: '快照 · 刷新节点快照', value: 'snapshot' },
  { label: '执行任务 · 运行计划任务', value: 'run-task' },
  { label: '应用站点 · 应用 Caddy 站点', value: 'apply-site' },
];

const edgeMachineOptions = computed(() =>
  edgeNodes.value.map((machine) => ({
    label: `${machine.name}（${machine.status}）`,
    value: machine.id,
  })),
);

function jobPayload(): Record<string, unknown> {
  if (jobKind.value === 'run-task') return { taskId: jobTaskId.value.trim() };
  if (jobKind.value === 'apply-site') return { siteId: jobSiteId.value.trim() };
  return {};
}

const createJobAction = useAction(
  (input: { machineId: string; kind: EdgeJobKind; payload: Record<string, unknown> }) =>
    createEdgeJob(input),
  {
    success: (job) => `已创建「${jobKindLabel[job.kind]}」作业`,
    successDescription: '离线节点会保持 pending，上线后串行执行。',
    invalidate: [coreKey('edge', 'jobs')],
  },
);

async function submitJob(): Promise<void> {
  if (jobMachineId.value.length === 0) {
    jobFormError.value = '请选择目标边缘节点。';
    return;
  }
  if (jobKind.value === 'run-task' && jobTaskId.value.trim().length === 0) {
    jobFormError.value = '请选择任务或填写任务 ID。';
    return;
  }
  if (jobKind.value === 'apply-site' && jobSiteId.value.trim().length === 0) {
    jobFormError.value = '请选择站点或填写站点 ID。';
    return;
  }
  jobFormError.value = null;
  const created = await createJobAction.run({
    machineId: jobMachineId.value,
    kind: jobKind.value,
    payload: jobPayload(),
  });
  if (created !== undefined) {
    jobModal.value = false;
    selectedJob.value = created;
    jobDrawerOpen.value = true;
    void jobsQuery.refetch();
  }
}

/* ------------------------------- job detail ------------------------------- */

const jobDrawerOpen = ref(false);
const selectedJob = ref<EdgeJob | null>(null);

function showJob(job: EdgeJob): void {
  selectedJob.value = job;
  jobDrawerOpen.value = true;
}

const deleteJobAction = useAction((job: EdgeJob) => deleteEdgeJob(job.id), {
  success: '已删除待执行作业',
  successDescription: '只有 pending 作业可以删除。',
  invalidate: [coreKey('edge', 'jobs')],
});

function confirmDeleteJob(job: EdgeJob): void {
  dialog.warning({
    title: '删除作业',
    content: `确定删除该 ${jobKindLabel[job.kind]} 作业？只有 pending 作业可以删除。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: () => {
      void deleteJobAction.run(job);
    },
  });
}

const resultText = computed(() => {
  if (selectedJob.value === null) return '';
  return JSON.stringify(selectedJob.value.result ?? null, null, 2);
});
</script>

<template>
  <div class="page">
    <PageHeader
      title="边缘节点"
    >
      <template #actions>
        <n-button size="small" secondary :loading="refreshing" @click="refreshAll">
          <template #icon><n-icon :component="RefreshOutline" /></template>
          刷新
        </n-button>
        <n-button size="small" secondary @click="keyModal = true">
          <template #icon><n-icon :component="KeyOutline" /></template>
          新建密钥
        </n-button>
        <n-button size="small" type="primary" :disabled="edgeNodes.length === 0" @click="jobModal = true">
          <template #icon><n-icon :component="AddOutline" /></template>
          新建作业
        </n-button>
      </template>
    </PageHeader>

    <error-state
      v-if="machinesQuery.isError.value"
      :error="machinesQuery.error.value"
      @retry="machinesQuery.refetch()"
    />

    <n-tabs v-model:value="tab" type="line" animated>
      <n-tab-pane name="nodes" :tab="`节点 ${edgeNodes.length}`">
        <div v-if="edgeNodes.length === 0 && !machinesQuery.isLoading.value" class="edge-empty">
          <div class="flow">
            <div class="flow-step">
              <span class="flow-icon"><n-icon :component="KeyOutline" /></span>
              <span>创建密钥</span>
            </div>
            <span class="flow-arrow">→</span>
            <div class="flow-step">
              <span class="flow-icon"><n-icon :component="TerminalOutline" /></span>
              <span>启动 agent</span>
            </div>
            <span class="flow-arrow">→</span>
            <div class="flow-step">
              <span class="flow-icon"><n-icon :component="GitNetworkOutline" /></span>
              <span>节点上线</span>
            </div>
          </div>
          <n-button type="primary" size="large" @click="keyModal = true">
            <template #icon><n-icon :component="KeyOutline" /></template>
            创建入网密钥
          </n-button>
        </div>

        <n-card v-else size="small" :content-style="{ padding: '0' }">
          <n-table :single-line="false" size="small">
            <thead>
              <tr>
                <th style="min-width: 180px">节点</th>
                <th style="width: 120px">状态</th>
                <th style="min-width: 130px">分组 / 来源</th>
                <th style="min-width: 150px">最近心跳</th>
                <th style="min-width: 180px">快照</th>
                <th style="width: 220px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="node in edgeNodes" :key="node.id">
                <td>
                  <div class="cell">
                    <strong>{{ node.name }}</strong>
                    <span class="mono tiny muted">{{ node.id }}</span>
                  </div>
                </td>
                <td><MachineStatusTag :status="node.status" /></td>
                <td>
                  <div class="cell">
                    <span class="small">{{ node.group ?? '未分组' }}</span>
                    <span class="tiny muted">key {{ node.edgeKeyId ?? '—' }}</span>
                  </div>
                </td>
                <td>
                  <div class="cell">
                    <RelativeTime :value="node.lastSeenAt" />
                    <span v-if="node.worker" class="tiny muted">agent v{{ node.worker.version }}</span>
                  </div>
                </td>
                <td>
                  <div v-if="node.snapshot" class="cell">
                    <span class="tiny muted">{{ node.snapshot.hostname }} · {{ node.snapshot.platform }}/{{ node.snapshot.arch }}</span>
                    <span class="tiny muted">运行 {{ formatUptime(node.snapshot.uptimeSec) }}</span>
                  </div>
                  <span v-else class="tiny muted">尚未采集</span>
                </td>
                <td>
                  <div class="actions">
                    <n-button size="tiny" type="primary" secondary @click="openMachinePage(node.id, 'sites')">
                      <template #icon><n-icon :component="OpenOutline" /></template>
                      打开
                    </n-button>
                    <n-button size="tiny" secondary @click="jobMachineId = node.id; jobModal = true">
                      <template #icon><n-icon :component="AddOutline" /></template>
                      作业
                    </n-button>
                  </div>
                </td>
              </tr>
            </tbody>
          </n-table>
        </n-card>
      </n-tab-pane>

      <n-tab-pane name="keys" :tab="`入网密钥 ${keys.length}`">
        <n-card size="small">
          <div class="toolbar">
            <span class="small muted">共 {{ keys.length }} 个密钥 · 共享密钥让 agent 自助注册，secret 只在创建时显示。</span>
            <div class="spacer" />
            <n-button size="small" type="primary" @click="keyModal = true">
              <template #icon><n-icon :component="KeyOutline" /></template>
              新建密钥
            </n-button>
          </div>
          <error-state
            v-if="keysQuery.isError.value"
            :error="keysQuery.error.value"
            @retry="keysQuery.refetch()"
          />
          <n-empty v-else-if="keys.length === 0 && !keysQuery.isLoading.value" description="还没有入网密钥" />
          <n-table v-else :single-line="false" size="small" style="margin-top: 8px">
            <thead>
              <tr>
                <th style="min-width: 170px">名称 / 分组</th>
                <th style="width: 130px">使用次数</th>
                <th style="min-width: 140px">最后使用</th>
                <th style="min-width: 150px">过期时间</th>
                <th style="width: 100px">状态</th>
                <th style="width: 90px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="key in keys" :key="key.id">
                <td>
                  <div class="cell">
                    <strong>{{ key.name }}</strong>
                    <span class="tiny muted">{{ key.group ?? '未分组' }} · <code>{{ key.id }}</code></span>
                  </div>
                </td>
                <td>
                  <div class="cell">
                    <span>{{ key.uses }} / {{ key.maxUses === 0 ? '不限' : key.maxUses }}</span>
                    <span class="tiny muted">{{ key.maxUses === 0 ? '不限次数' : `剩余 ${Math.max(0, key.maxUses - key.uses)} 次` }}</span>
                  </div>
                </td>
                <td><RelativeTime :value="key.lastUsedAt" /></td>
                <td>
                  <div class="cell">
                    <span>{{ key.expiresAt === null ? '不过期' : formatDate(key.expiresAt) }}</span>
                    <RelativeTime v-if="key.expiresAt" :value="key.expiresAt" />
                  </div>
                </td>
                <td>
                  <n-tag size="tiny" :type="keyStateType(key)" round :bordered="false">
                    {{ keyStateLabel(key) }}
                  </n-tag>
                </td>
                <td>
                  <n-button
                    size="tiny"
                    quaternary
                    type="error"
                    :disabled="keyState(key) !== 'active'"
                    @click="confirmRevoke(key)"
                  >
                    <template #icon><n-icon :component="BanOutline" /></template>
                    吊销
                  </n-button>
                </td>
              </tr>
            </tbody>
          </n-table>
        </n-card>
      </n-tab-pane>

      <n-tab-pane name="jobs" :tab="`作业 ${pendingCount > 0 ? `${pendingCount} 待执行` : jobs.length}`">
        <n-card size="small">
          <div class="toolbar">
            <n-select v-model:value="jobMachineFilter" :options="machineOptions" style="width: 200px" />
            <n-select v-model:value="jobStatusFilter" :options="jobStatusOptions" style="width: 150px" />
            <div class="spacer" />
            <n-button size="small" secondary :loading="jobsQuery.isFetching.value" @click="jobsQuery.refetch()">
              <template #icon><n-icon :component="RefreshOutline" /></template>
              刷新
            </n-button>
            <n-button size="small" type="primary" :disabled="edgeNodes.length === 0" @click="jobModal = true">
              <template #icon><n-icon :component="AddOutline" /></template>
              新建作业
            </n-button>
          </div>
          <error-state
            v-if="jobsQuery.isError.value"
            :error="jobsQuery.error.value"
            @retry="jobsQuery.refetch()"
          />
          <n-empty v-else-if="jobs.length === 0 && !jobsQuery.isLoading.value" description="没有作业" />
          <n-table v-else :single-line="false" size="small" style="margin-top: 8px">
            <thead>
              <tr>
                <th style="width: 150px">类型</th>
                <th style="min-width: 160px">机器</th>
                <th style="width: 120px">状态</th>
                <th style="min-width: 150px">创建 / 耗时</th>
                <th style="width: 220px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="job in jobs" :key="job.id">
                <td>
                  <div class="cell">
                    <n-tag size="tiny" round :bordered="false">{{ jobKindLabel[job.kind] }}</n-tag>
                    <span class="tiny muted mono">
                      {{ job.payload.taskId ?? job.payload.siteId ?? job.id }}
                    </span>
                  </div>
                </td>
                <td>
                  <div class="cell">
                    <span>{{ machineName(job.machineId) }}</span>
                    <span class="tiny muted mono">{{ job.machineId }}</span>
                  </div>
                </td>
                <td>
                  <div class="cell">
                    <n-tag size="tiny" :type="edgeJobStatusType(job.status)" round :bordered="false">
                      {{ edgeJobStatusLabel(job.status) }}
                    </n-tag>
                    <span class="tiny muted">HTTP {{ job.httpStatus ?? '—' }}</span>
                  </div>
                </td>
                <td>
                  <div class="cell">
                    <span class="small">{{ formatDate(job.createdAt) }}</span>
                    <span class="tiny muted">{{ jobDuration(job) }}</span>
                  </div>
                </td>
                <td>
                  <div class="actions">
                    <n-button size="tiny" quaternary @click="showJob(job)">
                      <template #icon><n-icon :component="EyeOutline" /></template>
                      结果
                    </n-button>
                    <n-button
                      size="tiny"
                      quaternary
                      type="error"
                      :disabled="job.status !== 'pending'"
                      @click="confirmDeleteJob(job)"
                    >
                      <template #icon><n-icon :component="TrashOutline" /></template>
                    </n-button>
                  </div>
                </td>
              </tr>
            </tbody>
          </n-table>
        </n-card>
      </n-tab-pane>
    </n-tabs>

    <!-- 创建密钥 -->
    <n-modal
      v-model:show="keyModal"
      preset="card"
      title="新建入网密钥"
      style="width: 620px; max-width: calc(100vw - 24px)"
    >
      <div class="form">
        <n-form-item label="名称" required>
          <n-input v-model:value="keyName" placeholder="例如：华东 NAT 节点" />
        </n-form-item>
        <n-form-item label="分组（可选）">
          <n-input v-model:value="keyGroup" placeholder="例如：edge-hk" />
        </n-form-item>
        <div class="two">
          <n-form-item label="有效期">
            <n-select v-model:value="keyTtl" :options="ttlOptions" />
          </n-form-item>
          <n-form-item label="最大使用次数">
            <n-input-number v-model:value="keyMaxUses" :min="0" :step="1" style="width: 100%" />
          </n-form-item>
        </div>
        <n-alert v-if="keyFormError" type="error" :bordered="true">{{ keyFormError }}</n-alert>
      </div>
      <template #footer>
        <div class="toolbar" style="justify-content: flex-end">
          <n-button quaternary @click="keyModal = false">取消</n-button>
          <n-button type="primary" :loading="createKeyAction.pending.value" @click="submitKey">创建</n-button>
        </div>
      </template>
    </n-modal>

    <!-- 密钥 secret -->
    <n-modal
      v-model:show="keySecretOpen"
      preset="card"
      title="入网密钥 secret（只显示一次）"
      style="width: 660px; max-width: calc(100vw - 24px)"
    >
      <div v-if="createdKey" class="form">
        <n-alert type="warning" :bordered="true" title="请立即保存">
          secret 关闭后无法再次查看；只能吊销并重新创建。
        </n-alert>
        <div class="field">
          <span class="tiny muted">secret</span>
          <SecretReveal :value="createdKey.secret" />
        </div>
        <div class="field">
          <span class="tiny muted">agent 启动示例</span>
          <code-block :text="enrolledCommand" max-height="180px" />
        </div>
      </div>
      <template #footer>
        <div class="toolbar" style="justify-content: flex-end">
          <n-button type="primary" @click="keySecretOpen = false">我已保存</n-button>
        </div>
      </template>
    </n-modal>

    <!-- 创建作业 -->
    <n-modal
      v-model:show="jobModal"
      preset="card"
      title="新建边缘作业"
      style="width: 640px; max-width: calc(100vw - 24px)"
    >
      <div class="form">
        <n-alert v-if="edgeNodes.length === 0" type="warning" :bordered="true" title="没有可选的边缘节点">
          请先创建入网密钥并让 agent 接入。
        </n-alert>
        <n-form-item label="目标机器" required>
          <n-select v-model:value="jobMachineId" :options="edgeMachineOptions" :disabled="edgeNodes.length === 0" />
        </n-form-item>
        <n-form-item label="作业类型" required>
          <n-select v-model:value="jobKind" :options="jobKindOptions" @update:value="jobTaskId = ''; jobSiteId = ''" />
        </n-form-item>
        <n-alert v-if="jobKind === 'snapshot'" type="info" :bordered="true" title="快照作业">
          执行时调用目标节点的 GET /system/snapshot，并刷新 core 上的节点快照。
        </n-alert>
        <n-form-item v-if="jobKind === 'run-task'" label="任务" required>
          <n-select
            v-model:value="jobTaskId"
            filterable
            tag
            :options="taskOptions"
            :loading="taskOptionsQuery.isLoading.value"
            placeholder="选择任务或输入任务 ID"
          />
        </n-form-item>
        <n-form-item v-if="jobKind === 'apply-site'" label="站点" required>
          <n-select
            v-model:value="jobSiteId"
            filterable
            tag
            :options="siteOptions"
            :loading="siteOptionsQuery.isLoading.value"
            placeholder="选择站点或输入站点 ID"
          />
        </n-form-item>
        <n-alert v-if="jobFormError" type="error" :bordered="true">{{ jobFormError }}</n-alert>
      </div>
      <template #footer>
        <div class="toolbar" style="justify-content: flex-end">
          <n-button quaternary @click="jobModal = false">取消</n-button>
          <n-button type="primary" :loading="createJobAction.pending.value" :disabled="edgeNodes.length === 0" @click="submitJob">
            创建作业
          </n-button>
        </div>
      </template>
    </n-modal>

    <!-- 作业结果 -->
    <n-drawer v-model:show="jobDrawerOpen" :width="620" placement="right">
      <n-drawer-content title="边缘作业结果" closable>
        <div v-if="selectedJob" class="form">
          <div class="kv">
            <dt>类型</dt><dd>{{ jobKindLabel[selectedJob.kind] }}</dd>
            <dt>机器</dt><dd>{{ machineName(selectedJob.machineId) }} · <code>{{ selectedJob.machineId }}</code></dd>
            <dt>状态</dt><dd><n-tag size="small" :type="edgeJobStatusType(selectedJob.status)" :bordered="false">{{ edgeJobStatusLabel(selectedJob.status) }}</n-tag></dd>
            <dt>HTTP</dt><dd>{{ selectedJob.httpStatus ?? '—' }}</dd>
            <dt>创建</dt><dd>{{ formatDate(selectedJob.createdAt) }}</dd>
            <dt>开始</dt><dd>{{ formatDate(selectedJob.startedAt) }}</dd>
            <dt>结束</dt><dd>{{ formatDate(selectedJob.finishedAt) }}</dd>
            <dt>耗时</dt><dd>{{ jobDuration(selectedJob) }}</dd>
            <dt>作业 ID</dt><dd class="mono">{{ selectedJob.id }}</dd>
          </div>
          <div class="field">
            <span class="tiny muted">payload</span>
            <code-block :text="JSON.stringify(selectedJob.payload, null, 2)" max-height="140px" />
          </div>
          <n-alert v-if="selectedJob.error" type="error" :bordered="true" title="错误">
            {{ selectedJob.error }}
          </n-alert>
          <div class="field">
            <span class="tiny muted">result</span>
            <code-block :text="resultText" max-height="360px" />
          </div>
        </div>
      </n-drawer-content>
    </n-drawer>
  </div>
</template>

<style scoped>
.cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.edge-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 32px;
  min-height: calc(100vh - 320px);
  padding: 24px 16px;
}
.flow {
  display: flex;
  align-items: center;
  gap: 18px;
  flex-wrap: wrap;
  justify-content: center;
}
.flow-step {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: var(--mpanel-muted);
}
.flow-icon {
  display: grid;
  place-items: center;
  width: 54px;
  height: 54px;
  border-radius: 16px;
  background: var(--mpanel-surface-soft);
  border: 1px solid var(--mpanel-border);
  color: var(--mpanel-accent);
  font-size: 24px;
}
.flow-arrow {
  color: var(--mpanel-border);
  font-size: 20px;
}
</style>
