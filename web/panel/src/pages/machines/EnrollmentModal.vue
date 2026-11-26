<script setup lang="ts">
import { computed } from 'vue';
import { NAlert, NButton, NModal } from 'naive-ui';
import type { MachineEnrollment } from '@/api/types';
import CopyButton from '@/components/common/CopyButton.vue';
import SecretReveal from '@/components/common/SecretReveal.vue';

const props = defineProps<{
  show: boolean;
  enrollment: MachineEnrollment | null;
}>();

const emit = defineEmits<{ 'update:show': [value: boolean] }>();

/** 对外只展示服务器地址，不暴露内部接入路径。 */
const serverAddress = computed(() => {
  const enrollment = props.enrollment;
  if (enrollment === null) return '';
  try {
    const url = new URL(enrollment.url);
    return `${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}`;
  } catch {
    return '';
  }
});
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    title="节点接入信息（只显示一次）"
    style="width: 620px; max-width: calc(100vw - 24px)"
    @update:show="emit('update:show', $event)"
  >
    <div v-if="enrollment" class="stack">
      <n-alert type="warning" :bordered="true" title="请立即保存">
        接入密钥只会在本次响应中出现；关闭后无法再次查看，只能轮换生成新的密钥。
      </n-alert>

      <div class="line">
        <span class="label">节点 ID</span>
        <code class="mono">{{ enrollment.machineId }}</code>
        <CopyButton :text="enrollment.machineId" />
      </div>

      <div v-if="serverAddress" class="line">
        <span class="label">服务器地址</span>
        <code class="mono truncate">{{ serverAddress }}</code>
        <CopyButton :text="serverAddress" />
      </div>

      <div class="field">
        <span class="label">接入密钥</span>
        <SecretReveal :value="enrollment.secret" />
      </div>

      <p class="hint">在目标服务器上使用以上信息完成接入，节点上线后会出现在机器列表。</p>
    </div>

    <template #footer>
      <div class="toolbar" style="justify-content: flex-end">
        <n-button type="primary" @click="emit('update:show', false)">我已保存</n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.line,
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.line {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
}
.label {
  font-size: 12px;
  color: var(--mpanel-muted);
}
.hint {
  margin: 2px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--mpanel-muted);
}
</style>
