<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import {
  NAlert,
  NButton,
  NCard,
  NIcon,
  NSpin,
  NTag,
  useDialog,
} from 'naive-ui';
import { ArrowBackOutline, RocketOutline, ShieldCheckmarkOutline } from '@vicons/ionicons5';
import type { SiteApplyResult } from '@/api/types';
import type { SitePreviewRequest } from '@/api/sites';
import { useMachineApi } from '@/lib/api';
import { machineKey } from '@/lib/query-keys';
import { useAction } from '@/composables/use-action';
import { describeError } from '@/api/errors';
import { formatDate } from '@/lib/format';
import PageHeader from '@/components/common/PageHeader.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import RelativeTime from '@/components/common/RelativeTime.vue';
import SiteForm from './SiteForm.vue';
import SiteStatusBadge from './SiteStatusBadge.vue';
import SitePreviewModal from './SitePreviewModal.vue';
import SiteApplyResultModal from './SiteApplyResultModal.vue';
import { emptySiteDraft, type SiteDraft } from './site-form';

const route = useRoute();
const router = useRouter();
const dialog = useDialog();

const machineId = String(route.params.machineId ?? '');
const siteId = typeof route.params.siteId === 'string' ? route.params.siteId : undefined;
const isNew = siteId === undefined;
const api = useMachineApi(machineId);

const draft = ref<SiteDraft>(emptySiteDraft());
const dirty = ref(false);
const previewOpen = ref(false);
const previewRequest = ref<SitePreviewRequest>({ site: draft.value.config, validate: true });
const applyResult = ref<SiteApplyResult | null>(null);
const applyResultOpen = ref(false);
const applyError = ref<unknown>(null);

const siteQuery = useQuery({
  queryKey: computed(() => machineKey(machineId, 'sites', 'detail', siteId ?? 'new')),
  queryFn: () => api.value.sites.get(siteId ?? ''),
  enabled: computed(() => !isNew),
  retry: 1,
});

const systemQuery = useQuery({
  queryKey: computed(() => machineKey(machineId, 'system', 'info')),
  queryFn: () => api.value.system.info(),
  staleTime: 30_000,
  retry: 0,
});

const caddy = computed(() => systemQuery.data.value?.capabilities.caddy);
const caddyAvailable = computed(() => caddy.value === undefined || caddy.value.available);
const site = computed(() => siteQuery.data.value);
let suppressDirty = false;

function assignDraft(next: SiteDraft): void {
  suppressDirty = true;
  draft.value = next;
  dirty.value = false;
  queueMicrotask(() => {
    suppressDirty = false;
  });
}

watch(
  () => [site.value?.id, site.value?.revision] as const,
  () => {
    if (site.value === undefined) return;
    assignDraft({
      name: site.value.name,
      enabled: site.value.enabled,
      config: JSON.parse(JSON.stringify(site.value.config)),
    });
  },
  { immediate: true },
);

watch(
  draft,
  () => {
    if (suppressDirty) return;
    dirty.value = true;
  },
  { deep: true },
);

const invalidates = computed(() => [
  machineKey(machineId, 'sites'),
  machineKey(machineId, 'certs'),
]);

const saveAction = useAction(async (value: SiteDraft) => {
  const payload = {
    name: value.name.trim(),
    enabled: value.enabled,
    config: value.config,
  };
  if (isNew) {
    return api.value.sites.create(payload);
  }
  return api.value.sites.update(siteId!, payload);
}, {
  success: (saved) => (isNew ? `已创建站点 ${saved.name}` : '站点已保存'),
  successDescription: (saved) =>
    isNew ? '已进入编辑页；应用后才会写入 Caddy。' : `revision 已更新为 ${saved.revision}。`,
  invalidate: invalidates.value,
});

const applyAction = useAction(async () => {
  if (siteId === undefined) return null;
  if (dirty.value) {
    await api.value.sites.update(siteId, {
      name: draft.value.name.trim(),
      enabled: draft.value.enabled,
      config: draft.value.config,
    });
  }
  return api.value.sites.apply({ siteIds: [siteId] });
}, {
  success: (result) => (result === null ? '未应用' : `应用成功（apply #${result.revision}）`),
  successDescription: (result) => (result?.rolledBack ? '已回滚到应用前配置。' : undefined),
  invalidate: invalidates.value,
});

async function save(): Promise<void> {
  const saved = await saveAction.run(draft.value);
  if (saved === undefined) return;
  assignDraft({
    name: saved.name,
    enabled: saved.enabled,
    config: JSON.parse(JSON.stringify(saved.config)),
  });
  if (isNew) {
    await router.replace(`/m/${machineId}/sites/${saved.id}`);
  }
}

function openPreview(): void {
  previewRequest.value = dirty.value || isNew
    ? { site: JSON.parse(JSON.stringify(draft.value.config)), validate: caddyAvailable.value }
    : { siteId: siteId, validate: caddyAvailable.value };
  previewOpen.value = true;
}

function confirmApply(): void {
  dialog.info({
    title: '应用此站点',
    content: '将保存当前草稿并只把该站点渲染进 staging，随后 validate + reload Caddy；未选中的站点保留现有配置。',
    positiveText: '应用',
    negativeText: '取消',
    onPositiveClick: async () => {
      applyError.value = null;
      const result = await applyAction.run();
      if (result !== null && result !== undefined) {
        applyResult.value = result;
        applyResultOpen.value = true;
        dirty.value = false;
      } else {
        applyError.value = applyAction.error.value;
      }
    },
  });
}

const applyOutput = computed(() => {
  const error = applyError.value;
  if (typeof error !== 'object' || error === null) return '';
  const details = (error as { details?: unknown }).details;
  if (typeof details !== 'object' || details === null) return '';
  const output = (details as { output?: unknown }).output;
  return typeof output === 'string' ? output : '';
});
</script>

<template>
  <div class="page">
    <div class="back">
      <n-button size="small" quaternary @click="router.push(`/m/${machineId}/sites`)">
        <template #icon><n-icon :component="ArrowBackOutline" /></template>
        站点列表
      </n-button>
    </div>

    <PageHeader
      :title="isNew ? '新建站点' : draft.name.length === 0 ? '未命名站点' : draft.name"
      :subtitle="isNew ? '填写结构化配置；保存后进入编辑页，可预览 Caddyfile 并单站应用。' : '保存只更新 JSON 草稿；应用才会校验并 reload Caddy。'"
    >
      <template #meta>
        <SiteStatusBadge v-if="site" :status="site.status" />
        <n-tag v-if="dirty" size="small" type="warning" round :bordered="false">未保存</n-tag>
      </template>
      <template #actions>
        <n-button
          v-if="!isNew"
          size="small"
          secondary
          :disabled="!caddyAvailable"
          :loading="applyAction.pending.value"
          @click="confirmApply"
        >
          <template #icon><n-icon :component="RocketOutline" /></template>
          应用此站点
        </n-button>
      </template>
    </PageHeader>

    <n-alert v-if="!caddyAvailable" type="warning" :bordered="true" title="Caddy 不可用：只能编辑与预览">
      {{ caddy?.reason ?? 'capabilities.caddy.available=false' }}；草稿仍可保存。
    </n-alert>

    <n-alert
      v-if="site?.lastApply !== null && site?.lastApply !== undefined && !site.lastApply.ok"
      type="error"
      :bordered="true"
      title="最近一次应用失败"
    >
      {{ site.lastApply.error ?? '未知错误' }}
    </n-alert>

    <n-alert v-if="applyError" type="error" :bordered="true" title="应用失败">
      <div>{{ describeError(applyError).description }}</div>
      <div class="small muted">{{ describeError(applyError).hint }}</div>
      <pre v-if="applyOutput" class="code-block" style="margin-top: 8px; max-height: 180px">{{ applyOutput }}</pre>
    </n-alert>

    <n-spin v-if="!isNew && siteQuery.isLoading.value" size="small">
      <div style="height: 120px" />
    </n-spin>
    <error-state
      v-else-if="!isNew && siteQuery.isError.value"
      :error="siteQuery.error.value"
      @retry="siteQuery.refetch()"
    />
    <n-alert v-else-if="!isNew && site === undefined" type="warning" :bordered="true" title="站点不存在">
      可能已被删除，或当前标签的机器不是创建它的那台。
    </n-alert>

    <SiteForm
      v-else
      :draft="draft"
      :submitting="saveAction.pending.value"
      :submit-label="isNew ? '创建站点' : '保存草稿'"
      :preview-loading="false"
      @submit="save"
      @preview="openPreview"
      @cancel="router.push(`/m/${machineId}/sites`)"
    >
      <template #footerExtra>
        <span class="tiny muted">{{ dirty ? '有未保存修改' : '已保存' }}</span>
      </template>
      <template #aside>
        <n-card size="small" title="站点状态">
          <div class="kv">
            <dt>状态</dt><dd><SiteStatusBadge v-if="site" :status="site.status" /><span v-else>未创建</span></dd>
            <dt>revision</dt><dd>{{ site?.revision ?? '—' }}</dd>
            <dt>已应用</dt><dd>{{ site?.appliedRevision ?? '—' }}</dd>
            <dt>最近应用</dt>
            <dd>
              <template v-if="site?.lastApply">
                <span :class="site.lastApply.ok ? 'ok' : 'bad'">
                  {{ site.lastApply.ok ? '成功' : '失败' }} · #{{ site.lastApply.revision }}
                </span>
                <div class="tiny muted"><RelativeTime :value="site.lastApply.at" /></div>
              </template>
              <span v-else class="muted">从未应用</span>
            </dd>
            <dt>更新时间</dt><dd>{{ site === undefined ? '—' : formatDate(site.updatedAt) }}</dd>
            <template v-if="site?.lastApply?.caddyfileHash">
              <dt>配置哈希</dt><dd class="mono tiny">{{ site.lastApply.caddyfileHash }}</dd>
            </template>
          </div>
        </n-card>
        <n-card size="small" title="应用说明">
          <div class="notes small muted">
            <p><n-icon :component="ShieldCheckmarkOutline" /> 应用会先保存草稿，再渲染片段、执行 caddy validate、备份并 reload；失败自动回滚。</p>
            <p>删除已应用站点需要到列表页执行全量“应用全部更改”才会从 Caddy 移除。</p>
            <p>证书在 Caddy 完成签发后出现在“证书”页；预览不会触发签发。</p>
            <p>预览与保存都不会直接修改线上配置。</p>
          </div>
        </n-card>
      </template>
    </SiteForm>

    <SitePreviewModal
      v-model:show="previewOpen"
      :machine-id="machineId"
      :request="previewRequest"
    />
    <SiteApplyResultModal v-model:show="applyResultOpen" :result="applyResult" :machine-id="machineId" />
  </div>
</template>

<style scoped>
.back {
  margin-bottom: -6px;
}
.kv {
  font-size: 12px;
}
.ok {
  color: #2fbf71;
}
.bad {
  color: #e05561;
}
.notes p {
  margin: 0 0 8px;
  display: flex;
  gap: 6px;
  line-height: 1.6;
  align-items: flex-start;
}
.notes p:last-child {
  margin-bottom: 0;
}
</style>
