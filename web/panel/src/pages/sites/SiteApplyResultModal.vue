<script setup lang="ts">
import { NAlert, NButton, NModal, NTag } from 'naive-ui';
import type { SiteApplyResult } from '@/api/types';
import CodeBlock from '@/components/common/CodeBlock.vue';
import SiteStatusBadge from './SiteStatusBadge.vue';

defineProps<{
  show: boolean;
  result: SiteApplyResult | null;
  machineId: string;
}>();

const emit = defineEmits<{ 'update:show': [value: boolean] }>();
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    title="应用结果"
    style="width: 780px; max-width: calc(100vw - 24px)"
    @update:show="emit('update:show', $event)"
  >
    <div v-if="result" class="result">
      <div class="toolbar">
        <n-tag size="small" :type="result.reloaded ? 'success' : 'warning'" round :bordered="false">
          {{ result.reloaded ? 'reload 成功' : '未 reload' }}
        </n-tag>
        <n-tag size="small" :type="result.rolledBack ? 'error' : 'default'" round :bordered="false">
          {{ result.rolledBack ? '已回滚' : '未回滚' }}
        </n-tag>
        <span class="small muted">apply #{{ result.revision }} · {{ result.appliedAt }}</span>
      </div>
      <div class="kv">
        <dt>Caddyfile</dt><dd class="mono">{{ result.caddyfilePath }}</dd>
        <dt>备份</dt><dd class="mono">{{ result.backupPath ?? '—' }}</dd>
      </div>
      <div v-if="result.sites.length > 0" class="toolbar">
        <SiteStatusBadge v-for="site in result.sites" :key="site.id" :status="site.status" />
      </div>
      <n-alert v-if="result.rolledBack" type="error" :bordered="true" title="已回滚">
        reload 失败，已恢复备份并重载；请查看下方 caddy 输出。
      </n-alert>
      <n-alert v-if="result.warnings.length > 0" type="warning" :bordered="true" title="警告">
        <ul>
          <li v-for="warning in result.warnings" :key="warning">{{ warning }}</li>
        </ul>
      </n-alert>
      <div>
        <div class="tiny muted" style="margin-bottom: 4px">caddy 输出</div>
        <CodeBlock :text="result.caddyOutput || '（无输出）'" max-height="240px" />
      </div>
    </div>
    <template #footer>
      <div class="toolbar" style="justify-content: flex-end">
        <n-button type="primary" @click="emit('update:show', false)">关闭</n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.result {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
</style>
