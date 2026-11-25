<script setup lang="ts">
import { computed } from 'vue';
import {
  NAlert,
  NButton,
  NIcon,
} from 'naive-ui';
import { RefreshOutline } from '@vicons/ionicons5';
import { describeError } from '@/api/errors';

const props = defineProps<{
  error: unknown;
  title?: string;
}>();
const emit = defineEmits<{ retry: [] }>();

const described = computed(() => describeError(props.error, props.title ?? '加载失败'));
</script>

<template>
  <n-alert type="error" :title="described.title" :bordered="true">
    <div>{{ described.description }}</div>
    <div class="muted small" style="margin-top: 4px">{{ described.hint }}</div>
    <div v-if="$slots.default" style="margin-top: 6px"><slot /></div>
    <div style="margin-top: 8px">
      <n-button size="small" secondary @click="emit('retry')">
        <template #icon><n-icon :component="RefreshOutline" /></template>
        重试
      </n-button>
    </div>
  </n-alert>
</template>
