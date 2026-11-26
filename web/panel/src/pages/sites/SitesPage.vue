<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useQuery, useQueryClient } from '@tanstack/vue-query';
import {
  NAlert,
  NButton,
  NCard,
  NEmpty,
  NIcon,
  NInput,
  NModal,
  NSelect,
  NSpin,
  NTable,
  NTooltip,
  useDialog,
  useMessage,
  NTag,
} from 'naive-ui';
import {
  AddOutline,
  EyeOutline,
  GlobeOutline,
  PencilOutline,
  RefreshOutline,
  RocketOutline,
  ShieldCheckmarkOutline,
  TrashOutline,
  CloudUploadOutline,
} from '@vicons/ionicons5';
import type { CertificateInfo, Site, SiteApplyResult } from '@/api/types';
import type { SitePreviewRequest as PreviewRequest } from '@/api/sites';
import { useMachineApi } from '@/lib/api';
import { machineKey } from '@/lib/query-keys';
import { useAction } from '@/composables/use-action';
import { describeError } from '@/api/errors';
import { formatDay } from '@/lib/format';
import PageHeader from '@/components/common/PageHeader.vue';
import ContainerRunModal, { type ContainerRunPreset } from '@/pages/containers/ContainerRunModal.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import RelativeTime from '@/components/common/RelativeTime.vue';
import StatusTag from '@/components/common/StatusTag.vue';
import StoreInstallModal from '@/components/store/StoreInstallModal.vue';
import SiteStatusBadge from './SiteStatusBadge.vue';
import SitePreviewModal from './SitePreviewModal.vue';
import SiteImportExportModal from './SiteImportExportModal.vue';
import SiteApplyResultModal from './SiteApplyResultModal.vue';
import { HANDLER_LABEL } from './site-form';

const route = useRoute();
const router = useRouter();
const queryClient = useQueryClient();
const machineId = String(route.params.machineId ?? '');
const api = useMachineApi(machineId);
const dialog = useDialog();
const message = useMessage();

const search = ref('');
const enabledFilter = ref('all');
const importOpen = ref(false);
const installOpen = ref(false);
const checking = ref(false);
const previewRequest = ref<PreviewRequest | null>(null);
const applyResult = ref<SiteApplyResult | null>(null);
const applyResultOpen = ref(false);
const runOpen = ref(false);
const runPreset = ref<ContainerRunPreset | undefined>(undefined);
const applyError = ref<unknown>(null);

const systemQuery = useQuery({
  queryKey: computed(() => machineKey(machineId, 'system', 'info')),
  queryFn: () => api.value.system.info(),
  staleTime: 30_000,
  retry: 0,
});

const caddy = computed(() => systemQuery.data.value?.capabilities.caddy);
const docker = computed(() => systemQuery.data.value?.capabilities.docker);
const caddyAvailable = computed(() => caddy.value?.available === true);
const caddyReason = computed(
  () => caddy.value?.reason ?? (systemQuery.isError.value ? '无法读取 Caddy 能力状态' : ''),
);
const dockerAvailable = computed(() => docker.value?.available === true);
const dockerReason = computed(() => (docker.value?.available === false ? docker.value.reason ?? '' : ''));

const sitesQuery = useQuery({
  queryKey: computed(() => machineKey(machineId, 'sites', 'list', { limit: 200 })),
  queryFn: () => api.value.sites.list({ limit: 200 }),
  enabled: computed(() => caddyAvailable.value),
});

const certsQuery = useQuery({
  queryKey: computed(() => machineKey(machineId, 'certs', 'list', { limit: 200, includeExpired: true })),
  queryFn: () => api.value.certs.list({ limit: 200, includeExpired: true }),
  retry: 0,
});

const sites = computed(() => sitesQuery.data.value?.items ?? []);
const certs = computed(() => certsQuery.data.value?.items ?? []);

async function checkStatus(): Promise<void> {
  checking.value = true;
  try {
    const info = await api.value.system.info(true);
    queryClient.setQueryData(machineKey(machineId, 'system', 'info'), info);
  } catch (error) {
    message.error(describeError(error).description);
  } finally {
    checking.value = false;
  }
}

const filtered = computed(() => {
  const needle = search.value.trim().toLowerCase();
  return sites.value.filter((site) => {
    if (enabledFilter.value === 'enabled' && !site.enabled) return false;
    if (enabledFilter.value === 'disabled' && site.enabled) return false;
    if (needle.length === 0) return true;
    return (
      site.name.toLowerCase().includes(needle) ||
      site.config.domains.some((domain) => domain.toLowerCase().includes(needle))
    );
  });
});

const earliestCertByDomain = computed(() => {
  const map = new Map<string, CertificateInfo>();
  for (const cert of certs.value) {
    for (const domain of cert.domains) {
      const key = domain.toLowerCase().replace(/^\*\./, '');
      const current = map.get(key);
      if (current === undefined || current.notAfter > cert.notAfter) map.set(key, cert);
    }
  }
  return map;
});

function certForSite(site: Site): CertificateInfo | undefined {
  let result: CertificateInfo | undefined;
  for (const domain of site.config.domains) {
    const normalized = domain.toLowerCase().replace(/^\*\./, '');
    const cert =
      earliestCertByDomain.value.get(normalized) ??
      (normalized.includes('.')
        ? earliestCertByDomain.value.get(normalized.split('.').slice(1).join('.'))
        : undefined);
    if (cert !== undefined && (result === undefined || cert.notAfter < result.notAfter)) {
      result = cert;
    }
  }
  return result;
}

const pendingCount = computed(
  () => sites.value.filter((site) => site.status === 'pending' || site.status === 'draft').length,
);
const appliedCount = computed(() => sites.value.filter((site) => site.status === 'applied').length);
const failedSites = computed(() =>
  sites.value.filter((site) => site.lastApply !== null && site.lastApply.ok === false),
);

function invalidates(): readonly (readonly unknown[])[] {
  return [
    machineKey(machineId, 'sites'),
    machineKey(machineId, 'certs'),
    machineKey(machineId, 'system'),
  ];
}

const applyAction = useAction(() => api.value.sites.apply({}), {
  success: (result) => `已应用 ${result.sites.length} 个站点（apply #${result.revision}）`,
  successDescription: (result) =>
    result.rolledBack ? '已回滚到应用前配置。' : result.warnings.length > 0 ? `有 ${result.warnings.length} 条警告。` : undefined,
  invalidate: invalidates(),
});

const deleteAction = useAction((site: Site) => api.value.sites.delete(site.id), {
  success: (_result, site) => `已删除站点 ${site.name}`,
  successDescription: '已应用站点需要执行“应用全部更改”后才会从 Caddy 移除。',
  invalidate: [machineKey(machineId, 'sites')],
});

function confirmApply(): void {
  dialog.info({
    title: '应用全部站点',
    content:
      '将渲染所有启用站点到 staging，执行 caddy validate 后备份并 reload。失败会自动回滚，线上保持不变。',
    positiveText: '开始应用',
    negativeText: '取消',
    onPositiveClick: async () => {
      applyError.value = null;
      const result = await applyAction.run();
      if (result !== undefined) {
        applyResult.value = result;
        applyResultOpen.value = true;
      } else {
        applyError.value = applyAction.error.value;
      }
    },
  });
}

function confirmDelete(site: Site): void {
  dialog.warning({
    title: '删除站点',
    content: `确定删除“${site.name}”的草稿？删除已应用站点后，需要应用全部更改才会从 Caddy 移除。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: () => {
      void deleteAction.run(site);
    },
  });
}

function editSite(site: Site): void {
  void router.push(`/m/${machineId}/sites/${site.id}`);
}

function createSite(): void {
  void router.push(`/m/${machineId}/sites/new`);
}

/* --------------------------- 一键容器化 --------------------------- */

function openContainer(mode: 'static' | 'wordpress'): void {
  runPreset.value =
    mode === 'static'
      ? {
          title: '用容器运行静态站点',
          hint: '把站点文件放到 /opt/mpanel/data/www，再把域名反代到 host.docker.internal:8080。',
          input: {
            image: 'nginx:alpine',
            restart: 'unless-stopped',
            ports: ['8080:80'],
            volumes: ['/opt/mpanel/data/www:/usr/share/nginx/html:ro'],
          },
        }
      : {
          title: '用容器运行 WordPress',
          hint: '还需要一个 MySQL/MariaDB；数据库地址填容器名或宿主 IP。',
          input: {
            image: 'wordpress:latest',
            restart: 'unless-stopped',
            ports: ['8080:80'],
            env: { WORDPRESS_DB_HOST: '127.0.0.1:3306', WORDPRESS_DB_NAME: 'wordpress' },
            volumes: ['/opt/mpanel/data/wordpress:/var/www/html'],
          },
        };
  runOpen.value = true;
}

function previewSite(site: Site): void {
  previewRequest.value = { siteId: site.id, validate: caddyAvailable.value };
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
    <PageHeader title="站点">
      <template #meta>
        <n-tag
          v-if="caddyAvailable && pendingCount > 0"
          size="small"
          type="warning"
          round
          :bordered="false"
        >
          {{ pendingCount }} 个待应用
        </n-tag>
        <n-tooltip v-if="!caddyAvailable && !systemQuery.isLoading.value">
          <template #trigger>
            <n-tag size="small" type="warning" round :bordered="false">Caddy 容器未安装</n-tag>
          </template>
          {{ caddyReason }}
        </n-tooltip>
      </template>
      <template v-if="caddyAvailable" #actions>
        <n-button size="small" secondary @click="importOpen = true">
          <template #icon><n-icon :component="CloudUploadOutline" /></template>
          导入 / 导出
        </n-button>
        <n-button
          size="small"
          secondary
          :loading="applyAction.pending.value"
          title="渲染全部启用站点并 caddy validate + reload"
          @click="confirmApply"
        >
          <template #icon><n-icon :component="RocketOutline" /></template>
          应用全部更改
        </n-button>
        <n-dropdown
          trigger="click"
          :options="[
            { label: '用容器运行静态站点', key: 'static' },
            { label: '用容器运行 WordPress', key: 'wordpress' },
          ]"
          @select="(key: string) => openContainer(key as 'static' | 'wordpress')"
        >
          <n-button size="small" secondary>容器化运行</n-button>
        </n-dropdown>
        <n-button size="small" type="primary" @click="createSite">
          <template #icon><n-icon :component="AddOutline" /></template>
          新建站点
        </n-button>
      </template>
    </PageHeader>

    <n-spin v-if="systemQuery.isLoading.value" size="small">
      <div style="height: 140px" />
    </n-spin>

    <n-card v-else-if="!caddyAvailable" size="small" class="install-card">
      <div class="install-hero">
        <span class="install-icon">
          <n-icon :component="GlobeOutline" size="26" />
        </span>
        <div class="install-copy">
          <h2>安装 Caddy 容器</h2>
          <p class="small muted">
            站点功能由 Caddy 容器提供。未安装时站点列表、新建站点与应用配置全部不可用，
            只能先完成这一步安装。
          </p>
          <div class="tiny muted install-path" v-if="systemQuery.data.value?.paths?.caddyConfig">
            配置目录 {{ systemQuery.data.value.paths.caddyConfig }}
          </div>
        </div>
        <div class="install-actions">
          <n-button
            type="primary"
            :disabled="dockerAvailable === false"
            @click="installOpen = true"
          >
            一键安装 Caddy
          </n-button>
          <n-button secondary :loading="checking" @click="checkStatus">
            <template #icon><n-icon :component="RefreshOutline" /></template>
            检查状态
          </n-button>
          <n-button quaternary @click="router.push(`/m/${machineId}/containers`)">
            查看容器
          </n-button>
        </div>
      </div>

      <n-alert
        v-if="dockerAvailable === false"
        type="warning"
        :bordered="false"
        title="需要先安装 Docker"
        style="margin-top: 14px"
      >
        {{ dockerReason || '未检测到可用的 Docker 守护进程。' }}
        <div class="tiny muted">
          安装 Docker Engine 与 Compose v2 后点「检查状态」；Caddy 以容器编排运行，不再使用宿主机二进制。
        </div>
      </n-alert>

      <div v-if="dockerAvailable !== false" class="tiny muted" style="margin-top: 12px">
        当前状态：{{ caddyReason || '正在等待 Caddy 容器' }}
      </div>
    </n-card>

    <template v-else>
      <n-alert v-if="failedSites.length > 0" type="error" :bordered="true" :title="`${failedSites.length} 个站点最近一次应用失败`">
        {{ failedSites.slice(0, 3).map((site) => `${site.name}：${site.lastApply?.error ?? '未知错误'}`).join(' · ') }}
      </n-alert>

      <n-alert v-if="applyError" type="error" :bordered="true" title="应用失败">
        <div>{{ describeError(applyError).description }}</div>
        <div class="small muted">{{ describeError(applyError).hint }}</div>
        <pre v-if="applyOutput" class="code-block" style="margin-top: 8px; max-height: 180px">{{ applyOutput }}</pre>
      </n-alert>

      <div class="filter-bar">
        <n-input v-model:value="search" placeholder="搜索站点或域名…" clearable style="max-width: 260px" />
        <n-select
          v-model:value="enabledFilter"
          style="width: 130px"
          :options="[
            { label: '全部', value: 'all' },
            { label: '启用', value: 'enabled' },
            { label: '禁用', value: 'disabled' },
          ]"
        />
        <div class="spacer" />
        <span class="small muted">{{ filtered.length }} 个站点 · 已应用 {{ appliedCount }}</span>
      </div>

      <error-state v-if="sitesQuery.isError.value" :error="sitesQuery.error.value" @retry="sitesQuery.refetch()" />

      <n-empty v-else-if="sites.length === 0 && !sitesQuery.isLoading.value" description="还没有站点">
        <template #icon><n-icon :component="GlobeOutline" size="36" /></template>
        <template #extra>
          <n-button type="primary" @click="createSite">新建站点</n-button>
        </template>
      </n-empty>

    <n-card v-else size="small" :content-style="{ padding: '0' }">
      <n-table :single-line="false" size="small">
        <thead>
          <tr>
            <th style="min-width: 170px">站点</th>
            <th style="min-width: 170px">域名</th>
            <th style="width: 110px">类型</th>
            <th style="width: 80px">TLS</th>
            <th style="width: 100px">状态</th>
            <th style="width: 120px">证书到期</th>
            <th style="width: 120px">更新时间</th>
            <th style="width: 130px">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="site in filtered" :key="site.id">
            <td>
              <div class="cell">
                <button type="button" class="link-name" @click="editSite(site)">{{ site.name }}</button>
                <span class="mono tiny muted">{{ site.id }}</span>
              </div>
            </td>
            <td>
              <div class="cell">
                <span class="mono small">{{ site.config.domains[0] ?? '—' }}</span>
                <span v-if="site.config.domains.length > 1" class="tiny muted" :title="site.config.domains.slice(1).join('\n')">
                  +{{ site.config.domains.length - 1 }} 个域名
                </span>
              </div>
            </td>
            <td><span class="small muted">{{ HANDLER_LABEL[site.config.handler.type] }}</span></td>
            <td><StatusTag :label="site.config.tls?.mode ?? 'auto'" :type="site.config.tls?.mode === 'off' ? 'default' : 'info'" /></td>
            <td><SiteStatusBadge :status="site.status" /></td>
            <td>
              <div v-if="certForSite(site)" class="cell">
                <StatusTag
                  :label="certForSite(site)!.daysRemaining < 0 ? '已过期' : `${certForSite(site)!.daysRemaining} 天`"
                  :type="certForSite(site)!.daysRemaining < 0 ? 'error' : certForSite(site)!.daysRemaining <= 14 ? 'warning' : 'success'"
                />
                <span class="tiny muted">{{ formatDay(certForSite(site)!.notAfter) }}</span>
              </div>
              <span v-else class="tiny muted">—</span>
            </td>
            <td><RelativeTime :value="site.updatedAt" /></td>
            <td>
              <div class="actions">
                <n-tooltip>
                  <template #trigger>
                    <n-button size="tiny" quaternary @click="previewSite(site)">
                      <template #icon><n-icon :component="EyeOutline" /></template>
                    </n-button>
                  </template>
                  预览 Caddyfile
                </n-tooltip>
                <n-tooltip>
                  <template #trigger>
                    <n-button size="tiny" quaternary @click="editSite(site)">
                      <template #icon><n-icon :component="PencilOutline" /></template>
                    </n-button>
                  </template>
                  编辑
                </n-tooltip>
                <n-tooltip>
                  <template #trigger>
                    <n-button size="tiny" quaternary type="error" @click="confirmDelete(site)">
                      <template #icon><n-icon :component="TrashOutline" /></template>
                    </n-button>
                  </template>
                  删除
                </n-tooltip>
              </div>
            </td>
          </tr>
        </tbody>
      </n-table>
      <div v-if="filtered.length === 0" class="empty-row small muted">没有匹配的站点。</div>
    </n-card>
    </template>

    <SitePreviewModal
      :show="previewRequest !== null"
      :machine-id="machineId"
      :request="previewRequest ?? { site: { domains: [''], handler: { type: 'reverse_proxy', upstreams: [''] } } }"
      @update:show="previewRequest = $event ? previewRequest : null"
    />
    <SiteImportExportModal v-model:show="importOpen" :machine-id="machineId" />
    <ContainerRunModal
      v-model:show="runOpen"
      :machine-id="machineId"
      :preset="runPreset"
    />
    <SiteApplyResultModal v-model:show="applyResultOpen" :result="applyResult" :machine-id="machineId" />
    <StoreInstallModal
      v-model:show="installOpen"
      :machine-id="machineId"
      app-id="caddy"
      title="一键安装 Caddy"
      @installed="checkStatus"
    />
  </div>
</template>

<style scoped>
.cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.link-name {
  border: 0;
  background: transparent;
  padding: 0;
  color: var(--mpanel-text);
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}
.link-name:hover {
  color: var(--mpanel-accent);
}
.actions {
  display: flex;
  gap: 2px;
}
.empty-row {
  padding: 18px;
  text-align: center;
}
.install-card {
  max-width: 920px;
}
.install-hero {
  display: flex;
  align-items: flex-start;
  gap: 14px;
  flex-wrap: wrap;
}
.install-icon {
  display: grid;
  place-items: center;
  width: 46px;
  height: 46px;
  flex: 0 0 auto;
  border-radius: 13px;
  background: var(--mpanel-accent-soft);
  color: var(--mpanel-accent);
}
.install-copy {
  flex: 1 1 320px;
  min-width: 0;
}
.install-copy h2 {
  margin: 0 0 4px;
  font-size: 16px;
  font-weight: 600;
}
.install-copy p {
  margin: 0;
  line-height: 1.65;
}
.install-path {
  margin-top: 6px;
  overflow-wrap: anywhere;
}
.install-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.stack-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}
</style>
