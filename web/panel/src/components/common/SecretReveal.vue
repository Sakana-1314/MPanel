<script setup lang="ts">
import { NInput } from 'naive-ui';
import CopyButton from './CopyButton.vue';

defineProps<{
  value: string;
}>();
</script>

<template>
  <n-input :value="value" readonly type="password" show-password-on="click" class="mono">
    <template #suffix>
      <CopyButton :text="value" />
    </template>
  </n-input>
</template>
