<script setup lang="ts">
import { computed, ref } from 'vue';
import { useIntervalFn } from '@vueuse/core';
import { formatDate, formatRelativeTime } from '@/lib/format';

const props = defineProps<{
  value: string | null | undefined;
}>();

const tick = ref(0);
useIntervalFn(() => {
  tick.value += 1;
}, 30_000);

const text = computed(() => {
  void tick.value;
  return formatRelativeTime(props.value);
});
const exact = computed(() => formatDate(props.value));
</script>

<template>
  <span :title="exact" class="muted">{{ text }}</span>
</template>
