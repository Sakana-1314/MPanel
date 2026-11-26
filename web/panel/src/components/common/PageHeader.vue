<script setup lang="ts">
defineProps<{
  title: string;
}>();
</script>

<template>
  <div class="page-header">
    <div style="min-width: 0">
      <h1>{{ title }}</h1>
      <div v-if="$slots.meta" class="toolbar" style="margin-top: 8px">
        <slot name="meta" />
      </div>
    </div>
    <div v-if="$slots.actions" class="toolbar">
      <slot name="actions" />
    </div>
  </div>
</template>
