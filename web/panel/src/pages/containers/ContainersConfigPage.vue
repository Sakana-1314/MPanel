<script setup lang="ts">
import { computed, h, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import {
  NAlert,
  NButton,
  NCard,
  NCheckbox,
  NDataTable,
  NFormItem,
  NIcon,
  NInput,
  NModal,
  NSelect,
  NSpin,
  NTabPane,
  NTabs,
  NTag,
  NTooltip,
  useDialog,
  type DataTableColumns,
} from 'naive-ui';
import {
  AddOutline,
  CodeSlashOutline,
  DownloadOutline,
  KeyOutline,
  RefreshOutline,
  SaveOutline,
  ServerOutline,
  TrashOutline,
} from '@vicons/ionicons5';
import type {
  ContainerDaemonConfig,
  ContainerNetwork,
  ContainerNetworkCreateInput,
} from '@/api/types';
import { useMachineApi } from '@/lib/api';
import { machineKey } from '@/lib/query-keys';
import { useAction } from '@/composables/use-action';
import { usePageActive } from '@/composables/use-page-active';
import { formatDate } from '@/lib/format';
import PageHeader from '@/components/common/PageHeader.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import CodeEditor from '@/components/common/CodeEditor.vue';

const route = useRoute();
const dialog = useDialog();
const machineId = String(route.params.machineId ?? '');
const api = useMachineApi(machineId);
const active = usePageActive();

/* -------------------------------- networks ------------------------------- */

const networksQuery = useQuery({
  queryKey: computed(() => machineKey(machineId, 'containers', 'networks')),
  queryFn: () => api.value.containers.listNetworks({ limit: 200 }),
  refetchInterval: computed(() => (active.value ? 30_000 : false)),
  retry: 1,
});

const networks = computed(() => networksQuery.data.value?.items ?? []);
const networksAvailable = computed(() => networksQuery.data.value?.available !== false);

const builtinNetworks = new Set(['bridge', 'host', 'none']);

const createOpen = ref(false);
const form = ref<ContainerNetworkCreateInput>({ name: '', driver: 'bridge' });
const formError = ref<string | null>(null);

const createAction = useAction(
  (input: ContainerNetworkCreateInput) => api.value.containers.createNetwork(input),
  {
    success: (network) => `已创建网络 ${network.name}`,
    invalidate: [machineKey(machineId, 'containers', 'networks')],
  },
);

const removeAction = useAction((name: string) => api.value.containers.removeNetwork(name), {
  success: (_result, name) => `已删除网络 ${name}`,
  invalidate: [machineKey(machineId, 'containers', 'networks')],
});

function openCreate(): void {
  form.value = { name: '', driver: 'bridge' };
  formError.value = null;
  createOpen.value = true;
}

async function submitNetwork(): Promise<void> {
  const name = form.value.name.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name)) {
    formError.value = '名称只能包含字母、数字、下划线、点和短横线，且以字母或数字开头。';
    return;
  }
  formError.value = null;
  const created = await createAction.run({ ...form.value, name });
  if (created !== undefined) createOpen.value = false;
}

function confirmRemove(network: ContainerNetwork): void {
  dialog.warning({
    title: '删除网络',
    content: `确定删除网络「${network.name}」？仍有容器接入时会失败。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: () => {
      void removeAction.run(network.name);
    },
  });
}

const networkColumns = computed<DataTableColumns<ContainerNetwork>>(() => [
  {
    title: '名称',
    key: 'name',
    render: (row) =>
      h('div', { class: 'cell' }, [
        h('span', { class: 'strong' }, row.name),
        h('span', { class: 'mono tiny muted' }, row.id.slice(0, 12)),
      ]),
  },
  {
    title: '驱动',
    key: 'driver',
    width: 100,
    render: (row) => h(NTag, { size: 'tiny', bordered: false, round: true }, () => row.driver),
  },
  {
    title: '范围',
    key: 'scope',
    width: 90,
    render: (row) => h('span', { class: 'tiny muted' }, row.scope),
  },
  {
    title: '属性',
    key: 'flags',
    width: 150,
    render: (row) =>
      h('div', { class: 'flags' }, [
        row.internal ? h(NTag, { size: 'tiny', bordered: false, round: true }, () => '内部') : null,
        row.attachable ? h(NTag, { size: 'tiny', bordered: false, round: true }, () => '可附加') : null,
        row.ipv6 ? h(NTag, { size: 'tiny', bordered: false, round: true }, () => 'IPv6') : null,
      ]),
  },
  {
    title: '创建时间',
    key: 'createdAt',
    width: 160,
    render: (row) => h('span', { class: 'tiny muted' }, formatDate(row.createdAt ?? null)),
  },
  {
    title: '',
    key: 'actions',
    width: 64,
    align: 'right',
    render: (row) =>
      builtinNetworks.has(row.name)
        ? h(NTag, { size: 'tiny', bordered: false, round: true }, () => '预置')
        : h(
            NTooltip,
            {},
            {
              trigger: () =>
                h(
                  NButton,
                  { size: 'tiny', quaternary: true, type: 'error', onClick: () => confirmRemove(row) },
                  { icon: () => h(NIcon, { component: TrashOutline }) },
                ),
              default: () => '删除网络',
            },
          ),
  },
]);

/* --------------------------------- config -------------------------------- */

const configQuery = useQuery({
  queryKey: computed(() => machineKey(machineId, 'containers', 'config')),
  queryFn: () => api.value.containers.getConfig(),
  retry: 0,
});

const config = computed<ContainerDaemonConfig | undefined>(() => configQuery.data.value);
const draft = ref('');
const dirty = computed(() => config.value !== undefined && draft.value !== config.value.daemonJson);

const syncDraft = (): void => {
  draft.value = config.value?.daemonJson ?? '{}';
};

watch(
  config,
  (value) => {
    if (value === undefined) return;
    draft.value = value.daemonJson;
    mirrorText.value = value.registryMirrors.join(String.fromCharCode(10));
    insecureText.value = value.insecureRegistries.join(String.fromCharCode(10));
  },
  { immediate: true },
);

const saveAction = useAction((json: string) => api.value.containers.updateConfig(json), {
  success: '已保存 Docker 配置',
  successDescription: '重启 Docker 后生效。',
  invalidate: [machineKey(machineId, 'containers', 'config')],
});

async function saveConfig(): Promise<void> {
  const result = await saveAction.run(draft.value);
  if (result !== undefined) draft.value = result.daemonJson;
}

function formatJson(): void {
  try {
    draft.value = `${JSON.stringify(JSON.parse(draft.value), null, 2)}\n`;
  } catch {
    // 非法 JSON 交给服务端校验提示，这里不打断输入。
  }
}

/* ---------------------------------- tabs --------------------------------- */

const savePending = computed(() => saveAction.pending.value);
const createPending = computed(() => createAction.pending.value);

const tab = ref<'networks' | 'registries' | 'advanced'>('networks');

const mirrorText = ref('');
const insecureText = ref('');

function mirrorsFromDraft(): string[] {
  try {
    const parsed = JSON.parse(draft.value) as { 'registry-mirrors'?: unknown };
    const value = parsed['registry-mirrors'];
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function applyMirrors(): void {
  const list = mirrorText.value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(draft.value) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  parsed['registry-mirrors'] = list;
  draft.value = `${JSON.stringify(parsed, null, 2)}\n`;
}

function applyInsecure(): void {
  const list = insecureText.value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(draft.value) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  parsed['insecure-registries'] = list;
  draft.value = `${JSON.stringify(parsed, null, 2)}\n`;
}

const mirrors = computed(() => {
  const value = config.value?.registryMirrors ?? [];
  return value.length > 0 ? value : mirrorsFromDraft();
});
const insecure = computed(() => {
  const value = config.value?.insecureRegistries ?? [];
  return value.length > 0 ? value : [];
});
</script>

<template>
  <div class="page">
    <PageHeader title="容器配置">
      <template #meta>
        <span class="tiny muted">网络、镜像仓库与守护进程配置集中在这里</span>
      </template>
      <template #actions>
        <n-button size="small" secondary :loading="configQuery.isFetching.value" @click="configQuery.refetch(); syncDraft()">
          <template #icon><n-icon :component="RefreshOutline" /></template>
          刷新
        </n-button>
        <n-button size="small" type="primary" :disabled="!dirty" :loading="savePending" @click="saveConfig">
          <template #icon><n-icon :component="SaveOutline" /></template>
          保存
        </n-button>
      </template>
    </PageHeader>

    <error-state
      v-if="configQuery.isError.value"
      :error="configQuery.error.value"
      @retry="configQuery.refetch()"
    />

    <n-tabs v-model:value="tab" type="segment">
      <!-- 网络 -->
      <n-tab-pane name="networks" tab="网络">
        <n-card size="small">
          <div class="toolbar" style="margin-bottom: 8px">
            <span class="small muted">共 {{ networks.length }} 个网络</span>
            <span v-if="!networksAvailable" class="tiny muted">
              {{ networksQuery.data.value?.reason ?? 'Docker 不可用' }}
            </span>
            <div class="spacer" />
            <n-button size="small" type="primary" :disabled="!networksAvailable" @click="openCreate">
              <template #icon><n-icon :component="AddOutline" /></template>
              新建网络
            </n-button>
          </div>
          <error-state
            v-if="networksQuery.isError.value"
            :error="networksQuery.error.value"
            @retry="networksQuery.refetch()"
          />
          <n-spin v-else-if="networksQuery.isLoading.value" size="small">
            <div style="height: 60px" />
          </n-spin>
          <n-data-table
            v-else
            :columns="networkColumns"
            :data="networks"
            :bordered="false"
            size="small"
            :row-key="(row: ContainerNetwork) => row.id"
          />
        </n-card>
      </n-tab-pane>

      <!-- 仓库 -->
      <n-tab-pane name="registries" tab="仓库">
        <div class="stack">
          <n-card size="small" title="镜像加速">
            <p class="tiny muted hint">拉取镜像时优先使用的镜像站，每行一个地址。</p>
            <n-input
              v-model:value="mirrorText"
              type="textarea"
              :rows="3"
              class="mono"
              :placeholder="mirrors.join('\n') || 'https://mirror.example.com'"
            />
            <div class="toolbar" style="margin-top: 8px">
              <n-button size="small" secondary @click="mirrorText = mirrors.join('\n')">
                载入当前值
              </n-button>
              <n-button size="small" secondary @click="applyMirrors">写入配置</n-button>
            </div>
          </n-card>

          <n-card size="small" title="非安全仓库">
            <p class="tiny muted hint">允许通过 HTTP 访问的私有仓库，每行一个。</p>
            <n-input
              v-model:value="insecureText"
              type="textarea"
              :rows="3"
              class="mono"
              :placeholder="insecure.join('\n') || 'registry.local:5000'"
            />
            <div class="toolbar" style="margin-top: 8px">
              <n-button size="small" secondary @click="insecureText = insecure.join('\n')">
                载入当前值
              </n-button>
              <n-button size="small" secondary @click="applyInsecure">写入配置</n-button>
            </div>
          </n-card>

          <n-card size="small" title="已登录仓库">
            <p class="tiny muted hint">只显示仓库地址与用户名，凭据不会出现在这里。</p>
            <n-alert v-if="!config" type="info" :bordered="false">正在读取…</n-alert>
            <div v-else-if="config.auths.length === 0" class="tiny muted empty-line">暂无登录记录</div>
            <div v-else class="auth-list">
              <div v-for="auth in config.auths" :key="auth.registry" class="auth-row">
                <n-icon :component="KeyOutline" class="muted" />
                <span class="mono truncate">{{ auth.registry }}</span>
                <n-tag size="tiny" :bordered="false" round>{{ auth.username || '未记录用户名' }}</n-tag>
              </div>
            </div>
            <p v-if="config?.credentialStore" class="tiny muted hint">
              凭据由 {{ config.credentialStore }} 管理。
            </p>
          </n-card>
        </div>
      </n-tab-pane>

      <!-- 高级 -->
      <n-tab-pane name="advanced" tab="高级">
        <n-card size="small">
          <div class="toolbar" style="margin-bottom: 8px">
            <span class="mono tiny muted truncate">{{ config?.daemonPath ?? '—' }}</span>
            <n-tag v-if="dirty" size="tiny" type="warning" :bordered="false" round>未保存</n-tag>
            <div class="spacer" />
            <n-button size="small" quaternary @click="formatJson">格式化</n-button>
            <n-button size="small" quaternary @click="draft = config?.daemonJson ?? '{}'">还原</n-button>
          </div>
          <code-editor v-model="draft" language="json" height="420px" />
          <p class="tiny muted hint">
            保存后需要重启 Docker 才会生效；写入前会校验 JSON 结构与已知字段类型。
          </p>
        </n-card>
      </n-tab-pane>
    </n-tabs>

    <n-modal
      v-model:show="createOpen"
      preset="card"
      title="新建网络"
      style="width: 520px; max-width: calc(100vw - 24px)"
    >
      <div class="stack">
        <n-form-item label="名称" required>
          <n-input v-model:value="form.name" placeholder="例如 app-net" />
        </n-form-item>
        <n-form-item label="驱动">
          <n-select
            v-model:value="form.driver"
            :options="[
              { label: 'bridge', value: 'bridge' },
              { label: 'overlay', value: 'overlay' },
              { label: 'macvlan', value: 'macvlan' },
              { label: 'ipvlan', value: 'ipvlan' },
            ]"
          />
        </n-form-item>
        <div class="two">
          <n-form-item label="子网（可选）">
            <n-input v-model:value="form.subnet" placeholder="172.20.0.0/16" />
          </n-form-item>
          <n-form-item label="网关（可选）">
            <n-input v-model:value="form.gateway" placeholder="172.20.0.1" />
          </n-form-item>
        </div>
        <div class="toolbar">
          <n-checkbox v-model:checked="form.internal">仅内部访问</n-checkbox>
          <n-checkbox v-model:checked="form.attachable">允许手动接入</n-checkbox>
        </div>
        <n-alert v-if="formError" type="error" :bordered="true">{{ formError }}</n-alert>
      </div>
      <template #footer>
        <div class="toolbar" style="justify-content: flex-end">
          <n-button quaternary @click="createOpen = false">取消</n-button>
          <n-button type="primary" :loading="createPending" @click="submitNetwork">创建</n-button>
        </div>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
@media (max-width: 560px) {
  .two {
    grid-template-columns: 1fr;
  }
}
.hint {
  margin: 0 0 8px;
}
.empty-line {
  padding: 12px 0;
}
.auth-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.auth-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--mpanel-surface-soft);
}
:deep(.cell) {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
:deep(.strong) {
  font-weight: 600;
  font-size: 12.5px;
}
:deep(.flags) {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
</style>
