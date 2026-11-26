<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NButton, NDropdown, NIcon, NTooltip } from 'naive-ui';
import {
  AddOutline,
  CloseOutline,
  EllipsisHorizontalOutline,
  MenuOutline,
  ServerOutline,
} from '@vicons/ionicons5';
import { useMachinesQuery } from '@/lib/machines';
import {
  activeTabId,
  closeAllTabs,
  closeOtherTabs,
  closeTab,
  setActiveTab,
  tabs,
} from '@/lib/workspace';
import { machineStatusType } from '@/lib/status';

withDefaults(defineProps<{ mobile?: boolean }>(), { mobile: false });

const emit = defineEmits<{ quickOpen: []; menu: [] }>();

const route = useRoute();
const router = useRouter();
const machinesQuery = useMachinesQuery();

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
        role="button"
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
    <n-dropdown trigger="click" :options="menuOptions" @select="onMenuSelect">
      <n-button size="tiny" quaternary circle title="标签页操作">
        <template #icon><n-icon :component="EllipsisHorizontalOutline" /></template>
      </n-button>
    </n-dropdown>
  </div>
</template>

<style scoped>
.workspace-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 48px;
  padding: 0 12px;
  min-width: 0;
  /* 顶栏与侧栏同为白底，构成一条连续的面。 */
  background: var(--mpanel-surface);
}
.tabs-scroll {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}
.tabs-scroll::-webkit-scrollbar {
  display: none;
}
.tab {
  display: flex;
  align-items: center;
  gap: 5px;
  max-width: 260px;
  padding: 5px 7px 5px 9px;
  border: 0;
  border-radius: 7px;
  font-size: 12px;
  color: var(--mpanel-muted);
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  flex: 0 0 auto;
  transition: background-color 0.14s ease, color 0.14s ease;
}
.tab:hover {
  background: var(--mpanel-surface-soft);
  color: var(--mpanel-text);
}
.tab.active {
  background: var(--mpanel-accent-soft);
  color: var(--mpanel-accent);
}
.tab-machine {
  max-width: 90px;
  font-weight: 600;
}
.tab-title {
  max-width: 110px;
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
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  opacity: 0.55;
}
.tab-close:hover {
  background: color-mix(in srgb, var(--mpanel-danger) 18%, transparent);
  opacity: 1;
}
.add-tab {
  flex: 0 0 auto;
}
</style>
