<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import {
  NAlert,
  NButton,
  NCard,
  NDrawer,
  NDrawerContent,
  NEmpty,
  NIcon,
  NInput,
  NSelect,
  NTable,
  NTag,
} from 'naive-ui';
import { EyeOutline, RefreshOutline, ShieldCheckmarkOutline } from '@vicons/ionicons5';
import type { CertificateInfo } from '@/api/types';
import { useMachineApi } from '@/lib/api';
import { machineKey } from '@/lib/query-keys';
import { formatDate, formatDay, formatDaysRemaining } from '@/lib/format';
import { certStatusLabel, certStatusType } from '@/lib/status';
import PageHeader from '@/components/common/PageHeader.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import StatusTag from '@/components/common/StatusTag.vue';
import CopyButton from '@/components/common/CopyButton.vue';

const route = useRoute();
const machineId = String(route.params.machineId ?? '');
const api = useMachineApi(machineId);

const search = ref('');
const windowFilter = ref('all');
const selected = ref<CertificateInfo | null>(null);

const certsQuery = useQuery({
  queryKey: computed(() => machineKey(machineId, 'certs', 'list', { limit: 200, includeExpired: true })),
  queryFn: () => api.value.certs.list({ limit: 200, includeExpired: true }),
  retry: 1,
});

const certs = computed(() => certsQuery.data.value?.items ?? []);
const available = computed(() => certsQuery.data.value?.available !== false);

const counts = computed(() => {
  let valid = 0;
  let expiring30 = 0;
  let expiring14 = 0;
  let expiring7 = 0;
  let expired = 0;
  for (const cert of certs.value) {
    if (cert.daysRemaining < 0) expired += 1;
    else {
      valid += 1;
      if (cert.daysRemaining <= 30) expiring30 += 1;
      if (cert.daysRemaining <= 14) expiring14 += 1;
      if (cert.daysRemaining <= 7) expiring7 += 1;
    }
  }
  return { valid, expiring30, expiring14, expiring7, expired };
});

const filtered = computed(() => {
  const needle = search.value.trim().toLowerCase();
  return certs.value.filter((cert) => {
    if (windowFilter.value === 'expired' && cert.daysRemaining >= 0) return false;
    if (windowFilter.value === '7' && (cert.daysRemaining < 0 || cert.daysRemaining > 7)) return false;
    if (windowFilter.value === '14' && (cert.daysRemaining < 0 || cert.daysRemaining > 14)) return false;
    if (windowFilter.value === '30' && (cert.daysRemaining < 0 || cert.daysRemaining > 30)) return false;
    if (needle.length === 0) return true;
    return (
      cert.domains.some((domain) => domain.toLowerCase().includes(needle)) ||
      (cert.commonName ?? '').toLowerCase().includes(needle) ||
      cert.issuer.toLowerCase().includes(needle)
    );
  });
});

function daysType(days: number): 'error' | 'warning' | 'success' {
  if (days < 0 || days <= 7) return 'error';
  if (days <= 30) return 'warning';
  return 'success';
}

function displayDomains(cert: CertificateInfo): string[] {
  return cert.domains.length === 0 ? (cert.commonName === null ? [] : [cert.commonName]) : cert.domains;
}
</script>

<template>
  <div class="page">
    <PageHeader title="证书">
      <template #meta>
        <n-tag v-if="counts.expiring30 > 0" size="small" type="warning" round :bordered="false">
          {{ counts.expiring30 }} 张 30 天内到期
        </n-tag>
        <n-tag v-if="counts.expired > 0" size="small" type="error" round :bordered="false">
          {{ counts.expired }} 张已过期
        </n-tag>
      </template>
      <template #actions>
        <n-button size="small" secondary :loading="certsQuery.isFetching.value" @click="certsQuery.refetch()">
          <template #icon><n-icon :component="RefreshOutline" /></template>
          刷新
        </n-button>
      </template>
    </PageHeader>

    <n-alert v-if="!available" type="warning" :bordered="true" title="Caddy 数据目录不可用">
      {{ certsQuery.data.value?.reason ?? '服务返回不可用，无法扫描证书。' }}
      请确认服务器上的 Caddy 数据目录可读后刷新。
    </n-alert>

    <error-state v-if="certsQuery.isError.value" :error="certsQuery.error.value" @retry="certsQuery.refetch()" />

    <div class="filter-bar">
      <n-input v-model:value="search" placeholder="搜索域名或颁发者…" clearable style="max-width: 260px" />
      <n-select
        v-model:value="windowFilter"
        style="width: 150px"
        :options="[
          { label: '全部', value: 'all' },
          { label: '30 天内', value: '30' },
          { label: '14 天内', value: '14' },
          { label: '7 天内', value: '7' },
          { label: '已过期', value: 'expired' },
        ]"
      />
      <div class="spacer" />
      <span class="small muted">{{ filtered.length }} 张证书</span>
    </div>

    <n-empty v-if="certs.length === 0 && !certsQuery.isLoading.value" description="还没有证书">
      <template #icon><n-icon :component="ShieldCheckmarkOutline" size="36" /></template>
      <template #extra>

      </template>
    </n-empty>

    <n-card v-else size="small" :content-style="{ padding: '0' }">
      <n-table :single-line="false" size="small">
        <thead>
          <tr>
            <th style="min-width: 190px">域名</th>
            <th style="min-width: 160px">颁发者</th>
            <th style="width: 120px">到期时间</th>
            <th style="width: 100px">剩余天数</th>
            <th style="width: 90px">状态</th>
            <th style="min-width: 200px">路径</th>
            <th style="width: 60px">详情</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="cert in filtered" :key="cert.id">
            <td>
              <div class="cell">
                <span class="mono small">{{ displayDomains(cert)[0] ?? '—' }}</span>
                <span v-if="displayDomains(cert).length > 1" class="tiny muted" :title="displayDomains(cert).slice(1).join('\n')">
                  +{{ displayDomains(cert).length - 1 }} 个域名
                </span>
              </div>
            </td>
            <td><span class="small muted truncate" style="max-width: 220px; display: inline-block">{{ cert.issuer }}</span></td>
            <td>
              <div class="cell">
                <span class="small">{{ formatDay(cert.notAfter) }}</span>
                <span class="tiny muted">{{ cert.source }}</span>
              </div>
            </td>
            <td><StatusTag :label="`${cert.daysRemaining} 天`" :type="daysType(cert.daysRemaining)" /></td>
            <td><StatusTag :label="certStatusLabel(cert.status)" :type="certStatusType(cert.status)" /></td>
            <td><span class="mono tiny muted truncate" style="max-width: 240px; display: inline-block" :title="cert.path">{{ cert.path }}</span></td>
            <td>
              <n-button size="tiny" quaternary @click="selected = cert">
                <template #icon><n-icon :component="EyeOutline" /></template>
              </n-button>
            </td>
          </tr>
        </tbody>
      </n-table>
      <div v-if="filtered.length === 0" class="empty-row small muted">没有匹配的证书。</div>
    </n-card>

    <n-drawer :show="selected !== null" :width="620" placement="right" @update:show="selected = null">
      <n-drawer-content
        :title="selected?.commonName ?? selected?.domains[0] ?? '证书详情'"
        closable
      >
        <div v-if="selected" class="detail">
          <n-alert
            v-if="selected.daysRemaining < 0"
            type="error"
            :bordered="true"
            title="证书已过期"
          >
            {{ formatDaysRemaining(selected.daysRemaining) }}。请检查 Caddy 日志与 ACME 验证。
          </n-alert>
          <n-alert
            v-else-if="selected.daysRemaining <= 14"
            type="warning"
            :bordered="true"
            title="证书即将到期"
          >
            {{ formatDaysRemaining(selected.daysRemaining) }}。若 Caddy 自动续期失败，请排查 ACME 挑战。
          </n-alert>
          <div class="toolbar">
            <StatusTag :label="certStatusLabel(selected.status)" :type="certStatusType(selected.status)" />
            <span class="small muted">{{ formatDaysRemaining(selected.daysRemaining) }}</span>
          </div>
          <div class="kv">
            <dt>域名</dt>
            <dd>
              <div class="toolbar">
                <n-tag v-for="domain in displayDomains(selected)" :key="domain" size="tiny" :bordered="false" class="mono">
                  {{ domain }}
                </n-tag>
              </div>
            </dd>
            <dt>Common Name</dt><dd>{{ selected.commonName ?? '—' }}</dd>
            <dt>颁发者</dt><dd>{{ selected.issuer }}</dd>
            <dt>主题</dt><dd>{{ selected.subject }}</dd>
            <dt>生效时间</dt><dd>{{ formatDate(selected.notBefore) }}</dd>
            <dt>到期时间</dt><dd>{{ formatDate(selected.notAfter) }}</dd>
            <dt>剩余天数</dt><dd>{{ selected.daysRemaining }} 天</dd>
            <dt>密钥类型</dt><dd>{{ selected.keyType ?? '—' }}</dd>
            <dt>来源</dt><dd class="mono">{{ selected.source }}</dd>
            <dt>序列号</dt>
            <dd><span class="mono tiny break">{{ selected.serialNumber }}</span><CopyButton :text="selected.serialNumber" /></dd>
            <dt>SHA-256</dt>
            <dd><span class="mono tiny break">{{ selected.fingerprintSha256 }}</span><CopyButton :text="selected.fingerprintSha256" /></dd>
            <dt>路径</dt>
            <dd><span class="mono tiny break">{{ selected.path }}</span><CopyButton :text="selected.path" /></dd>
          </div>
        </div>
      </n-drawer-content>
    </n-drawer>
  </div>
</template>

<style scoped>
.cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.empty-row {
  padding: 18px;
  text-align: center;
}
.detail {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.break {
  display: block;
  overflow-wrap: anywhere;
}
</style>
