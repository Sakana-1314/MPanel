<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import {
  NAlert,
  NButton,
  NIcon,
  NModal,
  NProgress,
  NTag,
} from 'naive-ui';
import { CloseOutline } from '@vicons/ionicons5';
import type { Job } from '@/api/types';
import { useMachineApi } from '@/lib/api';
import { describeError } from '@/api/errors';
import { isJobTerminal, jobStatusLabel } from '@/lib/job';

const props = withDefaults(
  defineProps<{
    show: boolean;
    machineId: string;
    jobId: string | null;
    title?: string;
    invalidate?: readonly (readonly unknown[])[];
  }>(),
  { title: undefined, invalidate: () => [] },
);

const emit = defineEmits<{ 'update:show': [value: boolean]; completed: [job: Job] }>();

const api = useMachineApi(() => props.machineId);
const queryClient = useQueryClient();

const job = ref<Job | null>(null);
const loadError = ref<string | null>(null);
const canceling = ref(false);
const logsRef = ref<HTMLPreElement | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;
let finished = false;
let generation = 0;

const active = computed(
  () => job.value !== null && (job.value.status === 'queued' || job.value.status === 'running'),
);
const title = computed(() => job.value?.title ?? props.title ?? '后台任务');
const percent = computed(() => Math.max(0, Math.min(100, job.value?.progress ?? 0)));
const statusType = computed(() => {
  switch (job.value?.status) {
    case 'succeeded':
      return 'success';
    case 'failed':
    case 'cancelled':
      return 'error';
    default:
      return 'info';
  }
});
const progressStatus = computed(() => {
  switch (job.value?.status) {
    case 'succeeded':
      return 'success';
    case 'failed':
    case 'cancelled':
      return 'error';
    default:
      return 'default';
  }
});
const elapsed = computed(() => {
  const current = job.value;
  if (current === null) return '';
  const start = Date.parse(current.startedAt ?? current.createdAt);
  if (Number.isNaN(start)) return '';
  const end = current.finishedAt === null || current.finishedAt === undefined ? Date.now() : Date.parse(current.finishedAt);
  if (Number.isNaN(end)) return '';
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
});
const errorInfo = computed(() => (job.value?.error === undefined || job.value?.error === null ? null : job.value.error));

function stopPolling(): void {
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
}

async function poll(): Promise<void> {
  stopPolling();
  if (!props.show || props.jobId === null) return;
  const requestGeneration = generation;
  try {
    const current = await api.value.jobs.get(props.jobId);
    if (requestGeneration !== generation) return;
    job.value = current;
    loadError.value = null;
    await scrollLogs();
    if (isJobTerminal(current) && !finished) {
      finished = true;
      for (const key of props.invalidate) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
      emit('completed', current);
      return;
    }
  } catch (error) {
    if (requestGeneration !== generation) return;
    loadError.value = describeError(error).description;
  }
  if (requestGeneration !== generation) return;
  timer = setTimeout(() => void poll(), 800);
}

async function scrollLogs(): Promise<void> {
  await nextTick();
  if (logsRef.value !== null) logsRef.value.scrollTop = logsRef.value.scrollHeight;
}

watch(
  () => [props.show, props.jobId] as const,
  ([show, id]) => {
    if (show && id !== null) {
      generation += 1;
      finished = false;
      job.value = null;
      loadError.value = null;
      void poll();
      return;
    }
    generation += 1;
    stopPolling();
  },
  { immediate: true },
);

async function cancel(): Promise<void> {
  if (props.jobId === null || canceling.value) return;
  canceling.value = true;
  try {
    await api.value.jobs.cancel(props.jobId);
    await poll();
  } catch (error) {
    loadError.value = describeError(error).description;
  } finally {
    canceling.value = false;
  }
}

function close(): void {
  stopPolling();
  emit('update:show', false);
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    style="width: 640px; max-width: calc(100vw - 24px)"
    :mask-closable="false"
    @update:show="close"
  >
    <template #header>
      <div class="job-head">
        <span class="truncate">{{ title }}</span>
        <n-tag size="small" :bordered="false" :type="statusType" round>
          {{ job === null ? '加载中' : jobStatusLabel(job.status) }}
        </n-tag>
      </div>
    </template>

    <div class="job-body">
      <div class="bar-row">
        <n-progress
          type="line"
          :percentage="percent"
          :processing="job?.indeterminate === true || job?.status === 'running'"
          :status="progressStatus"
          :show-indicator="false"
        />
        <span class="tiny muted percent">{{ percent }}%</span>
      </div>
      <div class="meta-row small">
        <span class="muted">{{ job?.step ?? '正在读取任务状态…' }}</span>
        <span v-if="elapsed" class="tiny muted">{{ elapsed }}</span>
      </div>

      <n-alert v-if="loadError" type="error" :bordered="true" title="任务进度读取失败">
        {{ loadError }}
      </n-alert>

      <pre v-if="job?.logs" ref="logsRef" class="code-block job-logs">{{ job.logs }}</pre>

      <n-alert v-if="errorInfo" type="error" :bordered="true" title="任务失败">
        <div>{{ errorInfo.message }}</div>
        <div v-if="errorInfo.hint" class="small muted">{{ errorInfo.hint }}</div>
      </n-alert>

      <div v-if="job !== null" class="tiny muted">
        任务编号 <span class="mono">{{ job.id }}</span> · {{ job.kind }}
      </div>
    </div>

    <template #footer>
      <div class="toolbar" style="justify-content: flex-end">
        <n-button
          v-if="active && job?.cancellable === true"
          secondary
          :loading="canceling"
          @click="cancel"
        >
          取消任务
        </n-button>
        <n-button type="primary" @click="close">
          <template #icon><n-icon :component="CloseOutline" /></template>
          {{ active ? '后台运行' : '关闭' }}
        </n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.job-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.job-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.bar-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.bar-row :deep(.n-progress) {
  flex: 1;
}
.percent {
  width: 36px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.meta-row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
}
.job-logs {
  max-height: 220px;
  font-size: 11.5px;
  line-height: 1.5;
}
</style>
