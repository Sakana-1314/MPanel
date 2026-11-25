<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import {
  NAlert,
  NButton,
  NIcon,
  NModal,
  NSpin,
  NSwitch,
} from 'naive-ui';
import { CopyOutline, RefreshOutline } from '@vicons/ionicons5';
import type { SitePreviewRequest } from '@/api/sites';
import { useMachineApi } from '@/lib/api';
import { machineKey } from '@/lib/query-keys';
import { useMessage } from 'naive-ui';
import CodeEditor from '@/components/common/CodeEditor.vue';
import ErrorState from '@/components/common/ErrorState.vue';

const props = defineProps<{
  show: boolean;
  machineId: string;
  request: SitePreviewRequest;
}>();

const emit = defineEmits<{ 'update:show': [value: boolean] }>();

const api = useMachineApi(() => props.machineId);
const message = useMessage();
const validate = ref(props.request.validate === true);

watch(
  () => props.show,
  (show) => {
    if (show) validate.value = props.request.validate === true;
  },
);

const requestKey = computed(() => JSON.stringify({ ...props.request, validate: validate.value }));

const previewQuery = useQuery({
  queryKey: computed(() => machineKey(props.machineId, 'sites', 'preview', requestKey.value)),
  queryFn: () => api.value.sites.preview({ ...props.request, validate: validate.value }),
  enabled: computed(() => props.show),
  retry: 0,
  staleTime: 0,
});

const result = computed(() => previewQuery.data.value);

async function copy(): Promise<void> {
  if (result.value === undefined) return;
  try {
    await navigator.clipboard.writeText(result.value.caddyfile);
    message.success('已复制 Caddyfile');
  } catch {
    message.error('复制失败：浏览器拒绝访问剪贴板');
  }
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    title="Caddyfile 预览"
    style="width: 900px; max-width: calc(100vw - 24px)"
    @update:show="emit('update:show', $event)"
  >
    <div class="preview">
      <div class="toolbar">
        <n-switch v-model:value="validate" />
        <span class="small">执行 caddy validate</span>
        <div class="spacer" />
        <n-button size="small" quaternary :disabled="result === undefined" @click="copy">
          <template #icon><n-icon :component="CopyOutline" /></template>
          复制
        </n-button>
        <n-button size="small" secondary :loading="previewQuery.isFetching.value" @click="previewQuery.refetch()">
          <template #icon><n-icon :component="RefreshOutline" /></template>
          重新生成
        </n-button>
      </div>

      <div v-if="previewQuery.isLoading.value" class="center">
        <n-spin size="small" /> <span class="small muted">生成 Caddyfile…</span>
      </div>
      <error-state
        v-else-if="previewQuery.isError.value"
        :error="previewQuery.error.value"
        @retry="previewQuery.refetch()"
      />
      <template v-else-if="result">
        <n-alert v-if="result.warnings.length > 0" type="warning" :bordered="true" title="生成警告">
          <ul>
            <li v-for="warning in result.warnings" :key="warning">{{ warning }}</li>
          </ul>
        </n-alert>
        <n-alert v-if="result.validation === null" type="warning" :bordered="true" title="未执行 caddy validate">
          {{ result.validationUnavailableReason ?? 'Caddy 不可用。' }}
        </n-alert>
        <n-alert
          v-else
          :type="result.validation.ok ? 'success' : 'error'"
          :bordered="true"
          :title="result.validation.ok ? 'caddy validate 通过' : 'caddy validate 失败'"
        >
          <pre class="output">{{ result.validation.output || '无输出。' }}</pre>
        </n-alert>
        <code-editor :model-value="result.caddyfile" language="text" readonly height="420px" />
      </template>
    </div>
    <template #footer>
      <div class="toolbar" style="justify-content: flex-end">
        <n-button @click="emit('update:show', false)">关闭</n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.preview {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.center {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 32px 0;
}
.output {
  margin: 0;
  max-height: 200px;
  overflow: auto;
  white-space: pre-wrap;
  font-size: 11px;
  font-family: 'JetBrains Mono', Consolas, monospace;
}
</style>
