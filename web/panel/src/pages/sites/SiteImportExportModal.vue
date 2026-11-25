<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useQueryClient } from '@tanstack/vue-query';
import {
  NAlert,
  NButton,
  NIcon,
  NModal,
  NSelect,
  NTabPane,
  NTabs,
  useMessage,
  NInput,
} from 'naive-ui';
import { DownloadOutline, CloudUploadOutline } from '@vicons/ionicons5';
import type { SiteExportBundle, SiteImportResult } from '@/api/types';
import { AppError } from '@/api/errors';
import { useMachineApi } from '@/lib/api';
import { machineKey } from '@/lib/query-keys';
import { downloadText } from '@/lib/download';
import CodeBlock from '@/components/common/CodeBlock.vue';

const props = defineProps<{
  show: boolean;
  machineId: string;
}>();

const emit = defineEmits<{ 'update:show': [value: boolean] }>();

const api = useMachineApi(() => props.machineId);
const queryClient = useQueryClient();
const message = useMessage();

const tab = ref('export');
const exporting = ref(false);
const bundle = ref<SiteExportBundle | null>(null);
const exportError = ref<string | null>(null);
const importText = ref('');
const mode = ref<'merge' | 'replace'>('merge');
const importing = ref(false);
const parseError = ref<string | null>(null);
const importResult = ref<SiteImportResult | null>(null);

watch(
  () => props.show,
  (show) => {
    if (show) return;
    bundle.value = null;
    exportError.value = null;
    importText.value = '';
    parseError.value = null;
    importResult.value = null;
  },
);

const bundleJson = computed(() => (bundle.value === null ? '' : JSON.stringify(bundle.value, null, 2)));

async function runExport(): Promise<void> {
  exporting.value = true;
  exportError.value = null;
  try {
    bundle.value = await api.value.sites.exportBundle();
  } catch (error) {
    exportError.value = error instanceof Error ? error.message : String(error);
  } finally {
    exporting.value = false;
  }
}

function downloadBundle(): void {
  if (bundle.value === null) return;
  downloadText(bundleJson.value, 'mpanel-sites.json');
}

async function onFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (file === undefined) return;
  try {
    importText.value = await file.text();
    parseError.value = null;
  } catch {
    parseError.value = '无法读取文件。';
  }
  input.value = '';
}

async function submitImport(): Promise<void> {
  parseError.value = null;
  importResult.value = null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(importText.value);
  } catch {
    parseError.value = 'JSON 解析失败，请检查文件内容。';
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    parseError.value = '站点包必须是 JSON 对象。';
    return;
  }
  const value = parsed as SiteExportBundle;
  if (value.version !== 1 || !Array.isArray(value.sites)) {
    parseError.value = '只支持 version=1 且包含 sites 数组的 SiteExportBundle。';
    return;
  }
  importing.value = true;
  try {
    const result = await api.value.sites.importBundle({ bundle: value, mode: mode.value });
    importResult.value = result;
    importText.value = '';
    message.success(`导入完成：新增 ${result.imported}，跳过 ${result.skipped}`);
    void queryClient.invalidateQueries({ queryKey: machineKey(props.machineId, 'sites') });
  } catch (error) {
    const appError = error instanceof AppError ? error : null;
    parseError.value = appError === null ? String(error) : `${appError.message} ${appError.hint}`;
  } finally {
    importing.value = false;
  }
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    title="导入 / 导出站点"
    style="width: 860px; max-width: calc(100vw - 24px)"
    @update:show="emit('update:show', $event)"
  >
    <n-tabs v-model:value="tab" type="line">
      <n-tab-pane name="export" tab="导出">
        <div class="panel">
          <n-alert type="info" :bordered="false" title="导出内容">
            包含全部站点（含禁用）的 name/enabled/config，不含 id、revision 与运行状态。
          </n-alert>
          <div class="toolbar">
            <n-button size="small" type="primary" :loading="exporting" @click="runExport">
              <template #icon><n-icon :component="DownloadOutline" /></template>
              生成站点包
            </n-button>
            <n-button size="small" secondary :disabled="bundle === null" @click="downloadBundle">
              下载 JSON
            </n-button>
          </div>
          <n-alert v-if="exportError" type="error" :bordered="true">{{ exportError }}</n-alert>
          <code-block v-if="bundle" :text="bundleJson" max-height="380px" />
        </div>
      </n-tab-pane>

      <n-tab-pane name="import" tab="导入">
        <div class="panel">
          <n-alert type="info" :bordered="false" title="导入方式">
            支持 SiteExportBundle JSON。merge 按名称合并已有站点；replace 只保留导入包里的站点。
          </n-alert>
          <div class="toolbar">
            <label class="file-label">
              <input type="file" accept=".json,application/json" @change="onFile" />
              <n-button size="small" secondary tag="span">
                <template #icon><n-icon :component="CloudUploadOutline" /></template>
                选择 JSON 文件
              </n-button>
            </label>
            <n-select
              v-model:value="mode"
              size="small"
              style="width: 150px"
              :options="[
                { label: '合并 merge', value: 'merge' },
                { label: '替换 replace', value: 'replace' },
              ]"
            />
            <div class="spacer" />
            <n-button
              size="small"
              type="primary"
              :loading="importing"
              :disabled="importText.trim().length === 0"
              @click="submitImport"
            >
              开始导入
            </n-button>
          </div>
          <n-input
            v-model:value="importText"
            type="textarea"
            :rows="12"
            class="mono"
            placeholder="粘贴 SiteExportBundle JSON…"
          />
          <n-alert v-if="parseError" type="error" :bordered="true">{{ parseError }}</n-alert>
          <n-alert v-if="importResult" type="success" :bordered="true" title="导入完成">
            新增 {{ importResult.imported }}，跳过 {{ importResult.skipped }}。
            <ul v-if="importResult.errors.length > 0">
              <li v-for="error in importResult.errors" :key="error.index">
                #{{ error.index }} {{ error.name ?? '' }}：{{ error.message }}
              </li>
            </ul>
          </n-alert>
        </div>
      </n-tab-pane>
    </n-tabs>
  </n-modal>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 4px;
}
.file-label input {
  display: none;
}
</style>
