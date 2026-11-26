<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import {
  NAlert,
  NButton,
  NCard,
  NEmpty,
  NIcon,
  NInput,
  NModal,
  NTable,
  NTooltip,
  useDialog,
  NTag,
} from 'naive-ui';
import {
  AddOutline,
  EyeOutline,
  LayersOutline,
  PlayOutline,
  RefreshOutline,
  ReloadOutline,
  StopOutline,
  TrashOutline,
} from '@vicons/ionicons5';
import type { StackSummary } from '@/api/types';
import { useMachineApi } from '@/lib/api';
import { machineKey } from '@/lib/query-keys';
import { useAction } from '@/composables/use-action';
import { formatDate } from '@/lib/format';
import PageHeader from '@/components/common/PageHeader.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import CodeEditor from '@/components/common/CodeEditor.vue';

const route = useRoute();
const router = useRouter();
const dialog = useDialog();
const machineId = String(route.params.machineId ?? '');
const api = useMachineApi(machineId);

const search = ref('');
const createOpen = ref(false);
const newName = ref('');
const newYaml = ref('services:\n  app:\n    image: nginx:latest\n    ports:\n      - "8080:80"\n');

const stacksQuery = useQuery({
  queryKey: computed(() => machineKey(machineId, 'stacks', 'list')),
  queryFn: () => api.value.stacks.list({ limit: 200 }),
  retry: 0,
});

const stacks = computed(() => stacksQuery.data.value?.items ?? []);
const available = computed(() => stacksQuery.data.value?.available !== false);

const filtered = computed(() => {
  const needle = search.value.trim().toLowerCase();
  return stacks.value.filter((stack) => needle.length === 0 || stack.name.toLowerCase().includes(needle));
});

const invalidate = computed(() => [machineKey(machineId, 'stacks'), machineKey(machineId, 'containers')]);

const action = useAction(
  (input: { name: string; kind: 'up' | 'down' | 'restart' }) =>
    api.value.stacks.action(input.name, input.kind, {}),
  {
    success: (result, input) => `栈 ${input.name} ${input.kind === 'up' ? '已启动' : input.kind === 'down' ? '已停止' : '已重启'}`,
    invalidate: invalidate.value,
  },
);

const createAction = useAction(
  (input: { name: string; yaml: string }) =>
    api.value.stacks.create({ name: input.name.trim(), composeYaml: input.yaml }),
  {
    success: (stack) => `已创建栈 ${stack.name}`,
    invalidate: invalidate.value,
  },
);

const deleteAction = useAction((stack: StackSummary) => api.value.stacks.delete(stack.name, true), {
  success: (_result, stack) => `已删除栈 ${stack.name}`,
  invalidate: invalidate.value,
});

async function create(): Promise<void> {
  const name = newName.value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    dialog.warning({ title: '名称不合法', content: '栈名称只能包含字母、数字、下划线、点和短横线。' });
    return;
  }
  const stack = await createAction.run({ name, yaml: newYaml.value });
  if (stack !== undefined) {
    createOpen.value = false;
    newName.value = '';
    await router.push(`/m/${machineId}/stacks/${encodeURIComponent(stack.name)}`);
  }
}

function confirmDelete(stack: StackSummary): void {
  dialog.warning({
    title: '删除 Compose 栈',
    content: `确定删除“${stack.name}”？将执行 compose down 并移除此栈的配置。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: () => {
      void deleteAction.run(stack);
    },
  });
}

function openDetail(stack: StackSummary): void {
  void router.push(`/m/${machineId}/stacks/${encodeURIComponent(stack.name)}`);
}
</script>

<template>
  <div class="page">
    <PageHeader title="编排">
      <template #meta>
        <n-tooltip v-if="!available">
          <template #trigger>
            <n-tag size="small" type="warning" round :bordered="false">Compose 不可用</n-tag>
          </template>
          {{ stacksQuery.data.value?.reason ?? 'agent 返回 available=false' }}
        </n-tooltip>
      </template>
      <template #actions>
        <n-button size="small" secondary :loading="stacksQuery.isFetching.value" @click="stacksQuery.refetch()">
          <template #icon><n-icon :component="RefreshOutline" /></template>
          刷新
        </n-button>
        <n-button size="small" type="primary" :disabled="!available" @click="createOpen = true">
          <template #icon><n-icon :component="AddOutline" /></template>
          新建栈
        </n-button>
        <n-button size="small" quaternary @click="router.push(`/m/${machineId}/containers`)">容器</n-button>
        <n-button size="small" quaternary @click="router.push(`/m/${machineId}/images`)">镜像</n-button>
      </template>
    </PageHeader>

    <error-state v-if="stacksQuery.isError.value" :error="stacksQuery.error.value" @retry="stacksQuery.refetch()" />

    <n-card size="small">
      <div class="toolbar">
        <n-input v-model:value="search" placeholder="搜索栈名…" clearable style="max-width: 260px" />
        <div class="spacer" />
        <span class="small muted">共 {{ stacks.length }} 个栈</span>
      </div>
    </n-card>

    <n-empty v-if="stacks.length === 0 && !stacksQuery.isLoading.value" description="还没有编排">
      <template #icon><n-icon :component="LayersOutline" size="36" /></template>
      <template #extra>
        <n-button type="primary" :disabled="!available" @click="createOpen = true">新建栈</n-button>
      </template>
    </n-empty>

    <n-card v-else size="small" :content-style="{ padding: '0' }">
      <n-table :single-line="false" size="small">
        <thead>
          <tr>
            <th style="min-width: 180px">栈</th>
            <th style="width: 120px">状态</th>
            <th style="width: 150px">容器</th>
            <th style="min-width: 160px">配置文件</th>
            <th style="min-width: 130px">更新时间</th>
            <th style="width: 230px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="stack in filtered" :key="stack.name">
            <td><button type="button" class="link-name" @click="openDetail(stack)">{{ stack.name }}</button></td>
            <td><n-tag size="tiny" round :bordered="false" :type="stack.status === 'running' ? 'success' : 'default'">{{ stack.status }}</n-tag></td>
            <td class="small">{{ stack.runningCount }} / {{ stack.containerCount }} 运行中</td>
            <td><span class="mono tiny muted">{{ stack.configFiles.join(', ') || '—' }}</span></td>
            <td><span class="small muted">{{ formatDate(stack.updatedAt) }}</span></td>
            <td>
              <div class="actions">
                <n-button size="tiny" type="primary" secondary @click="openDetail(stack)">
                  <template #icon><n-icon :component="EyeOutline" /></template>
                  详情
                </n-button>
                <n-tooltip>
                  <template #trigger>
                    <n-button size="tiny" quaternary @click="action.run({ name: stack.name, kind: 'up' })">
                      <template #icon><n-icon :component="PlayOutline" /></template>
                    </n-button>
                  </template>
                  启动
                </n-tooltip>
                <n-tooltip>
                  <template #trigger>
                    <n-button size="tiny" quaternary @click="action.run({ name: stack.name, kind: 'restart' })">
                      <template #icon><n-icon :component="ReloadOutline" /></template>
                    </n-button>
                  </template>
                  重启
                </n-tooltip>
                <n-tooltip>
                  <template #trigger>
                    <n-button size="tiny" quaternary @click="action.run({ name: stack.name, kind: 'down' })">
                      <template #icon><n-icon :component="StopOutline" /></template>
                    </n-button>
                  </template>
                  停止
                </n-tooltip>
                <n-tooltip>
                  <template #trigger>
                    <n-button size="tiny" quaternary type="error" @click="confirmDelete(stack)">
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
      <div v-if="filtered.length === 0" class="empty-row small muted">没有匹配的栈。</div>
    </n-card>

    <n-modal v-model:show="createOpen" preset="card" title="新建 Compose 栈" style="width: 760px; max-width: calc(100vw - 24px)">
      <div class="create-form">
        <n-input v-model:value="newName" placeholder="栈名称，例如 web" />
        <code-editor v-model="newYaml" language="text" height="320px" />
      </div>
      <template #footer>
        <div class="toolbar" style="justify-content: flex-end">
          <n-button quaternary @click="createOpen = false">取消</n-button>
          <n-button type="primary" :loading="createAction.pending.value" @click="create">创建</n-button>
        </div>
      </template>
    </n-modal>
  </div>
</template>

<style scoped>
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
  flex-wrap: wrap;
  gap: 2px;
}
.empty-row {
  padding: 18px;
  text-align: center;
}
.stack-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}
.create-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
</style>
