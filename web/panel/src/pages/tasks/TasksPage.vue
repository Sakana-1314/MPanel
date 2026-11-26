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
  NSelect,
  NSwitch,
  NTable,
  NTooltip,
  useDialog,
} from 'naive-ui';
import {
  AddOutline,
  CalendarOutline,
  TimeOutline,
  PencilOutline,
  PlayOutline,
  RefreshOutline,
  TrashOutline,
} from '@vicons/ionicons5';
import type { Task } from '@/api/types';
import { useMachineApi } from '@/lib/api';
import { machineKey } from '@/lib/query-keys';
import { useAction } from '@/composables/use-action';
import { usePageActive } from '@/composables/use-page-active';
import { formatDate, formatDuration } from '@/lib/format';
import { describeCron } from '@/lib/cron';
import { taskRunStatusLabel, taskRunStatusType } from '@/lib/status';
import PageHeader from '@/components/common/PageHeader.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import RelativeTime from '@/components/common/RelativeTime.vue';
import StatusTag from '@/components/common/StatusTag.vue';
import RunHistoryDrawer from './RunHistoryDrawer.vue';

const route = useRoute();
const router = useRouter();
const dialog = useDialog();
const machineId = String(route.params.machineId ?? '');
const api = useMachineApi(machineId);
const active = usePageActive();

const search = ref('');
const enabledFilter = ref('all');
const historyTask = ref<Task | null>(null);
const historyOpen = ref(false);
const refreshing = ref(false);

const listParams = computed(() => ({
  limit: 200,
  ...(enabledFilter.value === 'all' ? {} : { enabled: enabledFilter.value === 'enabled' }),
  ...(search.value.trim().length === 0 ? {} : { q: search.value.trim() }),
}));

const tasksQuery = useQuery({
  queryKey: computed(() => machineKey(machineId, 'tasks', 'list', listParams.value)),
  queryFn: () => api.value.tasks.list(listParams.value),
  refetchInterval: computed(() => (active.value ? 15_000 : false)),
  retry: 0,
});

const tasks = computed(() => tasksQuery.data.value?.items ?? []);
const tasksAvailable = computed(() => tasksQuery.data.value?.available !== false);

const toggleAction = useAction(
  (input: { task: Task; enabled: boolean }) => api.value.tasks.update(input.task.id, { enabled: input.enabled }),
  {
    success: (task, input) => `已${input.enabled ? '启用' : '禁用'}任务 ${task.name}`,
    invalidate: [machineKey(machineId, 'tasks')],
  },
);

const runAction = useAction((task: Task) => api.value.tasks.run(task.id), {
  success: (result, task) =>
    result.run.status === 'skipped' ? `任务 ${task.name} 本次已跳过` : `已触发 ${task.name}`,
  successDescription: '任务在后台执行，运行历史每 3 秒刷新状态。',
  invalidate: [machineKey(machineId, 'tasks')],
});

async function runNow(task: Task): Promise<void> {
  await runAction.run(task);
  historyTask.value = task;
  historyOpen.value = true;
}

const deleteAction = useAction((task: Task) => api.value.tasks.delete(task.id), {
  success: (_result, task) => `已删除任务 ${task.name}`,
  successDescription: '调度已停止；运行历史已保留。',
  invalidate: [machineKey(machineId, 'tasks')],
});

function confirmDelete(task: Task): void {
  dialog.warning({
    title: '删除任务',
    content: `确定删除“${task.name}”？调度会停止，正在运行的实例会被终止；运行历史保留。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: () => {
      void deleteAction.run(task);
    },
  });
}

function openHistory(task: Task): void {
  historyTask.value = task;
  historyOpen.value = true;
}

function editTask(task: Task): void {
  void router.push(`/m/${machineId}/tasks/${task.id}`);
}

function createTask(): void {
  void router.push(`/m/${machineId}/tasks/new`);
}

async function refresh(): Promise<void> {
  refreshing.value = true;
  try {
    await tasksQuery.refetch();
  } finally {
    refreshing.value = false;
  }
}

function summarizeCommand(command: string): string {
  return command.replace(/\s+/g, ' ').trim().slice(0, 120);
}

const runningCount = computed(() => tasks.value.filter((task) => task.lastRun?.status === 'running').length);
</script>

<template>
  <div class="page">
    <PageHeader
      title="计划任务"
    >
      <template #actions>
        <n-button size="small" secondary :loading="refreshing" @click="refresh">
          <template #icon><n-icon :component="RefreshOutline" /></template>
          刷新
        </n-button>
        <n-button size="small" type="primary" :disabled="!tasksAvailable" @click="createTask">
          <template #icon><n-icon :component="AddOutline" /></template>
          新建任务
        </n-button>
      </template>
    </PageHeader>

    <n-alert v-if="tasksQuery.data.value?.available === false" type="warning" :bordered="true" title="任务能力不可用">
      {{ tasksQuery.data.value.reason ?? '服务返回不可用。' }}
    </n-alert>

    <error-state v-if="tasksQuery.isError.value" :error="tasksQuery.error.value" @retry="tasksQuery.refetch()" />

    <div class="filter-bar">
      <n-input v-model:value="search" placeholder="搜索任务名称 / 描述…" clearable style="max-width: 260px" @keydown.enter="tasksQuery.refetch()" />
      <n-select
        v-model:value="enabledFilter"
        style="width: 130px"
        :options="[
          { label: '全部', value: 'all' },
          { label: '已启用', value: 'enabled' },
          { label: '已禁用', value: 'disabled' },
        ]"
      />
      <div class="spacer" />
      <span class="small muted">共 {{ tasks.length }} 个<template v-if="runningCount > 0"> · 运行中 {{ runningCount }}</template></span>
    </div>

    <n-empty v-if="tasks.length === 0 && !tasksQuery.isLoading.value" description="还没有计划任务">
      <template #icon><n-icon :component="CalendarOutline" size="36" /></template>
      <template #extra>
        <div class="stack-center">
          <n-button type="primary" :disabled="!tasksAvailable" @click="createTask">新建任务</n-button>
        </div>
      </template>
    </n-empty>

    <n-card v-else size="small" :content-style="{ padding: '0' }">
      <n-table :single-line="false" size="small">
        <thead>
          <tr>
            <th style="min-width: 180px">任务</th>
            <th style="min-width: 170px">Cron 计划</th>
            <th style="min-width: 180px">命令</th>
            <th style="min-width: 150px">上次运行</th>
            <th style="width: 130px">下次运行</th>
            <th style="width: 70px">启用</th>
            <th style="width: 170px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="task in tasks" :key="task.id">
            <td>
              <div class="cell">
                <button type="button" class="link-name" @click="editTask(task)">{{ task.name }}</button>
                <span v-if="task.description" class="tiny muted truncate" :title="task.description" style="max-width: 220px">
                  {{ task.description }}
                </span>
                <span v-if="task.lastRun?.status === 'running'" class="tiny">运行中…</span>
              </div>
            </td>
            <td>
              <div class="cell">
                <code class="mono small">{{ task.schedule }}</code>
                <span class="tiny muted">{{ describeCron(task.schedule) }}</span>
                <span v-if="task.timezone" class="tiny muted">时区 {{ task.timezone }}</span>
              </div>
            </td>
            <td><code class="mono tiny muted truncate" style="max-width: 240px; display: inline-block" :title="task.command">{{ summarizeCommand(task.command) }}</code></td>
            <td>
              <div v-if="task.lastRun" class="cell">
                <div class="toolbar">
                  <StatusTag :label="taskRunStatusLabel(task.lastRun.status)" :type="taskRunStatusType(task.lastRun.status)" />
                  <RelativeTime :value="task.lastRun.startedAt" />
                </div>
                <span class="tiny muted">
                  {{ task.lastRun.exitCode === null || task.lastRun.exitCode === undefined ? '' : `退出码 ${task.lastRun.exitCode} · ` }}
                  {{ task.lastRun.durationMs === null || task.lastRun.durationMs === undefined ? '' : formatDuration(task.lastRun.durationMs) }}
                </span>
              </div>
              <span v-else class="tiny muted">从未运行</span>
            </td>
            <td>
              <template v-if="!task.enabled"><span class="tiny muted">已停用</span></template>
              <div v-else-if="task.nextRunAt" class="cell">
                <RelativeTime :value="task.nextRunAt" />
                <span class="tiny muted">{{ formatDate(task.nextRunAt) }}</span>
              </div>
              <span v-else class="tiny muted">—</span>
            </td>
            <td>
              <n-switch
                :value="task.enabled"
                size="small"
                :loading="toggleAction.pending.value"
                @update:value="(enabled: boolean) => toggleAction.run({ task, enabled })"
              />
            </td>
            <td>
              <div class="actions">
                <n-tooltip>
                  <template #trigger>
                    <n-button size="tiny" type="primary" secondary @click="runNow(task)">
                      <template #icon><n-icon :component="PlayOutline" /></template>
                      运行
                    </n-button>
                  </template>
                  立即运行
                </n-tooltip>
                <n-tooltip>
                  <template #trigger>
                    <n-button size="tiny" quaternary @click="openHistory(task)">
                      <template #icon><n-icon :component="TimeOutline" /></template>
                    </n-button>
                  </template>
                  运行历史
                </n-tooltip>
                <n-tooltip>
                  <template #trigger>
                    <n-button size="tiny" quaternary @click="editTask(task)">
                      <template #icon><n-icon :component="PencilOutline" /></template>
                    </n-button>
                  </template>
                  编辑
                </n-tooltip>
                <n-tooltip>
                  <template #trigger>
                    <n-button size="tiny" quaternary type="error" @click="confirmDelete(task)">
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
    </n-card>

    <RunHistoryDrawer v-model:show="historyOpen" :machine-id="machineId" :task="historyTask" />
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
  flex-wrap: wrap;
  gap: 2px;
}
.stack-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}
</style>
