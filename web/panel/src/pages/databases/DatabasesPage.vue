<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import {
  NAlert,
  NButton,
  NCard,
  NCheckbox,
  NEmpty,
  NFormItem,
  NIcon,
  NInput,
  NModal,
  NSelect,
  NSpin,
  NTabPane,
  NTabs,
  NTable,
  NTag,
  useDialog,
  useMessage,
} from 'naive-ui';
import {
  AddOutline,
  LayersOutline,
  CreateOutline,
  OpenOutline,
  PlayOutline,
  RefreshOutline,
  TrashOutline,
  CloudDownloadOutline,
} from '@vicons/ionicons5';
import type {
  BackupFormat,
  BackupRecord,
  DatabaseProfile,
  DatabaseProfileCreateInput,
  DatabaseProfileUpdateInput,
  HandoffTicket,
} from '@/api/types';
import { useMachineApi } from '@/lib/api';
import { machineKey } from '@/lib/query-keys';
import { useAction } from '@/composables/use-action';
import { formatBytes, formatDate, formatDuration, formatPercent } from '@/lib/format';
import { getRuntimeConfig } from '@/lib/runtime-config';
import { buildHandoffFrameUrl, resolveRedeemUrl } from '@/lib/paths';
import { downloadFrom } from '@/lib/download';
import { describeError } from '@/api/errors';
import PageHeader from '@/components/common/PageHeader.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import RelativeTime from '@/components/common/RelativeTime.vue';
import StatusTag from '@/components/common/StatusTag.vue';
import SecretReveal from '@/components/common/SecretReveal.vue';

const route = useRoute();
const dialog = useDialog();
const message = useMessage();
const machineId = String(route.params.machineId ?? '');
const api = useMachineApi(machineId);

const fixedKind =
  route.query.kind === 'postgres' || route.query.kind === 'redis' ? route.query.kind : null;
const pageTitle = fixedKind === 'postgres' ? 'PostgreSQL' : fixedKind === 'redis' ? 'Redis' : '数据库';
const search = ref('');
const kindFilter = ref<'all' | 'postgres' | 'redis'>(fixedKind ?? 'all');
const selectedId = ref<string | null>(null);
const tab = ref('overview');

const profilesQuery = useQuery({
  queryKey: computed(() => machineKey(machineId, 'databases', 'profiles', { limit: 200 })),
  queryFn: () => api.value.databases.list({ limit: 200 }),
  staleTime: 15_000,
});

const profiles = computed(() => profilesQuery.data.value?.items ?? []);
const profilesAvailable = computed(() => profilesQuery.data.value?.available !== false);
const filtered = computed(() => {
  const needle = search.value.trim().toLowerCase();
  return profiles.value.filter((profile) => {
    if (kindFilter.value !== 'all' && profile.kind !== kindFilter.value) return false;
    if (needle.length === 0) return true;
    return (
      profile.name.toLowerCase().includes(needle) ||
      profile.host.toLowerCase().includes(needle) ||
      (profile.database ?? '').toLowerCase().includes(needle)
    );
  });
});

watch(
  [profiles, filtered],
  () => {
    if (profiles.value.length === 0) {
      selectedId.value = null;
      return;
    }
    if (selectedId.value === null || !filtered.value.some((item) => item.id === selectedId.value)) {
      selectedId.value = filtered.value[0]?.id ?? null;
    }
  },
  { immediate: true },
);

const selected = computed(() => profiles.value.find((profile) => profile.id === selectedId.value) ?? null);

watch(selectedId, () => {
  tab.value = 'overview';
  ticket.value = null;
});

const pgCount = computed(() => profiles.value.filter((p) => p.kind === 'postgres').length);
const redisCount = computed(() => profiles.value.filter((p) => p.kind === 'redis').length);
const failedCount = computed(
  () => profiles.value.filter((p) => p.lastCheck !== null && !p.lastCheck.ok).length,
);
const pageEmpty = computed(
  () =>
    !profilesQuery.isLoading.value &&
    (profiles.value.length === 0 ||
      (fixedKind !== null && search.value.trim().length === 0 && filtered.value.length === 0)),
);
const emptyDescription = computed(() =>
  fixedKind !== null ? `还没有 ${pageTitle} 档案` : '还没有数据库档案',
);

/* ------------------------------- profile form ------------------------------- */

const formOpen = ref(false);
const editing = ref<DatabaseProfile | null>(null);
const form = reactive({
  name: '',
  kind: 'postgres' as 'postgres' | 'redis',
  host: '',
  port: '5432',
  username: '',
  password: '',
  database: '',
  redisDb: '0',
  tls: false,
  clearPassword: false,
});
const formError = ref<string | null>(null);

watch(
  () => form.kind,
  (kind) => {
    if (editing.value !== null) return;
    form.port = kind === 'redis' ? '6379' : '5432';
  },
);

function openCreate(): void {
  editing.value = null;
  form.name = '';
  form.kind = fixedKind ?? 'postgres';
  form.host = '';
  form.port = form.kind === 'redis' ? '6379' : '5432';
  form.username = '';
  form.password = '';
  form.database = '';
  form.redisDb = '0';
  form.tls = false;
  form.clearPassword = false;
  formError.value = null;
  formOpen.value = true;
}

function openEdit(profile: DatabaseProfile): void {
  editing.value = profile;
  form.name = profile.name;
  form.kind = profile.kind;
  form.host = profile.host;
  form.port = String(profile.port);
  form.username = profile.username ?? '';
  form.password = '';
  form.database = profile.database ?? '';
  form.redisDb = String(profile.redisDb ?? 0);
  form.tls = profile.tls;
  form.clearPassword = false;
  formError.value = null;
  formOpen.value = true;
}

function validateForm(): string | null {
  if (form.name.trim().length === 0) return '请输入档案名称。';
  if (form.host.trim().length === 0) return '请输入主机地址。';
  const port = Number(form.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return '端口需为 1–65535 的整数。';
  if (form.kind === 'redis') {
    const db = Number(form.redisDb);
    if (!Number.isInteger(db) || db < 0 || db > 15) return 'Redis DB 需为 0–15 的整数。';
  }
  return null;
}

const saveAction = useAction(async () => {
  if (editing.value === null) {
    const input: DatabaseProfileCreateInput = {
      name: form.name.trim(),
      kind: form.kind,
      host: form.host.trim(),
      port: Number(form.port),
      tls: form.tls,
    };
    if (form.username.trim().length > 0) input.username = form.username.trim();
    if (form.password.length > 0) input.password = form.password;
    if (form.kind === 'postgres' && form.database.trim().length > 0) input.database = form.database.trim();
    if (form.kind === 'redis') input.redisDb = Number(form.redisDb);
    return api.value.databases.create(input);
  }
  const input: DatabaseProfileUpdateInput = {
    name: form.name.trim(),
    host: form.host.trim(),
    port: Number(form.port),
    username: form.username.trim().length > 0 ? form.username.trim() : null,
    tls: form.tls,
    database: form.kind === 'postgres' ? (form.database.trim() || null) : null,
    redisDb: form.kind === 'redis' ? Number(form.redisDb) : null,
  };
  if (form.clearPassword) input.password = null;
  else if (form.password.length > 0) input.password = form.password;
  return api.value.databases.update(editing.value.id, input);
}, {
  success: (profile) => `已保存数据库档案 ${profile.name}`,
  successDescription: '密码只写不读；建议保存后重新测试连接。',
  invalidate: [machineKey(machineId, 'databases')],
});

async function saveProfile(): Promise<void> {
  const problem = validateForm();
  if (problem !== null) {
    formError.value = problem;
    return;
  }
  formError.value = null;
  const saved = await saveAction.run();
  if (saved !== undefined) {
    formOpen.value = false;
    selectedId.value = saved.id;
  }
}

const testAction = useAction((profile: DatabaseProfile) => api.value.databases.test(profile.id), {
  success: (result, profile) =>
    result.ok
      ? `${profile.name} 连接正常 · ${result.latencyMs} ms`
      : `${profile.name} 连接失败 · ${result.message ?? '目标不可达'}`,
  invalidate: [machineKey(machineId, 'databases')],
});

const deleteAction = useAction((profile: DatabaseProfile) => api.value.databases.delete(profile.id), {
  success: (_result, profile) => `已删除档案 ${profile.name}`,
  successDescription: '备份文件会保留。',
  invalidate: [machineKey(machineId, 'databases')],
});

function confirmDelete(profile: DatabaseProfile): void {
  dialog.warning({
    title: '删除数据库档案',
    content: `确定删除“${profile.name}”？备份文件会保留；运行中的作业会阻止删除。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: () => {
      void deleteAction.run(profile);
    },
  });
}

/* ------------------------------- stats ------------------------------- */

const statsQuery = useQuery({
  queryKey: computed(() => machineKey(machineId, 'databases', 'stats', selectedId.value ?? 'none')),
  queryFn: () => api.value.databases.stats(selectedId.value!),
  enabled: computed(() => selectedId.value !== null && tab.value === 'stats'),
  retry: 0,
});

const stats = computed(() => statsQuery.data.value);

/* ------------------------------- backups ------------------------------- */

const backupsQuery = useQuery({
  queryKey: computed(() => machineKey(machineId, 'databases', 'backups', selectedId.value ?? 'none', { limit: 50 })),
  queryFn: () => api.value.databases.listBackups(selectedId.value!, { limit: 50 }),
  enabled: computed(() => selectedId.value !== null && tab.value === 'backups'),
  retry: 0,
  refetchInterval: computed(() => (tab.value === 'backups' ? 3_000 : false)),
});

const backups = computed(() => backupsQuery.data.value?.items ?? []);

const backupOpen = ref(false);
const backupFormat = ref<BackupFormat>('custom');
const backupLabel = ref('');

const backupFormats = computed<{ label: string; value: BackupFormat }[]>(() =>
  selected.value?.kind === 'redis'
    ? [
        { label: 'rdb · Redis 快照', value: 'rdb' },
        { label: 'logical · 逻辑导出', value: 'logical' },
      ]
    : [
        { label: 'custom · pg_dump 自定义格式', value: 'custom' },
        { label: 'plain · SQL 文本', value: 'plain' },
      ],
);

watch(selected, () => {
  backupFormat.value = selected.value?.kind === 'redis' ? 'rdb' : 'custom';
});

const createBackupAction = useAction(
  () => api.value.databases.createBackup(selectedId.value!, { format: backupFormat.value, label: backupLabel.value.trim() || undefined }),
  {
    success: '备份已排队',
    successDescription: '任务异步执行；列表会自动刷新状态。',
    invalidate: [machineKey(machineId, 'databases')],
  },
);

async function createBackup(): Promise<void> {
  const result = await createBackupAction.run();
  if (result !== undefined) {
    backupOpen.value = false;
    backupLabel.value = '';
    void backupsQuery.refetch();
  }
}

const restoreAction = useAction(
  (backup: BackupRecord) => api.value.databases.restore(selectedId.value!, { backupId: backup.id, confirm: true }),
  {
    success: '恢复任务已排队',
    successDescription: '恢复期间请勿对同一数据库执行其它写操作。',
    invalidate: [machineKey(machineId, 'databases')],
  },
);

function confirmRestore(backup: BackupRecord): void {
  dialog.error({
    title: '恢复数据库（危险操作）',
    content: `将使用备份“${backup.label ?? backup.fileName}”覆盖当前数据库。该操作不可撤销，确定继续？`,
    positiveText: '确认恢复',
    negativeText: '取消',
    onPositiveClick: () => {
      void restoreAction.run(backup);
    },
  });
}

const deleteBackupAction = useAction((backup: BackupRecord) => api.value.databases.deleteBackup(backup.id), {
  success: '备份已删除',
  invalidate: [machineKey(machineId, 'databases')],
});

function confirmDeleteBackup(backup: BackupRecord): void {
  dialog.warning({
    title: '删除备份',
    content: `确定删除备份“${backup.label ?? backup.fileName}”？`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: () => {
      void deleteBackupAction.run(backup);
    },
  });
}

const downloadingId = ref<string | null>(null);
async function downloadBackup(backup: BackupRecord): Promise<void> {
  downloadingId.value = backup.id;
  try {
    await downloadFrom(api.value, api.value.databases.backupDownloadUrl(backup.id), backup.fileName);
  } catch (error) {
    message.error(describeError(error).description);
  } finally {
    downloadingId.value = null;
  }
}

/* ------------------------------- handoff / dbx ------------------------------- */

const ticket = ref<HandoffTicket | null>(null);
const handoffAction = useAction(() => api.value.databases.handoff(selectedId.value!), {
  success: '已生成一次性 dbx 票据',
  successDescription: '票据只能兑换一次，密码只在兑换时返回。',
});

const dbxUrl = computed(() => (getRuntimeConfig().dbxUrl ?? '').trim());
const dbxConfigured = computed(() => dbxUrl.value.length > 0);

const frameUrl = computed(() => {
  if (ticket.value === null || !dbxConfigured.value) return '';
  const endpoint = resolveRedeemUrl(ticket.value.redeemUrl, api.value.baseUrl);
  return buildHandoffFrameUrl(dbxUrl.value, endpoint, ticket.value.ticket);
});

async function openDbx(): Promise<void> {
  const result = await handoffAction.run();
  if (result !== undefined) ticket.value = result;
}

function engineLabel(kind: 'postgres' | 'redis'): string {
  return kind === 'postgres' ? 'PostgreSQL' : 'Redis';
}
</script>

<template>
  <div class="page">
    <PageHeader :title="pageTitle">
      <template #meta>
        <n-tag v-if="fixedKind === null" size="small" round :bordered="false">PostgreSQL {{ pgCount }}</n-tag>
        <n-tag v-if="fixedKind === null" size="small" round :bordered="false">Redis {{ redisCount }}</n-tag>
        <n-tag v-if="failedCount > 0" size="small" type="error" round :bordered="false">
          {{ failedCount }} 个测试失败
        </n-tag>
      </template>
      <template #actions>
        <n-button size="small" secondary :loading="profilesQuery.isFetching.value" @click="profilesQuery.refetch()">
          <template #icon><n-icon :component="RefreshOutline" /></template>
          刷新
        </n-button>
        <n-button size="small" type="primary" :disabled="!profilesAvailable" @click="openCreate">
          <template #icon><n-icon :component="AddOutline" /></template>
          新建档案
        </n-button>
      </template>
    </PageHeader>

    <n-alert v-if="profilesQuery.data.value?.available === false" type="warning" :bordered="true" title="数据库档案存储不可用">
      {{ profilesQuery.data.value.reason ?? '服务返回不可用。' }}
    </n-alert>

    <error-state v-if="profilesQuery.isError.value" :error="profilesQuery.error.value" @retry="profilesQuery.refetch()" />

    <n-empty v-if="pageEmpty" :description="emptyDescription">
      <template #icon><n-icon :component="LayersOutline" size="36" /></template>
      <template #extra>
        <n-button type="primary" :disabled="!profilesAvailable" @click="openCreate">新建档案</n-button>
      </template>
    </n-empty>

    <div v-else class="db-layout">
      <n-card size="small" class="list-card">
        <div class="toolbar" style="margin-bottom: 8px">
          <n-input v-model:value="search" size="small" placeholder="搜索档案…" clearable />
          <n-select
            v-if="fixedKind === null"
            v-model:value="kindFilter"
            size="small"
            style="width: 120px"
            :options="[
              { label: '全部', value: 'all' },
              { label: 'PostgreSQL', value: 'postgres' },
              { label: 'Redis', value: 'redis' },
            ]"
          />
        </div>
        <n-empty v-if="filtered.length === 0" description="没有匹配的档案" size="small" />
        <div v-else class="profile-list">
          <button
            v-for="profile in filtered"
            :key="profile.id"
            type="button"
            class="profile-item"
            :class="{ active: profile.id === selectedId }"
            @click="selectedId = profile.id"
          >
            <div class="profile-main">
              <div class="profile-title">
                <n-tag size="tiny" :bordered="false" :type="profile.kind === 'postgres' ? 'info' : 'warning'">
                  {{ engineLabel(profile.kind) }}
                </n-tag>
                <strong class="truncate">{{ profile.name }}</strong>
              </div>
              <div class="tiny muted mono truncate">{{ profile.host }}:{{ profile.port }}</div>
              <div class="tiny muted">
                <StatusTag
                  v-if="profile.lastCheck"
                  :label="profile.lastCheck.ok ? `正常 ${profile.lastCheck.latencyMs}ms` : '失败'"
                  :type="profile.lastCheck.ok ? 'success' : 'error'"
                />
                <span v-else>未测试</span>
              </div>
            </div>
          </button>
        </div>
      </n-card>

      <n-card size="small" class="detail-card">
        <n-empty v-if="selected === null" description="选择或创建一个数据库档案" />
        <template v-else>
          <div class="detail-head">
            <div>
              <div class="toolbar">
                <strong>{{ selected.name }}</strong>
                <n-tag size="tiny" :bordered="false" :type="selected.kind === 'postgres' ? 'info' : 'warning'">
                  {{ engineLabel(selected.kind) }}
                </n-tag>
                <n-tag v-if="selected.tls" size="tiny" :bordered="false" type="success">TLS</n-tag>
              </div>
              <div class="tiny muted mono">{{ selected.host }}:{{ selected.port }}<template v-if="selected.database"> / {{ selected.database }}</template></div>
            </div>
            <div class="toolbar">
              <n-button size="tiny" secondary :loading="testAction.pending.value" @click="testAction.run(selected)">
                <template #icon><n-icon :component="PlayOutline" /></template>
                测试
              </n-button>
              <n-button size="tiny" quaternary @click="openEdit(selected)">
                <template #icon><n-icon :component="CreateOutline" /></template>
                编辑
              </n-button>
              <n-button size="tiny" quaternary type="error" @click="confirmDelete(selected)">
                <template #icon><n-icon :component="TrashOutline" /></template>
              </n-button>
            </div>
          </div>

          <n-tabs v-model:value="tab" type="segment" animated>
            <n-tab-pane name="overview" tab="概览">
              <div class="kv">
                <dt>ID</dt><dd class="mono">{{ selected.id }}</dd>
                <dt>用户名</dt><dd>{{ selected.username ?? '—' }}</dd>
                <dt>数据库</dt><dd>{{ selected.kind === 'postgres' ? (selected.database ?? '默认') : `db ${selected.redisDb ?? 0}` }}</dd>
                <dt>密码</dt><dd>{{ selected.hasPassword ? '已保存（不可读）' : '未设置' }}</dd>
                <dt>最近测试</dt>
                <dd>
                  <template v-if="selected.lastCheck">
                    <StatusTag :label="selected.lastCheck.ok ? '成功' : '失败'" :type="selected.lastCheck.ok ? 'success' : 'error'" />
                    {{ selected.lastCheck.latencyMs }} ms · {{ formatDate(selected.lastCheck.at) }}
                    <div v-if="selected.lastCheck.serverVersion" class="tiny muted">版本 {{ selected.lastCheck.serverVersion }}</div>
                    <div v-if="selected.lastCheck.message" class="tiny error-text">{{ selected.lastCheck.message }}</div>
                  </template>
                  <span v-else class="muted">未测试</span>
                </dd>
                <dt>创建 / 更新</dt><dd>{{ formatDate(selected.createdAt) }} / {{ formatDate(selected.updatedAt) }}</dd>
              </div>
            </n-tab-pane>

            <n-tab-pane name="stats" tab="统计">
              <div class="toolbar" style="margin-bottom: 8px">
                <span class="small muted">实时统计来自目标数据库；不可达时返回 UPSTREAM_ERROR。</span>
                <div class="spacer" />
                <n-button size="tiny" secondary :loading="statsQuery.isFetching.value" @click="statsQuery.refetch()">刷新</n-button>
              </div>
              <error-state v-if="statsQuery.isError.value" :error="statsQuery.error.value" @retry="statsQuery.refetch()" />
              <n-spin v-else-if="statsQuery.isLoading.value" size="small" />
              <div v-else-if="stats" class="kv">
                <dt>版本</dt><dd>{{ stats.version }}</dd>
                <dt>运行时长</dt><dd>{{ formatDuration(stats.uptimeSec * 1000) }}</dd>
                <template v-if="stats.kind === 'postgres'">
                  <dt>连接数</dt><dd>总 {{ stats.connections.total }} · 活跃 {{ stats.connections.active }} · 空闲 {{ stats.connections.idle }} · 事务中空闲 {{ stats.connections.idleInTransaction }}</dd>
                  <dt>数据库大小</dt><dd>{{ formatBytes(stats.databaseSizeBytes) }}</dd>
                  <dt>缓存命中</dt><dd>{{ stats.cacheHitRatio === null ? '—' : formatPercent(stats.cacheHitRatio * 100) }}</dd>
                </template>
                <template v-else>
                  <dt>角色</dt><dd>{{ stats.role }}</dd>
                  <dt>客户端</dt><dd>{{ stats.connectedClients }}</dd>
                  <dt>内存</dt><dd>{{ formatBytes(stats.usedMemoryBytes) }}<template v-if="stats.maxMemoryBytes"> / {{ formatBytes(stats.maxMemoryBytes) }}</template></dd>
                  <dt>Ops/s</dt><dd>{{ stats.opsPerSec ?? '—' }}</dd>
                  <dt>Keyspace</dt><dd>{{ stats.keyspace.map((k) => `db${k.db}: ${k.keys} keys`).join(' · ') || '—' }}</dd>
                </template>
              </div>
            </n-tab-pane>

            <n-tab-pane name="backups" tab="备份">
              <div class="toolbar" style="margin-bottom: 8px">
                <n-button size="small" type="primary" @click="backupOpen = true">创建备份</n-button>
                <n-button size="small" secondary :loading="backupsQuery.isFetching.value" @click="backupsQuery.refetch()">刷新</n-button>
                <div class="spacer" />
                <span class="small muted">共 {{ backups.length }} 个备份</span>
              </div>
              <error-state v-if="backupsQuery.isError.value" :error="backupsQuery.error.value" @retry="backupsQuery.refetch()" />
              <n-empty v-else-if="backups.length === 0" description="还没有备份" size="small" />
              <n-table v-else :single-line="false" size="small">
                <thead>
                  <tr>
                    <th style="min-width: 170px">备份</th>
                    <th style="width: 100px">格式</th>
                    <th style="width: 100px">大小</th>
                    <th style="width: 100px">状态</th>
                    <th style="min-width: 150px">创建</th>
                    <th style="width: 180px">操作</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="backup in backups" :key="backup.id">
                    <td>
                      <div class="cell">
                        <span class="small">{{ backup.label ?? backup.fileName }}</span>
                        <span class="tiny muted">{{ backup.fileName }}</span>
                      </div>
                    </td>
                    <td class="small">{{ backup.format }}</td>
                    <td class="small">{{ formatBytes(backup.sizeBytes) }}</td>
                    <td>
                      <StatusTag
                        :label="backup.status"
                        :type="backup.status === 'success' ? 'success' : backup.status === 'failed' ? 'error' : 'warning'"
                      />
                    </td>
                    <td><RelativeTime :value="backup.createdAt" /></td>
                    <td>
                      <div class="actions">
                        <n-button size="tiny" secondary :disabled="backup.status !== 'success'" @click="confirmRestore(backup)">恢复</n-button>
                        <n-button size="tiny" quaternary :loading="downloadingId === backup.id" @click="downloadBackup(backup)">
                          <template #icon><n-icon :component="CloudDownloadOutline" /></template>
                        </n-button>
                        <n-button size="tiny" quaternary type="error" @click="confirmDeleteBackup(backup)">
                          <template #icon><n-icon :component="TrashOutline" /></template>
                        </n-button>
                      </div>
                    </td>
                  </tr>
                </tbody>
              </n-table>
            </n-tab-pane>

            <n-tab-pane name="dbx" tab="dbx 查询">
              <n-alert v-if="!dbxConfigured" type="warning" :bordered="true" title="dbx 未配置">
                设置 VITE_DBX_URL 或 config.json 的 dbxUrl 后可在此嵌入 dbx 查询控制台；
                档案、统计与备份不受影响。
              </n-alert>
              <template v-else>
                <div class="toolbar" style="margin-bottom: 10px">
                  <n-button size="small" type="primary" :loading="handoffAction.pending.value" @click="openDbx">
                    <template #icon><n-icon :component="OpenOutline" /></template>
                    生成一次性票据并打开 dbx
                  </n-button>
                  <span v-if="ticket" class="tiny muted">票据有效期至 {{ formatDate(ticket.expiresAt) }}</span>
                </div>
                <n-alert v-if="ticket" type="info" :bordered="false" title="票据已放入 iframe URL fragment">
                  密码只在 dbx 兑换票据时返回；票据只能使用一次。
                </n-alert>
                <iframe
                  v-if="frameUrl"
                  :src="frameUrl"
                  class="dbx-frame"
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
                  referrerpolicy="no-referrer"
                />
              </template>
            </n-tab-pane>
          </n-tabs>
        </template>
      </n-card>
    </div>

    <n-modal v-model:show="formOpen" preset="card" :title="editing ? `编辑档案 · ${editing.name}` : '新建数据库档案'" style="width: 620px; max-width: calc(100vw - 24px)">
      <div class="form">
        <div class="two">
          <n-form-item label="名称" required>
            <n-input v-model:value="form.name" placeholder="例如：生产 PG" />
          </n-form-item>
          <n-form-item label="类型">
            <n-select
              v-model:value="form.kind"
              :disabled="editing !== null"
              :options="[
                { label: 'PostgreSQL', value: 'postgres' },
                { label: 'Redis', value: 'redis' },
              ]"
            />
          </n-form-item>
        </div>
        <div class="two">
          <n-form-item label="主机" required>
            <n-input v-model:value="form.host" placeholder="127.0.0.1" class="mono" />
          </n-form-item>
          <n-form-item label="端口" required>
            <n-input v-model:value="form.port" class="mono" />
          </n-form-item>
        </div>
        <div class="two">
          <n-form-item label="用户名">
            <n-input v-model:value="form.username" placeholder="postgres" class="mono" />
          </n-form-item>
          <n-form-item label="密码">
            <n-input v-model:value="form.password" type="password" show-password-on="click" :placeholder="editing?.hasPassword ? '留空保持不变' : '可留空'" />
          </n-form-item>
        </div>
        <n-form-item v-if="form.kind === 'postgres'" label="数据库">
          <n-input v-model:value="form.database" placeholder="默认数据库" class="mono" />
        </n-form-item>
        <n-form-item v-else label="Redis DB">
          <n-input v-model:value="form.redisDb" class="mono" />
        </n-form-item>
        <div class="toolbar">
          <n-checkbox v-model:checked="form.tls">TLS</n-checkbox>
          <n-checkbox v-if="editing?.hasPassword" v-model:checked="form.clearPassword">清除已保存密码</n-checkbox>
        </div>
        <n-alert v-if="formError" type="error" :bordered="true">{{ formError }}</n-alert>
      </div>
      <template #footer>
        <div class="toolbar" style="justify-content: flex-end">
          <n-button quaternary @click="formOpen = false">取消</n-button>
          <n-button type="primary" :loading="saveAction.pending.value" @click="saveProfile">保存</n-button>
        </div>
      </template>
    </n-modal>

    <n-modal v-model:show="backupOpen" preset="card" title="创建备份" style="width: 480px">
      <div class="form">
        <n-form-item label="格式">
          <n-select v-model:value="backupFormat" :options="backupFormats" />
        </n-form-item>
        <n-form-item label="备注（可选）">
          <n-input v-model:value="backupLabel" placeholder="例如：升级前" />
        </n-form-item>
      </div>
      <template #footer>
        <div class="toolbar" style="justify-content: flex-end">
          <n-button quaternary @click="backupOpen = false">取消</n-button>
          <n-button type="primary" :loading="createBackupAction.pending.value" @click="createBackup">开始备份</n-button>
        </div>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.db-layout {
  display: grid;
  grid-template-columns: minmax(240px, 320px) minmax(0, 1fr);
  gap: 12px;
  align-items: start;
}
@media (max-width: 900px) {
  .db-layout {
    grid-template-columns: 1fr;
  }
}
.profile-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 66vh;
  overflow: auto;
}
.profile-item {
  border: 1px solid transparent;
  border-radius: 9px;
  background: transparent;
  color: var(--mpanel-text);
  padding: 8px 10px;
  text-align: left;
  cursor: pointer;
}
.profile-item:hover {
  background: color-mix(in srgb, var(--mpanel-accent) 8%, transparent);
}
.profile-item.active {
  border-color: color-mix(in srgb, var(--mpanel-accent) 45%, transparent);
  background: color-mix(in srgb, var(--mpanel-accent) 12%, transparent);
}
.profile-main {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.profile-title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.detail-head {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}
.cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.actions {
  display: flex;
  gap: 2px;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 12px;
}
.dbx-frame {
  width: 100%;
  height: 620px;
  border: 0;
  border-radius: 10px;
  background: #fff;
}
.error-text {
  color: var(--mpanel-danger);
  font-weight: 600;
}
</style>
