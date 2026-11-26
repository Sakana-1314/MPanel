<script setup lang="ts">
import { NCard, NSkeleton } from 'naive-ui';
import type { TagProps } from 'naive-ui';

withDefaults(
  defineProps<{
    label: string;
    value?: string | number;
    hint?: string;
    loading?: boolean;
    type?: TagProps['type'];
  }>(),
  { value: '—', hint: '', loading: false, type: undefined },
);
</script>

<template>
  <n-card size="small" :bordered="true">
    <div class="tiny muted">{{ label }}</div>
    <n-skeleton v-if="loading" text style="width: 60%; margin-top: 8px" />
    <div v-else class="stat-value" :class="`stat-${type ?? 'default'}`">{{ value }}</div>
    <div v-if="hint" class="tiny muted truncate" :title="hint">{{ hint }}</div>
  </n-card>
</template>

<style scoped>
.stat-value {
  margin-top: 4px;
  font-size: 24px;
  font-weight: 650;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
}
.stat-success {
  color: var(--mpanel-success);
}
.stat-warning {
  color: var(--mpanel-attention);
}
.stat-error {
  color: var(--mpanel-danger);
}
.stat-info {
  color: var(--mpanel-accent);
}
</style>
