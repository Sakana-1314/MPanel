<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import {
  NAlert,
  NButton,
  NCard,
  NCheckbox,
  NEmpty,
  NIcon,
  NInput,
  NModal,
  NSelect,
  NTable,
  NTooltip,
  useDialog,
  NTag,
} from 'naive-ui';
import {
  CubeOutline,
  EyeOutline,
  PlayOutline,
  RefreshOutline,
  ReloadOutline,
  StopOutline,
  TrashOutline,
} from '@vicons/ionicons5';
import type { ContainerSummary } from '@/api/types';
import type { ContainerAction } from '@/api/containers';
import { useMachineApi } from '@/lib/api';
import { machineKey } from '@/lib/query-keys';
import { useAction } from '@/composables/use-action';
import { usePageActive } from '@/composables/use-page-active';
import PageHeader from '@/components/common/PageHeader.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import RelativeTime from '@/components/common/RelativeTime.vue';
import ContainerDetailDrawer from './ContainerDetailDrawer.vue';

const route = useRoute();
const router = useRouter();
const dialog = useDialog();
const machineId = String(route.params.machineId ?? '');
const containerId =
  typeof route.params.containerId === 'string' ? route.params.containerId : null;
const api = useMachineApi(machineId);
const active = usePageActive();

const search = ref('');
const statusFilter = ref('all');
const removeTarget = ref<ContainerSummary | null>(null);
const removeForce = ref(false);
const removeVolumes = ref(false);

const listQuery = useQuery({
  queryKey: computed(() => machineKey(machineId, 'containers', 'list', { all: true, limit: 200 })),
  queryFn: () => api.value.containers.list({ all: true, limit: 200 }),
  refetchInterval: computed(() => (active.value ? 15_000 : false)),
  retry: 1,
});

const containers = computed(() => listQuery.data.value?.items ?? []);
const available = computed(() => listQuery.data.value?.available !== false);

const filtered = computed(() => {
  const needle = search.value.trim().toLowerCase();
  return containers.value.filter((container) => {
    if (statusFilter.value !== 'all' && container.state !== statusFilter.value) return false;
    if (needle.length === 0) return true;
    return [
      containerName(container),
      container.image,
      container.id,
      container.composeProject ?? '',
      container.composeService ?? '',
    ].some((value) => value.toLowerCase().includes(needle));
  });
});

const runningCount = computed(() => containers.value.filter((container) => container.state === 'running').length);

function containerName(container: ContainerSummary): string {
  return container.names[0]?.replace(/^\//, '') ?? container.id.slice(0, 12);
}

function shortId(id: string): string {
  return id.slice(0, 12);
}

const invalidate = computed(() => [machineKey(machineId, 'containers'), machineKey(machineId, 'stacks')]);

const action = useAction(
  (input: { id: string; kind: ContainerAction }) =>
    api.value.containers.action(input.id, input.kind),
  {
    success: (result, input) => `容器已${input.kind === 'start' ? '启动' : input.kind === 'stop' ? '停止' : '重启'}`,
    invalidate: invalidate.value,
  },
);

const removeAction = useAction(
  (input: { container: ContainerSummary; force: boolean; removeVolumes: boolean }) =>
    api.value.containers.remove(input.container.id, {
      force: input.force,
      removeVolumes: input.removeVolumes,
    }),
  {
    success: (_result, input) => `已删除容器 ${containerName(input.container)}`,
    invalidate: invalidate.value,
  },
);

async function removeContainer(): Promise<void> {
  const target = removeTarget.value;
  if (target === null) return;
  const result = await removeAction.run({
    container: target,
    force: removeForce.value,
    removeVolumes: removeVolumes.value,
  });
  if (result !== undefined) {
    removeTarget.value = null;
    if (containerId === target.id) closeDetail();
  }
}

function openDetail(container: ContainerSummary): void {
  void router.push(`/m/${machineId}/containers/${container.id}`);
}

function closeDetail(): void {
  void router.push(`/m/${machineId}/containers`);
}

watch(
  () => containerId,
  (id) => {
    if (id !== null) {
      const existing = containers.value.find((container) => container.id === id);
      if (existing === undefined && !listQuery.isLoading.value) {
        // 直接深链打开也允许；详情抽屉会自行请求。
      }
    }
  },
);

function toggleContainer(container: ContainerSummary): void {
  const kind = container.state === 'running' ? 'stop' : 'start';
  void action.run({ id: container.id, kind });
}

function containerStateType(state: string): 'success' | 'warning' | 'error' | 'default' | 'info' {
  if (state === 'running') return 'success';
  if (state === 'paused' || state === 'restarting') return 'warning';
  if (state === 'exited' || state === 'dead') return 'error';
  if (state === 'created') return 'info';
  return 'default';
}
</script>

<template>
  <div class="page">
    <PageHeader title="容器">
      <template #meta>
        <n-tooltip v-if="!available">
          <template #trigger>
            <n-tag size="small" type="warning" round :bordered="false">Docker 不可用</n-tag>
          </template>
          {{ listQuery.data.value?.reason ?? '服务返回不可用' }}
        </n-tooltip>
      </template>
      <template #actions>
        <n-button size="small" secondary :loading="listQuery.isFetching.value" @click="listQuery.refetch()">
          <template #icon><n-icon :component="RefreshOutline" /></template>
          刷新
        </n-button>
        <n-button size="small" quaternary @click="router.push(`/m/${machineId}/images`)">镜像</n-button>
        <n-button size="small" quaternary @click="router.push(`/m/${machineId}/stacks`)">编排</n-button>
      </template>
    </PageHeader>

    <error-state v-if="listQuery.isError.value" :error="listQuery.error.value" @retry="listQuery.refetch()" />

    <n-card size="small">
      <div class="toolbar">
        <n-input v-model:value="search" placeholder="搜索名称 / 镜像 / ID / compose…" clearable style="max-width: 300px" />
        <n-select
          v-model:value="statusFilter"
          style="width: 140px"
          :options="[
            { label: '全部状态', value: 'all' },
            { label: '运行中', value: 'running' },
            { label: '已退出', value: 'exited' },
            { label: '已暂停', value: 'paused' },
            { label: '已创建', value: 'created' },
            { label: '重启中', value: 'restarting' },
            { label: '异常', value: 'dead' },
          ]"
        />
        <div class="spacer" />
        <span class="small muted">共 {{ containers.length }} 个 · 运行中 {{ runningCount }}</span>
      </div>
    </n-card>

    <n-empty v-if="containers.length === 0 && !listQuery.isLoading.value" description="没有容器">
      <template #extra>

      </template>
    </n-empty>

    <n-card v-else size="small" :content-style="{ padding: '0' }">
      <n-table :single-line="false" size="small">
        <thead>
          <tr>
            <th style="min-width: 160px">容器</th>
            <th style="min-width: 160px">镜像</th>
            <th style="width: 90px">状态</th>
            <th style="min-width: 120px">端口</th>
            <th style="width: 100px">创建</th>
            <th style="width: 100px">Compose</th>
            <th style="width: 116px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="container in filtered" :key="container.id">
            <td>
              <div class="cell">
                <button type="button" class="link-name" @click="openDetail(container)">{{ containerName(container) }}</button>
                <span class="mono tiny muted">{{ shortId(container.id) }}</span>
              </div>
            </td>
            <td><span class="mono tiny truncate" style="max-width: 240px; display: inline-block" :title="container.image">{{ container.image }}</span></td>
            <td>
              <div class="cell">
                <n-tag size="tiny" round :bordered="false" :type="containerStateType(container.state)">{{ container.state }}</n-tag>
                <span class="tiny muted truncate" style="max-width: 120px" :title="container.status">{{ container.status }}</span>
              </div>
            </td>
            <td>
              <div class="cell">
                <span v-for="port in container.ports.slice(0, 3)" :key="`${port.privatePort}/${port.type}`" class="mono tiny">
                  {{ port.publicPort ? `${port.publicPort}→` : '' }}{{ port.privatePort }}/{{ port.type }}
                </span>
                <span v-if="container.ports.length === 0" class="tiny muted">—</span>
              </div>
            </td>
            <td><RelativeTime :value="container.created" /></td>
            <td><span class="tiny muted">{{ container.composeProject ?? '—' }}</span></td>
            <td>
              <div class="actions">
                <n-tooltip>
                  <template #trigger>
                    <n-button size="tiny" quaternary @click="openDetail(container)">
                      <template #icon><n-icon :component="EyeOutline" /></template>
                    </n-button>
                  </template>
                  详情 / 日志 / 统计 / 执行
                </n-tooltip>
                <n-tooltip>
                  <template #trigger>
                    <n-button
                      size="tiny"
                      quaternary
                      :disabled="container.state === 'paused'"
                      @click="toggleContainer(container)"
                    >
                      <template #icon>
                        <n-icon :component="container.state === 'running' ? StopOutline : PlayOutline" />
                      </template>
                    </n-button>
                  </template>
                  {{ container.state === 'running' ? '停止' : '启动' }}
                </n-tooltip>
                <n-tooltip>
                  <template #trigger>
                    <n-button size="tiny" quaternary @click="action.run({ id: container.id, kind: 'restart' })">
                      <template #icon><n-icon :component="ReloadOutline" /></template>
                    </n-button>
                  </template>
                  重启
                </n-tooltip>
                <n-tooltip>
                  <template #trigger>
                    <n-button size="tiny" quaternary type="error" @click="removeTarget = container; removeForce = false; removeVolumes = false">
                      <template #icon><n-icon :component="TrashOutline" /></template>
                    </n-button>
                  </template>
                  删除
                </n-tooltip>
              </div>
            </td>
          </tr>
        </tbody>
      </n-table>
      <div v-if="filtered.length === 0" class="empty-row small muted">没有匹配的容器。</div>
    </n-card>

    <ContainerDetailDrawer
      :show="containerId !== null"
      :machine-id="machineId"
      :container-id="containerId"
      @update:show="containerId === null ? undefined : closeDetail()"
      @changed="listQuery.refetch()"
    />

    <n-modal
      :show="removeTarget !== null"
      preset="card"
      title="删除容器"
      style="width: 480px; max-width: calc(100vw - 24px)"
      @update:show="removeTarget = null"
    >
      <div class="remove-form">
        <p class="small">
          确定删除容器
          <strong>{{ removeTarget ? containerName(removeTarget) : '' }}</strong>？
        </p>
        <n-checkbox v-model:checked="removeForce">强制删除（运行中也终止）</n-checkbox>
        <n-checkbox v-model:checked="removeVolumes">同时删除匿名卷</n-checkbox>
      </div>
      <template #footer>
        <div class="toolbar" style="justify-content: flex-end">
          <n-button quaternary @click="removeTarget = null">取消</n-button>
          <n-button type="error" :loading="removeAction.pending.value" @click="removeContainer">删除</n-button>
        </div>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
.cell {
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
  text-align: left;
  cursor: pointer;
}
.link-name:hover {
  color: var(--mpanel-accent);
}
.actions {
  display: flex;
  flex-wrap: nowrap;
  gap: 2px;
}
.empty-row {
  padding: 18px;
  text-align: center;
}
.remove-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
</style>
