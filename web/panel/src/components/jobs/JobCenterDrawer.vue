<script setup lang="ts">
import { computed } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import {
  NButton,
  NDrawer,
  NDrawerContent,
  NEmpty,
  NProgress,
  NTag,
} from 'naive-ui';
import type { Job } from '@/api/types';
import { useMachineApi } from '@/lib/api';
import { machineKey } from '@/lib/query-keys';
import { jobStatusLabel } from '@/lib/job';
import { openJobProgress } from '@/lib/job-center';
import RelativeTime from '@/components/common/RelativeTime.vue';

const props = defineProps<{ show: boolean; machineId: string | null }>();
const emit = defineEmits<{ 'update:show': [value: boolean] }>();

const api = useMachineApi(() => props.machineId ?? '');

const jobsQuery = useQuery({
  queryKey: computed(() => machineKey(props.machineId ?? '', 'jobs', 'center')),
  queryFn: () => api.value.jobs.list({ limit: 50 }),
  enabled: computed(() => props.show && props.machineId !== null),
  refetchInterval: computed(() => (props.show ? 2_000 : false)),
  retry: 0,
});

const jobs = computed(() => jobsQuery.data.value?.items ?? []);

function openJob(job: Job): void {
  if (props.machineId === null) return;
  emit('update:show', false);
  openJobProgress({
    machineId: props.machineId,
    jobId: job.id,
    title: job.title,
    closeOnSuccess: false,
    invalidate: [['machine', props.machineId]],
  });
}

function statusType(job: Job): 'success' | 'error' | 'info' | 'default' {
  if (job.status === 'succeeded') return 'success';
  if (job.status === 'failed' || job.status === 'cancelled') return 'error';
  if (job.status === 'running' || job.status === 'queued') return 'info';
  return 'default';
}
</script>

<template>
  <n-drawer :show="show" :width="460" placement="right" @update:show="emit('update:show', $event)">
    <n-drawer-content title="任务中心" :native-scrollbar="false">
      <n-empty v-if="jobs.length === 0" description="还没有后台任务" />
      <div v-else class="job-list">
        <button
          v-for="job in jobs"
          :key="job.id"
          type="button"
          class="job-item"
          @click="openJob(job)"
        >
          <div class="job-row">
            <strong class="truncate">{{ job.title }}</strong>
            <n-tag size="tiny" :bordered="false" :type="statusType(job)">
              {{ jobStatusLabel(job.status) }}
            </n-tag>
          </div>
          <n-progress
            type="line"
            :percentage="job.progress"
            :processing="job.indeterminate || job.status === 'running'"
            :status="job.status === 'failed' || job.status === 'cancelled' ? 'error' : job.status === 'succeeded' ? 'success' : 'default'"
            :show-indicator="false"
          />
          <div class="job-meta tiny muted">
            <span class="truncate">{{ job.step ?? job.status }}</span>
            <RelativeTime :value="job.createdAt" />
          </div>
        </button>
      </div>
    </n-drawer-content>
  </n-drawer>
</template>

<style scoped>
.job-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.job-item {
  display: flex;
  flex-direction: column;
  gap: 7px;
  width: 100%;
  padding: 10px;
  border: 1px solid transparent;
  border-radius: 9px;
  background: var(--mpanel-surface-soft);
  color: var(--mpanel-text);
  text-align: left;
  cursor: pointer;
}
.job-item:hover {
  border-color: color-mix(in srgb, var(--mpanel-accent) 35%, transparent);
}
.job-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.job-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
</style>
