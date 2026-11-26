<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NBadge, NButton, NDropdown, NIcon, NTooltip } from 'naive-ui';
import {
  AddOutline,
  CloseOutline,
  EllipsisHorizontalOutline,
  MenuOutline,
  ServerOutline,
  TimeOutline,
} from '@vicons/ionicons5';
import { useQuery } from '@tanstack/vue-query';
import { useMachinesQuery } from '@/lib/machines';
import { useMachineApi } from '@/lib/api';
import { machineKey } from '@/lib/query-keys';
import {
  activeTabId,
  closeAllTabs,
  closeOtherTabs,
  closeTab,
  activeTab,
  setActiveTab,
  tabs,
} from '@/lib/workspace';
import { machineStatusType } from '@/lib/status';
import JobCenterDrawer from './jobs/JobCenterDrawer.vue';

withDefaults(defineProps<{ mobile?: boolean }>(), { mobile: false });

const emit = defineEmits<{ quickOpen: []; menu: [] }>();

const route = useRoute();
const router = useRouter();
const machinesQuery = useMachinesQuery();

const jobCenterOpen = ref(false);
const jobMachineId = computed(() => activeTab.value?.machineId ?? null);
const jobApi = useMachineApi(() => jobMachineId.value ?? '');
const jobsQuery = useQuery({
  queryKey: computed(() => machineKey(jobMachineId.value ?? '', 'jobs', 'active')),
  queryFn: () => jobApi.value.jobs.list({ limit: 20 }),
  enabled: computed(() => jobMachineId.value !== null),
  refetchInterval: 5_000,
  retry: 0,
});
const activeJobCount = computed(
  () =>
    (jobsQuery.data.value?.items ?? []).filter(
      (job) => job.status === 'queued' || job.status === 'running',
    ).length,
);

const machineMap = computed(() => {
  const map = new Map<string, { name: string; status: string }>();
  for (const machine of machinesQuery.data.value?.items ?? []) {
    map.set(machine.id, { name: machine.name, status: machine.status });
  }
  return map;
});

const items = computed(() =>
  tabs.value.map((tab) => ({
    ...tab,
    machineName: tab.machineId === null ? null : (machineMap.value.get(tab.machineId)?.name ?? tab.machineId),
    status: tab.machineId === null ? null : (machineMap.value.get(tab.machineId)?.status ?? 'offline'),
  })),
);

function activate(id: string, path: string): void {
  setActiveTab(id);
  if (router.currentRoute.value.fullPath !== path) void router.push(path);
}

function close(id: string): void {
  const result = closeTab(id);
  void router.push(result.nextPath ?? '/');
}

function closeOthers(id: string): void {
  closeOtherTabs(id);
  const tab = tabs.value[0];
  if (tab !== undefined && route.fullPath !== tab.path) void router.push(tab.path);
}

function closeAll(): void {
  closeAllTabs();
  void router.push('/');
}

function onMenuSelect(key: string): void {
  if (key === 'close-others' && activeTabId.value !== null) closeOthers(activeTabId.value);
  if (key === 'close-all') closeAll();
}

function statusType(status: string): string {
  return machineStatusType(status as Parameters<typeof machineStatusType>[0]) ?? 'default';
}

const menuOptions = [
  { label: '关闭其他标签', key: 'close-others' },
  { label: '关闭全部标签', key: 'close-all' },
];
</script>

<template>
  <div class="workspace-tabs">
    <n-button
      v-if="mobile"
      size="tiny"
      quaternary
      circle
      class="tab-mobile-menu"
      title="菜单"
      @click="emit('menu')"
    >
      <template #icon><n-icon :component="MenuOutline" /></template>
    </n-button>
    <div class="tabs-scroll">
      <div
        v-for="tab in items"
        :key="tab.id"
        class="tab"
        :class="{ active: tab.id === activeTabId }"
        role="tab"
        :aria-selected="tab.id === activeTabId"
        tabindex="0"
        @click="activate(tab.id, tab.path)"
        @keydown.enter="activate(tab.id, tab.path)"
        @keydown.space.prevent="activate(tab.id, tab.path)"
        @auxclick.middle.prevent="close(tab.id)"
      >
        <span
          v-if="tab.machineId !== null"
          class="tab-dot"
          :class="`dot-${statusType(tab.status ?? 'offline')}`"
        />
        <n-icon v-else :component="ServerOutline" class="muted" size="13" />
        <span v-if="tab.machineName" class="tab-machine truncate">{{ tab.machineName }}</span>
        <span class="tab-sep" v-if="tab.machineName">·</span>
        <span class="tab-title truncate">{{ tab.pageTitle }}</span>
        <button
          type="button"
          class="tab-close"
          title="关闭标签"
          @click.stop="close(tab.id)"
        >
          <n-icon :component="CloseOutline" size="12" />
        </button>
      </div>
      <n-tooltip>
        <template #trigger>
          <n-button size="tiny" quaternary circle class="add-tab" @click="emit('quickOpen')">
            <template #icon><n-icon :component="AddOutline" /></template>
          </n-button>
        </template>
        打开新页面 / 其它机器（Ctrl+K）
      </n-tooltip>
    </div>
    <n-tooltip>
      <template #trigger>
        <n-badge
          :value="activeJobCount"
          :max="9"
          :show="activeJobCount > 0"
          :color="'var(--mpanel-accent)'"
          :offset="[-4, 4]"
        >
          <n-button
            size="tiny"
            quaternary
            circle
            class="tab-menu"
            title="任务中心"
            :disabled="jobMachineId === null"
            @click="jobCenterOpen = true"
          >
            <template #icon><n-icon :component="TimeOutline" /></template>
          </n-button>
        </n-badge>
      </template>
      任务中心
    </n-tooltip>
    <n-dropdown trigger="click" :options="menuOptions" @select="onMenuSelect">
      <n-button size="tiny" quaternary circle class="tab-menu" title="标签页操作">
        <template #icon><n-icon :component="EllipsisHorizontalOutline" /></template>
      </n-button>
    </n-dropdown>
    <JobCenterDrawer v-model:show="jobCenterOpen" :machine-id="jobMachineId" />
  </div>
</template>

<style scoped>
/*
 * 浏览器式标签条：灰色轨道 + 顶部圆角标签 + 选中标签与内容区同色，
 * 用形状和层级明确「这是可切换的标签页」，而不是一排按钮。
 */
.workspace-tabs {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  height: 46px;
  padding: 0 8px;
  min-width: 0;
  background: var(--mpanel-surface-soft);
  border-bottom: 1px solid var(--mpanel-border-muted);
}
.tabs-scroll {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  flex: 1;
  min-width: 0;
  height: 100%;
  padding-top: 7px;
  overflow-x: auto;
  scrollbar-width: none;
}
.tabs-scroll::-webkit-scrollbar {
  display: none;
}
.tab {
  position: relative;
  display: flex;
  align-items: center;
  gap: 5px;
  height: 33px;
  max-width: 230px;
  padding: 0 7px 0 10px;
  border: 1px solid transparent;
  border-bottom: 0;
  border-radius: 9px 9px 0 0;
  font-size: 12px;
  color: var(--mpanel-muted);
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  flex: 0 0 auto;
  transition: background-color 0.14s ease, color 0.14s ease;
}
.tab:hover {
  background: color-mix(in srgb, var(--mpanel-surface) 62%, transparent);
  color: var(--mpanel-text);
}
.tab.active {
  background: var(--mpanel-surface);
  color: var(--mpanel-text);
  border-color: var(--mpanel-border-muted);
  /* 底部一条同色盖住轨道底线，让选中标签与下方内容连成一体。 */
  box-shadow: 0 1px 0 0 var(--mpanel-surface);
}
/* 选中标签顶部的高亮条，进一步强化「当前标签」。 */
.tab.active::before {
  content: '';
  position: absolute;
  top: -1px;
  left: 10px;
  right: 10px;
  height: 2px;
  border-radius: 0 0 2px 2px;
  background: var(--mpanel-accent);
}
.tab-machine {
  max-width: 78px;
  font-weight: 600;
}
.tab-title {
  max-width: 92px;
}
.tab.active .tab-title {
  font-weight: 600;
}
.tab-sep {
  opacity: 0.5;
}
.tab-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  flex: 0 0 auto;
  background: var(--mpanel-status-offline);
}
/* 状态灯只区分「在线=主题蓝」与「离线/异常=灰」。 */
.dot-success,
.dot-info {
  background: var(--mpanel-status-online);
}
.dot-warning,
.dot-error {
  background: var(--mpanel-status-offline);
}
.tab-close {
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  margin-left: 1px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s ease, background-color 0.12s ease;
}
.tab:hover .tab-close,
.tab.active .tab-close,
.tab:focus-within .tab-close {
  opacity: 0.55;
}
.tab-close:hover {
  background: var(--mpanel-surface-inset);
  opacity: 1;
}
.add-tab {
  flex: 0 0 auto;
  margin: 0 2px 6px 3px;
}
.tab-menu {
  flex: 0 0 auto;
  margin-bottom: 6px;
}
.tab-mobile-menu {
  flex: 0 0 auto;
  margin-bottom: 6px;
}
</style>
