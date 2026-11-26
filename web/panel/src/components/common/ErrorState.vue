<script setup lang="ts">
import { computed } from 'vue';
import { NAlert, NButton, NIcon, NTooltip } from 'naive-ui';
import { HelpCircleOutline, RefreshOutline } from '@vicons/ionicons5';
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
    <div class="error-body">
      <span class="truncate" :title="described.description">{{ described.description }}</span>
      <n-tooltip v-if="described.hint">
        <template #trigger>
          <n-button size="tiny" quaternary circle aria-label="错误详情">
            <template #icon><n-icon :component="HelpCircleOutline" /></template>
          </n-button>
        </template>
        {{ described.hint }}
      </n-tooltip>
      <n-button size="tiny" secondary @click="emit('retry')">
        <template #icon><n-icon :component="RefreshOutline" /></template>
        重试
      </n-button>
    </div>
    <slot />
  </n-alert>
</template>

<style scoped>
.error-body {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.error-body > span {
  flex: 1;
  min-width: 0;
}
</style>
