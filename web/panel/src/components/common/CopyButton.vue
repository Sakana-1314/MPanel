<script setup lang="ts">
import { NButton, NIcon, useMessage } from 'naive-ui';
import { CopyOutline } from '@vicons/ionicons5';

const props = withDefaults(
  defineProps<{
    text: string;
    label?: string;
    size?: 'tiny' | 'small' | 'medium' | 'large';
  }>(),
  { label: '', size: 'small' },
);

const message = useMessage();

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.text);
    message.success('已复制到剪贴板');
  } catch {
    message.error('复制失败：浏览器拒绝访问剪贴板');
  }
}
</script>

<template>
  <n-button size="small" quaternary :aria-label="label || '复制'" title="复制" @click="copy">
    <template #icon><n-icon :component="CopyOutline" /></template>
    <span v-if="label">{{ label }}</span>
  </n-button>
</template>
