<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import {
  NAlert,
  NButton,
  NCard,
  NIcon,
  NSpin,
  NTag,
} from 'naive-ui';
import { ArrowBackOutline, TimeOutline, RefreshOutline } from '@vicons/ionicons5';
import type { Task } from '@/api/types';
import { useMachineApi } from '@/lib/api';
import { machineKey } from '@/lib/query-keys';
import { useAction } from '@/composables/use-action';
import PageHeader from '@/components/common/PageHeader.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import TaskForm from './TaskForm.vue';
import RunHistoryDrawer from './RunHistoryDrawer.vue';
import {
  draftFromTask,
  draftToCreateInput,
  draftToUpdateInput,
  emptyTaskDraft,
  serializeTaskDraft,
  type TaskDraft,
} from './task-form';

const route = useRoute();
const router = useRouter();
const machineId = String(route.params.machineId ?? '');
const taskId = typeof route.params.taskId === 'string' ? route.params.taskId : undefined;
const isNew = taskId === undefined;
const api = useMachineApi(machineId);

const draft = ref<TaskDraft>(emptyTaskDraft());
const savedSnapshot = ref(serializeTaskDraft(draft.value));
const historyOpen = ref(false);

const taskQuery = useQuery({
  queryKey: computed(() => machineKey(machineId, 'tasks', 'detail', taskId ?? 'new')),
  queryFn: () => api.value.tasks.get(taskId ?? ''),
  enabled: computed(() => !isNew),
  retry: 1,
});

const task = computed(() => taskQuery.data.value);

let suppress = false;
function assignDraft(next: TaskDraft): void {
  suppress = true;
  draft.value = next;
  savedSnapshot.value = serializeTaskDraft(next);
  queueMicrotask(() => {
    suppress = false;
  });
}

watch(
  () => task.value?.id,
  () => {
    if (task.value === undefined) return;
    assignDraft(draftFromTask(task.value));
  },
  { immediate: true },
);

const dirty = computed(() => serializeTaskDraft(draft.value) !== savedSnapshot.value);

const saveAction = useAction(async (value: TaskDraft) => {
  if (isNew) {
    return api.value.tasks.create(draftToCreateInput(value));
  }
  return api.value.tasks.update(taskId!, draftToUpdateInput(value));
}, {
  success: (saved) => (isNew ? `已创建任务 ${saved.name}` : '任务已保存'),
  successDescription: (saved) =>
    isNew ? '已创建并启用调度。' : `下次运行：${saved.nextRunAt ?? '—'}`,
  invalidate: [machineKey(machineId, 'tasks')],
});

async function save(): Promise<void> {
  const saved: Task | undefined = await saveAction.run(draft.value);
  if (saved === undefined) return;
  assignDraft(draftFromTask(saved));
  if (isNew) {
    await router.replace(`/m/${machineId}/tasks/${saved.id}`);
  }
}
</script>

<template>
  <div class="page">
    <div class="back">
      <n-button size="small" quaternary @click="router.push(`/m/${machineId}/tasks`)">
        <template #icon><n-icon :component="ArrowBackOutline" /></template>
        任务列表
      </n-button>
    </div>

    <PageHeader
      :title="isNew ? '新建任务' : (draft.name.length > 0 ? draft.name : '未命名任务')"
      :subtitle="isNew ? '创建 cron 任务；保存后按计划执行，也可手动运行。' : '修改后保存即可更新调度；运行历史保留。'"
    >
      <template #meta>
        <n-tag v-if="dirty" size="small" type="warning" round :bordered="false">未保存</n-tag>
        <n-tag v-if="task" size="small" :type="task.enabled ? 'success' : 'default'" round :bordered="false">
          {{ task.enabled ? '已启用' : '已禁用' }}
        </n-tag>
      </template>
      <template #actions>
        <n-button v-if="!isNew && task" size="small" secondary @click="historyOpen = true">
          <template #icon><n-icon :component="TimeOutline" /></template>
          运行历史
        </n-button>
        <n-button v-if="!isNew && task" size="small" quaternary @click="taskQuery.refetch()">
          <template #icon><n-icon :component="RefreshOutline" /></template>
        </n-button>
      </template>
    </PageHeader>

    <error-state v-if="!isNew && taskQuery.isError.value" :error="taskQuery.error.value" @retry="taskQuery.refetch()" />

    <n-spin v-if="!isNew && taskQuery.isLoading.value" size="small">
      <div style="height: 100px" />
    </n-spin>

    <n-alert v-else-if="!isNew && task === undefined" type="warning" :bordered="true" title="任务不存在">
      可能已被删除，或当前标签的机器不是创建它的那台。
    </n-alert>

    <template v-else>
      <TaskForm
        :draft="draft"
        :mode="isNew ? 'create' : 'edit'"
        :submitting="saveAction.pending.value"
        :submit-label="isNew ? '创建任务' : '保存任务'"
        @submit="save"
        @cancel="router.push(`/m/${machineId}/tasks`)"
      />
      <n-card v-if="!isNew && task?.lastRun" size="small" title="最近一次运行">
        <div class="last-run small">
          <span>状态：{{ task.lastRun.status }}</span>
          <span>开始：{{ task.lastRun.startedAt }}</span>
          <span>退出码：{{ task.lastRun.exitCode ?? '—' }}</span>
        </div>
      </n-card>
    </template>

    <RunHistoryDrawer v-model:show="historyOpen" :machine-id="machineId" :task="task ?? null" />
  </div>
</template>

<style scoped>
.back {
  margin-bottom: -6px;
}
.last-run {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  color: var(--mpanel-muted);
}
</style>
