<script setup lang="ts">
import { NTag } from 'naive-ui';
import type { TagProps } from 'naive-ui';

withDefaults(
  defineProps<{
    label: string;
    type?: TagProps['type'];
    dot?: boolean;
    size?: 'small' | 'medium' | 'large';
  }>(),
  { type: 'default', dot: false, size: 'small' },
);
</script>

<template>
  <n-tag :type="type" :size="size" :bordered="false" round>
    <span v-if="dot" class="dot" :class="`dot-${type}`" />
    {{ label }}
  </n-tag>
</template>

<style scoped>
.dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-right: 5px;
  border-radius: 999px;
  background: currentColor;
}
</style>
