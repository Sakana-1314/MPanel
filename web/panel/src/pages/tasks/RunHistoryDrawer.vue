<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import {
  NDrawer,
  NDrawerContent,
  NEmpty,
  NSpin,
  NTable,
  NTag,
} from 'naive-ui';
import type { Task, TaskRun } from '@/api/types';
import { useMachineApi } from '@/lib/api';
import { machineKey } from '@/lib/query-keys';
import { formatDate, formatDuration } from '@/lib/format';
import { taskRunStatusLabel, taskRunStatusType } from '@/lib/status';
import RelativeTime from '@/components/common/RelativeTime.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import CodeBlock from '@/components/common/CodeBlock.vue';

const props = defineProps<{
  show: boolean;
  machineId: string;
  task: Task | null;
}>();

const emit = defineEmits<{ 'update:show': [value: boolean] }>();

const api = useMachineApi(() => props.machineId);
const selected = ref<TaskRun | null>(null);

watch(
  () => props.show,
  (show) => {
    if (!show) selected.value = null;
  },
);

const historyQuery = useQuery({
  queryKey: computed(() => machineKey(props.machineId, 'tasks', 'history', props.task?.id ?? 'none', { limit: 50 })),
  queryFn: () => api.value.tasks.history(props.task!.id, { limit: 50 }),
  enabled: computed(() => props.show && props.task !== null),
  retry: 0,
  refetchInterval: computed(() => (props.show ? 3_000 : false)),
});

const runs = computed(() => historyQuery.data.value?.items ?? []);

function selectRun(run: TaskRun): void {
  selected.value = run;
}

const stdout = computed(() => selected.value?.stdoutTail ?? '');
const stderr = computed(() => selected.value?.stderrTail ?? '');
</script>

<template>
  <n-drawer :show="show" :width="720" placement="right" @update:show="emit('update:show', $event)">
    <n-drawer-content :title="`运行历史 · ${task?.name ?? ''}`" closable>
      <div class="history">
        <error-state
          v-if="historyQuery.isError.value"
          :error="historyQuery.error.value"
          @retry="historyQuery.refetch()"
        />
        <n-spin v-else-if="historyQuery.isLoading.value" size="small" />
        <n-empty v-else-if="runs.length === 0" description="还没有运行记录" />
        <n-table v-else :single-line="false" size="small">
          <thead>
            <tr>
              <th style="width: 110px">状态</th>
              <th style="width: 100px">触发</th>
              <th style="min-width: 160px">开始时间</th>
              <th style="width: 90px">耗时</th>
              <th style="width: 80px">退出码</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="run in runs"
              :key="run.id"
              class="run-row"
              :class="{ selected: selected?.id === run.id }"
              @click="selectRun(run)"
            >
              <td><n-tag size="tiny" :type="taskRunStatusType(run.status)" round :bordered="false">{{ taskRunStatusLabel(run.status) }}</n-tag></td>
              <td class="small">{{ run.triggeredBy === 'manual' ? '手动' : '计划' }}</td>
              <td>
                <div class="cell">
                  <span class="small">{{ formatDate(run.startedAt) }}</span>
                  <RelativeTime :value="run.startedAt" />
                </div>
              </td>
              <td class="small">{{ run.durationMs === null || run.durationMs === undefined ? '—' : formatDuration(run.durationMs) }}</td>
              <td class="small">{{ run.exitCode ?? '—' }}</td>
            </tr>
          </tbody>
        </n-table>

        <template v-if="selected">
          <div class="selected-head">
            <strong>运行详情</strong>
            <n-tag size="tiny" :type="taskRunStatusType(selected.status)" round :bordered="false">
              {{ taskRunStatusLabel(selected.status) }}
            </n-tag>
            <span class="tiny muted mono">{{ selected.id }}</span>
          </div>
          <div class="logs">
            <div>
              <div class="tiny muted">stdout</div>
              <code-block :text="stdout || '（空）'" max-height="220px" />
            </div>
            <div>
              <div class="tiny muted">stderr</div>
              <code-block :text="stderr || '（空）'" max-height="220px" />
            </div>
          </div>
        </template>
      </div>
    </n-drawer-content>
  </n-drawer>
</template>

<style scoped>
.history {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.run-row {
  cursor: pointer;
}
.run-row.selected {
  background: color-mix(in srgb, var(--mpanel-accent) 10%, transparent);
}
.selected-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.logs {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
</style>
