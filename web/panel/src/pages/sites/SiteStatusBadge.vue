<script setup lang="ts">
import { computed } from 'vue';
import type { SiteStatus } from '@/api/types';
import { siteStatusLabel, siteStatusType } from '@/lib/status';
import StatusTag from '@/components/common/StatusTag.vue';

const props = defineProps<{ status: SiteStatus }>();
const label = computed(() => siteStatusLabel(props.status));
const type = computed(() => siteStatusType(props.status));
</script>

<template>
  <StatusTag :label="label" :type="type" />
</template>
