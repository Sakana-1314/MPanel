<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import {
  NAlert,
  NButton,
  NCard,
  NIcon,
  NModal,
  NTable,
  NTooltip,
  useDialog,
  NTag,
} from 'naive-ui';
import {
  ArrowBackOutline,
  CreateOutline,
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
import { describeError } from '@/api/errors';
import { openJobProgress } from '@/lib/job-center';
import { formatDate } from '@/lib/format';
import PageHeader from '@/components/common/PageHeader.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import CodeEditor from '@/components/common/CodeEditor.vue';
import CodeBlock from '@/components/common/CodeBlock.vue';

const route = useRoute();
const router = useRouter();
const dialog = useDialog();
const machineId = String(route.params.machineId ?? '');
const stackName = String(route.params.stackName ?? '');
const api = useMachineApi(machineId);

const stackQuery = useQuery({
  queryKey: computed(() => machineKey(machineId, 'stacks', 'detail', stackName)),
  queryFn: () => api.value.stacks.get(stackName),
  retry: 1,
});

const stack = computed(() => stackQuery.data.value);
const acting = ref(false);
const actionOutput = ref('');
const outputOpen = ref(false);

const invalidate = computed(() => [machineKey(machineId, 'stacks'), machineKey(machineId, 'containers')]);

async function runAction(kind: 'up' | 'down' | 'restart'): Promise<void> {
  acting.value = true;
  try {
    const started = await api.value.stacks.actionAsync(stackName, kind, {});
    openJobProgress({
      machineId,
      jobId: started.job.id,
      title: started.job.title,
      invalidate: invalidate.value,
      onCompleted: (job) => {
        const result = job.result as { output?: string } | undefined;
        actionOutput.value = result?.output || '（无输出）';
        outputOpen.value = true;
        void stackQuery.refetch();
      },
    });
  } catch (error) {
    dialog.error({
      title: '无法启动编排任务',
      content: describeError(error).description,
      positiveText: '知道了',
    });
  } finally {
    acting.value = false;
  }
}

const deleteAction = useAction(() => api.value.stacks.delete(stackName, true), {
  success: '栈已删除',
  invalidate: invalidate.value,
});

function confirmDelete(): void {
  dialog.warning({
    title: '删除 Compose 栈',
    content: `确定删除“${stackName}”？将执行 compose down 并移除此栈的配置。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      const result = await deleteAction.run();
      if (result !== undefined) await router.push(`/m/${machineId}/stacks`);
    },
  });
}

function openContainer(containerId: string): void {
  void router.push(`/m/${machineId}/containers/${containerId}`);
}

function containerName(names: string[], id: string): string {
  return names[0]?.replace(/^\//, '') ?? id.slice(0, 12);
}

function stateType(state: string): 'success' | 'warning' | 'error' | 'default' | 'info' {
  if (state === 'running') return 'success';
  if (state === 'paused' || state === 'restarting') return 'warning';
  if (state === 'exited' || state === 'dead') return 'error';
  return 'default';
}
</script>

<template>
  <div class="page">
    <div class="back">
      <n-button size="small" quaternary @click="router.push(`/m/${machineId}/stacks`)">
        <template #icon><n-icon :component="ArrowBackOutline" /></template>
        栈列表
      </n-button>
    </div>

    <PageHeader :title="stackName">
      <template #actions>
        <n-button size="small" secondary :loading="stackQuery.isFetching.value" @click="stackQuery.refetch()">
          <template #icon><n-icon :component="RefreshOutline" /></template>
          刷新
        </n-button>
        <n-button size="small" secondary @click="router.push(`/m/${machineId}/stacks/${encodeURIComponent(stackName)}/edit`)">
          <template #icon><n-icon :component="CreateOutline" /></template>
          编辑
        </n-button>
        <n-button size="small" secondary :loading="acting" @click="runAction('up')">
          <template #icon><n-icon :component="PlayOutline" /></template>
          启动
        </n-button>
        <n-button size="small" secondary :loading="acting" @click="runAction('restart')">
          <template #icon><n-icon :component="ReloadOutline" /></template>
          重启
        </n-button>
        <n-button size="small" quaternary :loading="acting" @click="runAction('down')">
          <template #icon><n-icon :component="StopOutline" /></template>
          停止
        </n-button>
        <n-button size="small" quaternary type="error" @click="confirmDelete">
          <template #icon><n-icon :component="TrashOutline" /></template>
          删除
        </n-button>
      </template>
    </PageHeader>

    <error-state v-if="stackQuery.isError.value" :error="stackQuery.error.value" @retry="stackQuery.refetch()" />

    <template v-if="stack">
      <n-card size="small">
        <div class="kv">
          <dt>状态</dt><dd><n-tag size="small" round :bordered="false" :type="stack.status === 'running' ? 'success' : 'default'">{{ stack.status }}</n-tag></dd>
          <dt>容器</dt><dd>{{ stack.runningCount }} / {{ stack.containerCount }} 运行中</dd>
          <dt>配置文件</dt><dd class="mono">{{ stack.configFiles.join(', ') || '—' }}</dd>
          <dt>compose 路径</dt><dd class="mono">{{ stack.composePath }}</dd>
          <dt>更新时间</dt><dd>{{ formatDate(stack.updatedAt) }}</dd>
        </div>
      </n-card>

      <n-card size="small" title="容器">
        <n-table v-if="stack.containers.length > 0" :single-line="false" size="small">
          <thead>
            <tr>
              <th style="min-width: 180px">容器</th>
              <th style="min-width: 180px">镜像</th>
              <th style="width: 100px">状态</th>
              <th style="min-width: 130px">服务</th>
              <th style="width: 80px">详情</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="container in stack.containers" :key="container.id">
              <td><span class="small">{{ containerName(container.names, container.id) }}</span></td>
              <td><span class="mono tiny muted">{{ container.image }}</span></td>
              <td><n-tag size="tiny" round :bordered="false" :type="stateType(container.state)">{{ container.state }}</n-tag></td>
              <td><span class="tiny muted">{{ container.composeService ?? '—' }}</span></td>
              <td><n-button size="tiny" quaternary @click="openContainer(container.id)">打开</n-button></td>
            </tr>
          </tbody>
        </n-table>
        <n-alert v-else type="info" :bordered="false">该栈当前没有容器。</n-alert>
      </n-card>

      <n-card size="small" title="compose 配置">
        <code-editor :model-value="stack.composeYaml" language="text" readonly height="420px" />
      </n-card>
    </template>

    <n-modal v-model:show="outputOpen" preset="card" title="Compose 输出" style="width: 760px; max-width: calc(100vw - 24px)">
      <code-block :text="actionOutput" max-height="420px" />
    </n-modal>
  </div>
</template>

<style scoped>
.back {
  margin-bottom: -6px;
}
</style>
