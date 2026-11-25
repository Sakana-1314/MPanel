<script setup lang="ts">
import { computed } from 'vue';
import type { MachineStatus } from '@/api/types';
import { machineStatusLabel, machineStatusType } from '@/lib/status';
import StatusTag from './StatusTag.vue';

const props = withDefaults(
  defineProps<{
    status: MachineStatus;
    dot?: boolean;
    size?: 'small' | 'medium' | 'large';
  }>(),
  { dot: true, size: 'small' },
);

const label = computed(() => machineStatusLabel(props.status));
const type = computed(() => machineStatusType(props.status));
</script>

<template>
  <StatusTag :label="label" :type="type" :dot="dot" :size="size" />
</template>
