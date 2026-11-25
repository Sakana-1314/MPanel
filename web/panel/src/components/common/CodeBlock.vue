<script setup lang="ts">
import CopyButton from './CopyButton.vue';

withDefaults(
  defineProps<{
    text: string;
    maxHeight?: string;
  }>(),
  { maxHeight: '320px' },
);
</script>

<template>
  <div class="code-wrap">
    <pre class="code-block" :style="{ maxHeight }">{{ text }}</pre>
    <div class="code-copy"><CopyButton :text="text" /></div>
  </div>
</template>

<style scoped>
.code-wrap {
  position: relative;
}
.code-copy {
  position: absolute;
  top: 4px;
  right: 4px;
  opacity: 0.75;
}
.code-copy:hover {
  opacity: 1;
}
</style>
