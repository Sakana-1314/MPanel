<script setup lang="ts">
import { computed, ref } from 'vue';
import { useQuery } from '@tanstack/vue-query';
import { NButton, NCard, NIcon, NSpin, NTag } from 'naive-ui';
import { AddOutline, RefreshOutline, ServerOutline } from '@vicons/ionicons5';
import { useCoreApi } from '@/lib/api';
import { authenticated } from '@/lib/machines';
import { coreKey } from '@/lib/query-keys';
import { usePageActive } from '@/composables/use-page-active';
import { activeConnection } from '@/lib/connection-store';
import { formatUptime } from '@/lib/format';
import { openCorePage, openMachinePage } from '@/lib/navigation';
import PageHeader from '@/components/common/PageHeader.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import MachineSummaryCard from './MachineSummaryCard.vue';

const api = useCoreApi();
const active = usePageActive();
const refreshing = ref(false);

const overviewQuery = useQuery({
  queryKey: coreKey('system', 'overview'),
  queryFn: () => api.value.system.overview(),
  enabled: authenticated(),
  staleTime: 5_000,
  refetchInterval: computed(() => (active.value ? 15_000 : false)),
  retry: 1,
});

const overview = computed(() => overviewQuery.data.value);
const machines = computed(() => overview.value?.workers ?? []);
const counts = computed(() => overview.value?.machines);
const coreInfo = computed(() => overview.value?.core);

async function refresh(): Promise<void> {
  refreshing.value = true;
  try {
    await overviewQuery.refetch();
  } finally {
    refreshing.value = false;
  }
}

function openMachine(id: string): void {
  openMachinePage(id, 'sites');
}
</script>

<template>
  <div class="page">
    <PageHeader
      title="概览"
    >
      <template #meta>
        <n-tag v-if="activeConnection" size="small" type="info" round :bordered="false">
          {{ activeConnection.name }}
        </n-tag>
        <span class="tiny muted mono">{{ activeConnection?.baseUrl }}</span>
      </template>
      <template #actions>
        <n-button size="small" secondary :loading="refreshing" @click="refresh">
          <template #icon><n-icon :component="RefreshOutline" /></template>
          刷新
        </n-button>
        <n-button size="small" type="primary" @click="openCorePage('/machines', '机器')">
          <template #icon><n-icon :component="AddOutline" /></template>
          管理机器
        </n-button>
      </template>
    </PageHeader>

    <error-state
      v-if="overviewQuery.isError.value"
      :error="overviewQuery.error.value"
      title="无法读取面板概览"
      @retry="overviewQuery.refetch()"
    />

    <n-spin v-if="overviewQuery.isLoading.value && overview === undefined" size="large">
      <div style="height: 120px" />
    </n-spin>

    <template v-if="overview">
      <n-card size="small">
        <div class="hero">
          <div class="hero-left">
            <div class="hero-title">
              <span class="core-dot" />
              <strong>MPanel v{{ coreInfo?.version }}</strong>
              <n-tag size="tiny" type="success" round :bordered="false">已连接</n-tag>
            </div>
            <div class="tiny muted">
              {{ coreInfo?.hostname }} · {{ coreInfo?.platform }}/{{ coreInfo?.arch }} ·
              {{ coreInfo ? formatUptime(coreInfo.uptimeSec) : '—' }}
            </div>
          </div>
          <div class="hero-counts">
            <div class="count"><span class="num">{{ counts?.total ?? 0 }}</span><span class="tiny muted">机器</span></div>
            <div class="count"><span class="num success">{{ counts?.online ?? 0 }}</span><span class="tiny muted">在线</span></div>
            <div class="count"><span class="num warning">{{ (counts?.degraded ?? 0) + (counts?.starting ?? 0) }}</span><span class="tiny muted">过渡</span></div>
            <div class="count"><span class="num error">{{ (counts?.offline ?? 0) + (counts?.error ?? 0) }}</span><span class="tiny muted">异常</span></div>
          </div>
        </div>
      </n-card>

      <n-card v-if="machines.length === 0" size="small">
        <div class="empty-machines">
          <n-icon :component="ServerOutline" size="28" class="muted" />
          <span>还没有机器</span>
          <div class="toolbar">
            <n-button size="small" type="primary" @click="openCorePage('/machines', '机器')">添加机器</n-button>
            <n-button size="small" quaternary @click="openCorePage('/edge', '边缘节点')">边缘接入</n-button>
          </div>
        </div>
      </n-card>

      <!-- 多机混合工作台：同时展示所有机器 -->
      <section>
        <div class="section-head"><h2>机器</h2></div>
        <div class="card-grid">
          <MachineSummaryCard v-for="machine in machines" :key="machine.id" :machine="machine" />
        </div>
      </section>

    </template>
  </div>
</template>

<style scoped>
.hero {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.hero-left {
  min-width: 0;
}
.hero-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
}
.core-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: #2fbf71;
  box-shadow: 0 0 0 4px color-mix(in srgb, #2fbf71 18%, transparent);
}
.hero-counts {
  display: flex;
  gap: 20px;
  flex-wrap: wrap;
}
.count {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}
.num {
  font-size: 22px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.num.success {
  color: #2fbf71;
}
.num.warning {
  color: #e6a23c;
}
.num.error {
  color: #e05561;
}
.section-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 12px;
  margin-bottom: 8px;
}
.section-head h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 650;
}
.empty-machines {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 22px;
}
.empty-machines > span {
  font-size: 13px;
  color: var(--mpanel-muted);
}
</style>
