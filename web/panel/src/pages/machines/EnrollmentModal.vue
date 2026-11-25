<script setup lang="ts">
import { computed } from 'vue';
import { NAlert, NButton, NModal, NTag } from 'naive-ui';
import type { MachineEnrollment } from '@/api/types';
import CodeBlock from '@/components/common/CodeBlock.vue';
import CopyButton from '@/components/common/CopyButton.vue';
import SecretReveal from '@/components/common/SecretReveal.vue';

const props = defineProps<{
  show: boolean;
  enrollment: MachineEnrollment | null;
}>();

const emit = defineEmits<{ 'update:show': [value: boolean] }>();

const envLines = computed(() => {
  const enrollment = props.enrollment;
  if (enrollment === null) return '';
  return Object.entries(enrollment.workerEnv)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
});

const command = computed(() => {
  const enrollment = props.enrollment;
  if (enrollment === null) return '';
  return `# 在目标主机上使用 agent 二进制注册（env 或 conf/agent.yaml）\n${envLines.value}`;
});
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    title="机器入网信息（只显示一次）"
    style="width: 720px; max-width: calc(100vw - 24px)"
    @update:show="emit('update:show', $event)"
  >
    <div v-if="enrollment" class="stack">
      <n-alert type="warning" :bordered="true" title="请立即保存">
        machine secret 只会在本次响应中出现；关闭后无法再次查看，只能轮换生成新的 secret。
      </n-alert>

      <div class="line">
        <span class="label">machineId</span>
        <code class="mono">{{ enrollment.machineId }}</code>
        <CopyButton :text="enrollment.machineId" />
      </div>

      <div class="line">
        <span class="label">注册 URL</span>
        <code class="mono truncate">{{ enrollment.url }}</code>
        <CopyButton :text="enrollment.url" />
      </div>

      <div class="field">
        <span class="label">machine secret</span>
        <SecretReveal :value="enrollment.secret" />
      </div>

      <div class="field">
        <span class="label">agent 环境变量</span>
        <code-block :text="envLines" max-height="200px" />
      </div>

      <div class="field">
        <span class="label">注册说明</span>
        <code-block :text="command" max-height="220px" />
      </div>

      <div class="toolbar">
        <n-tag size="small" type="info" round :bordered="false">
          core 不主动拨号：agent 连回后会出现在机器列表
        </n-tag>
      </div>
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
</style>
