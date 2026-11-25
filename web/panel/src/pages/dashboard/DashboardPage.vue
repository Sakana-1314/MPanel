<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useQuery } from '@tanstack/vue-query';
import {
  NAlert,
  NButton,
  NCard,
  NEmpty,
  NIcon,
  NSpin,
  NTag,
  NTooltip,
} from 'naive-ui';
import {
  AddOutline,
  CloseOutline,
  GitNetworkOutline,
  OpenOutline,
  RefreshOutline,
  ServerOutline,
} from '@vicons/ionicons5';
import { useCoreApi } from '@/lib/api';
import { authenticated } from '@/lib/machines';
import { coreKey } from '@/lib/query-keys';
import { usePageActive } from '@/composables/use-page-active';
import { activeConnection } from '@/lib/connection-store';
import { formatUptime } from '@/lib/format';
import {
  activeTabId,
  closeTab,
  setActiveTab,
  tabs,
} from '@/lib/workspace';
import { openCorePage, openMachineDetail, openMachinePage } from '@/lib/navigation';
import PageHeader from '@/components/common/PageHeader.vue';
import ErrorState from '@/components/common/ErrorState.vue';
import StatCard from '@/components/common/StatCard.vue';
import MachineStatusTag from '@/components/common/MachineStatusTag.vue';
import MachineSummaryCard from './MachineSummaryCard.vue';

const router = useRouter();
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

const machineNames = computed(() => {
  const map = new Map<string, string>();
  for (const machine of machines.value) map.set(machine.id, machine.name);
  return map;
});

const workspaceTabs = computed(() =>
  tabs.value.map((tab) => ({
    ...tab,
    machineName: tab.machineId === null ? null : (machineNames.value.get(tab.machineId) ?? tab.machineId),
  })),
);

async function refresh(): Promise<void> {
  refreshing.value = true;
  try {
    await overviewQuery.refetch();
  } finally {
    refreshing.value = false;
  }
}

function focusTab(tab: (typeof workspaceTabs.value)[number]): void {
  setActiveTab(tab.id);
  if (router.currentRoute.value.fullPath !== tab.path) void router.push(tab.path);
}

function close(tab: (typeof workspaceTabs.value)[number]): void {
  const result = closeTab(tab.id);
  void router.push(result.nextPath ?? '/');
}

function openMachine(id: string): void {
  openMachinePage(id, 'sites');
}
</script>

<template>
  <div class="page">
    <PageHeader
      title="概览"
      subtitle="core 控制面总览：所有机器、已打开的多机页面与真实连接状态。前端只连 core，机器请求经 /api/v1/machines/:id/proxy 转发。"
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
      title="无法读取 core 概览"
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
              <strong>core v{{ coreInfo?.version }}</strong>
              <n-tag size="tiny" type="success" round :bordered="false">已连接</n-tag>
            </div>
            <div class="tiny muted">
              {{ coreInfo?.hostname }} · {{ coreInfo?.platform }}/{{ coreInfo?.arch }} ·
              运行 {{ coreInfo ? formatUptime(coreInfo.uptimeSec) : '—' }} ·
              生成于 {{ overview.generatedAt }}
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

      <div class="stat-grid">
        <stat-card label="机器总数" :value="counts?.total ?? 0" hint="core 注册的全部 agent" />
        <stat-card label="在线" :value="counts?.online ?? 0" type="success" hint="心跳正常" />
        <stat-card label="离线" :value="counts?.offline ?? 0" type="error" hint="需要检查网络/进程" />
        <stat-card label="启动中 / 降级" :value="(counts?.starting ?? 0) + (counts?.degraded ?? 0)" type="warning" hint="连接或能力探测中" />
      </div>

      <n-alert v-if="machines.length === 0" type="info" :bordered="true" title="core 上还没有机器">
        先在“机器”页添加 http / stdio / reverse-ws 机器；也可以创建边缘节点入网密钥，让
        NAT 后的 agent 主动连回 core。接入后这里会显示多机卡片与实时快照。
        <div class="toolbar" style="margin-top: 8px">
          <n-button size="small" secondary @click="openCorePage('/machines', '机器')">机器管理</n-button>
          <n-button size="small" quaternary @click="openCorePage('/edge', '边缘节点')">边缘节点</n-button>
        </div>
      </n-alert>

      <!-- 多机混合工作台：同时展示所有机器 -->
      <section>
        <div class="section-head">
          <h2>机器总览</h2>
          <span class="tiny muted">
            每张卡片都可以打开该机器的工作台页面；不同机器的页面会在标签栏中并存，不会互相替换。
          </span>
        </div>
        <div class="card-grid">
          <MachineSummaryCard v-for="machine in machines" :key="machine.id" :machine="machine" />
        </div>
      </section>

      <!-- 已打开的多机页面 -->
      <section>
        <div class="section-head">
          <h2>已打开的多机页面</h2>
          <span class="tiny muted">当前浏览器里混合打开的标签；每个标签独立绑定机器与路由。</span>
        </div>
        <n-card v-if="workspaceTabs.length === 0" size="small">
          <n-empty description="还没有打开的页面">
            <template #extra>
              <n-button size="small" type="primary" @click="openCorePage('/machines', '机器')">从机器页打开</n-button>
            </template>
          </n-empty>
        </n-card>
        <div v-else class="tab-list">
          <div
            v-for="tab in workspaceTabs"
            :key="tab.id"
            class="open-tab"
            :class="{ active: tab.id === activeTabId }"
          >
            <button type="button" class="open-tab-main" @click="focusTab(tab)">
              <n-icon :component="ServerOutline" size="14" class="muted" />
              <span v-if="tab.machineName" class="open-tab-machine truncate">{{ tab.machineName }}</span>
              <span v-if="tab.machineName" class="muted">·</span>
              <span class="truncate">{{ tab.pageTitle }}</span>
            </button>
            <n-button size="tiny" quaternary @click="close(tab)">
              <template #icon><n-icon :component="CloseOutline" /></template>
            </n-button>
          </div>
        </div>
      </section>

      <section>
        <div class="section-head">
          <h2>多机操作</h2>
        </div>
        <div class="card-grid">
          <n-card size="small">
            <div class="quick-title"><n-icon :component="ServerOutline" /> 机器管理</div>
            <p class="small muted">添加、编辑、连接/断开机器，查看健康检查与一次性入网信息。</p>
            <n-button size="small" secondary @click="openCorePage('/machines', '机器')">进入机器页</n-button>
          </n-card>
          <n-card size="small">
            <div class="quick-title"><n-icon :component="GitNetworkOutline" /> 边缘节点</div>
            <p class="small muted">为 NAT 后的 agent 创建入网密钥，按分组批量执行快照、任务与站点应用。</p>
            <n-button size="small" secondary @click="openCorePage('/edge', '边缘节点')">进入边缘页</n-button>
          </n-card>
          <n-card size="small">
            <div class="quick-title"><n-icon :component="OpenOutline" /> 机器详情</div>
            <p class="small muted">任意机器的健康、心跳、能力与快照；也可以直接打开其工作台页面。</p>
            <div class="toolbar">
              <n-button
                v-for="machine in machines.slice(0, 3)"
                :key="machine.id"
                size="tiny"
                quaternary
                @click="openMachineDetail(machine.id)"
              >
                {{ machine.name }}
              </n-button>
              <span v-if="machines.length === 0" class="tiny muted">暂无机器</span>
            </div>
          </n-card>
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
.tab-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.open-tab {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 4px 3px 8px;
  border: 1px solid var(--mpanel-border);
  border-radius: 9px;
  background: var(--mpanel-surface);
  font-size: 12px;
}
.open-tab.active {
  border-color: color-mix(in srgb, var(--mpanel-accent) 55%, transparent);
}
.open-tab-main {
  display: flex;
  align-items: center;
  gap: 5px;
  border: 0;
  background: transparent;
  color: inherit;
  font-size: 12px;
  cursor: pointer;
  max-width: 320px;
}
.open-tab-machine {
  font-weight: 600;
  max-width: 120px;
}
.quick-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  margin-bottom: 4px;
}
.quick-title + p {
  margin: 0 0 10px;
  line-height: 1.6;
}
</style>
