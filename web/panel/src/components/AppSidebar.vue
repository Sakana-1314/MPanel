<script setup lang="ts">
import { computed, h } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  NButton,
  NDropdown,
  NIcon,
  NScrollbar,
  NSpin,
  useMessage,
} from 'naive-ui';
import type { Component } from 'vue';
import {
  AddOutline,
  ChevronUpOutline,
  CubeOutline,
  FlashOutline,
  FolderOpenOutline,
  GitNetworkOutline,
  GlobeOutline,
  GridOutline,
  LayersOutline,
  LogOutOutline,
  MoonOutline,
  ServerOutline,
  SettingsOutline,
  ShieldCheckmarkOutline,
  SunnyOutline,
  TerminalOutline,
  TimeOutline,
} from '@vicons/ionicons5';
import { useMachinesQuery } from '@/lib/machines';
import { activeTab } from '@/lib/workspace';
import {
  MACHINE_NAV_GROUPS,
  isNavItemActive,
  machineNavPath,
  openCorePage,
  openMachinePage,
  type MachineNavItem,
} from '@/lib/navigation';
import { machineStatusType } from '@/lib/status';
import { activeConnection } from '@/lib/connection-store';
import { logout, sessionSnapshot } from '@/lib/session';
import { useTheme } from '@/lib/theme';

const emit = defineEmits<{ quickOpen: [] }>();

const route = useRoute();
const router = useRouter();
const message = useMessage();
const machinesQuery = useMachinesQuery();
const { isDark, toggle } = useTheme();

const machines = computed(() => machinesQuery.data.value?.items ?? []);
const activeMachineId = computed(() => activeTab.value?.machineId ?? null);
const activeMachine = computed(() =>
  machines.value.find((machine) => machine.id === activeMachineId.value),
);

const user = computed(() => sessionSnapshot().user);
const displayName = computed(() => user.value?.displayName ?? user.value?.username ?? '账户');
const initial = computed(() => displayName.value.slice(0, 1).toUpperCase());

const coreNav = [
  { path: '/', title: '概览', icon: GridOutline },
  { path: '/machines', title: '机器', icon: ServerOutline },
  { path: '/edge', title: '边缘节点', icon: GitNetworkOutline },
];

const navIcons: Record<string, Component> = {
  sites: GlobeOutline,
  certs: ShieldCheckmarkOutline,
  postgres: LayersOutline,
  redis: FlashOutline,
  containers: CubeOutline,
  stacks: LayersOutline,
  files: FolderOpenOutline,
  terminal: TerminalOutline,
  tasks: TimeOutline,
};

const accountOptions = [
  {
    label: '设置',
    key: 'settings',
    icon: () => h(NIcon, { component: SettingsOutline }),
  },
  {
    label: '退出登录',
    key: 'logout',
    icon: () => h(NIcon, { component: LogOutOutline }),
  },
];

function isCoreActive(path: string): boolean {
  if (path === '/') return route.path === '/';
  if (path === '/machines') return route.path.startsWith('/machines');
  return route.path === path;
}

function navActive(item: MachineNavItem): boolean {
  return isNavItemActive(activeMachineId.value, item, route.path, route.query);
}

function openMachine(machineId: string): void {
  openMachinePage(machineId, 'sites');
}

function go(path: string): void {
  openCorePage(path, coreNav.find((item) => item.path === path)?.title ?? 'MPanel');
}

function goNav(item: MachineNavItem): void {
  const machineId = activeMachineId.value;
  if (machineId === null) {
    emit('quickOpen');
    return;
  }
  const path = machineNavPath(machineId, item);
  if (route.fullPath !== path) void router.push(path);
}

async function onAccountSelect(key: string): Promise<void> {
  if (key === 'settings') {
    openCorePage('/settings', '设置');
    return;
  }
  if (key === 'logout') {
    try {
      await logout();
    } catch {
      // 即使请求失败也清理本地登录态。
    }
    message.success('已退出登录');
    void router.replace('/login');
  }
}
</script>

<template>
  <div class="sidebar">
    <div class="brand">
      <span class="logo">M</span>
      <div class="brand-text">
        <strong>MPanel</strong>
        <span class="tiny muted">core 多机工作台</span>
      </div>
    </div>

    <n-scrollbar style="flex: 1">
      <nav class="nav">
        <button
          v-for="item in coreNav"
          :key="item.path"
          type="button"
          class="nav-item"
          :class="{ active: isCoreActive(item.path) }"
          @click="go(item.path)"
        >
          <n-icon :component="item.icon" />
          <span>{{ item.title }}</span>
        </button>
      </nav>

      <div class="section">
        <div class="section-title">
          <span>机器工作台</span>
          <n-button size="tiny" quaternary circle title="打开新页面" @click="emit('quickOpen')">
            <template #icon><n-icon :component="AddOutline" /></template>
          </n-button>
        </div>

        <n-spin v-if="machinesQuery.isLoading.value && machines.length === 0" size="small" />
        <div v-else-if="machines.length === 0" class="empty small muted">暂无机器</div>
        <div v-else class="machine-list">
          <button
            v-for="machine in machines"
            :key="machine.id"
            type="button"
            class="machine-item"
            :class="{ active: machine.id === activeMachineId }"
            :title="`打开 ${machine.name} 的站点页（新标签）`"
            @click="openMachine(machine.id)"
          >
            <span class="status-dot" :class="`dot-${machineStatusType(machine.status)}`" />
            <span class="machine-name truncate">{{ machine.name }}</span>
            <span v-if="machine.transport === 'reverse-ws'" class="tiny muted">edge</span>
          </button>
        </div>
      </div>

      <div v-if="activeMachineId !== null" class="section machine-nav">
        <div class="section-title">
          <span class="truncate">{{ activeMachine?.name ?? activeMachineId }}</span>
        </div>
        <div v-for="group in MACHINE_NAV_GROUPS" :key="group.title" class="nav-group">
          <div class="nav-group-title">{{ group.title }}</div>
          <button
            v-for="item in group.items"
            :key="item.key"
            type="button"
            class="nav-item"
            :class="{ active: navActive(item) }"
            @click="goNav(item)"
          >
            <n-icon :component="navIcons[item.key] ?? GlobeOutline" />
            <span>{{ item.title }}</span>
          </button>
        </div>
      </div>
    </n-scrollbar>

    <div class="account-footer">
      <n-dropdown trigger="click" :options="accountOptions" @select="onAccountSelect">
        <button type="button" class="account-btn" title="账号管理">
          <span class="avatar">{{ initial }}</span>
          <span class="account-meta">
            <strong class="truncate">{{ displayName }}</strong>
            <span class="tiny muted truncate">{{ activeConnection?.name ?? '未连接' }}</span>
          </span>
          <n-icon :component="ChevronUpOutline" size="12" class="muted" />
        </button>
      </n-dropdown>
      <n-button
        quaternary
        circle
        size="small"
        :title="isDark ? '浅色主题' : '深色主题'"
        @click="toggle"
      >
        <template #icon><n-icon :component="isDark ? SunnyOutline : MoonOutline" /></template>
      </n-button>
    </div>
  </div>
</template>

<style scoped>
.sidebar {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: color-mix(in srgb, var(--mpanel-surface) 55%, transparent);
  border-right: 1px solid var(--mpanel-border);
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px 4px;
}
.logo {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  background: linear-gradient(135deg, #4f7cff, #7a5cff);
  color: #fff;
  font-weight: 800;
  font-size: 17px;
}
.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
}
.nav {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 0 8px;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 5px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--mpanel-text);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.nav-item:hover {
  background: color-mix(in srgb, var(--mpanel-accent) 10%, transparent);
}
.nav-item.active {
  background: color-mix(in srgb, var(--mpanel-accent) 18%, transparent);
  color: var(--mpanel-accent);
  font-weight: 600;
}
.section {
  padding: 6px;
  border-top: 1px solid var(--mpanel-border);
  margin-top: 4px;
}
.section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 6px 4px;
  font-size: 12px;
  font-weight: 650;
  color: var(--mpanel-text);
}
.machine-nav {
  padding-top: 6px;
}
.nav-group {
  display: flex;
  flex-direction: column;
  gap: 0;
  margin-top: 2px;
}
.nav-group-title {
  padding: 1px 10px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--mpanel-muted);
}
.nav-group .nav-item {
  padding-left: 10px;
}
.machine-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 160px;
  overflow-y: auto;
}
.machine-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 9px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--mpanel-text);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.machine-item:hover {
  background: color-mix(in srgb, var(--mpanel-accent) 8%, transparent);
  border-color: color-mix(in srgb, var(--mpanel-accent) 25%, transparent);
}
.machine-item.active {
  border-color: color-mix(in srgb, var(--mpanel-accent) 45%, transparent);
  background: color-mix(in srgb, var(--mpanel-accent) 12%, transparent);
}
.machine-name {
  flex: 1;
}
.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--mpanel-muted);
  flex: 0 0 auto;
}
.dot-success {
  background: #2fbf71;
}
.dot-warning {
  background: #e6a23c;
}
.dot-error {
  background: #e05561;
}
.dot-info {
  background: #4f7cff;
}
.empty {
  padding: 8px;
  line-height: 1.6;
}
.account-footer {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border-top: 1px solid var(--mpanel-border);
}
.account-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  color: var(--mpanel-text);
  padding: 4px 6px;
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
}
.account-btn:hover {
  background: color-mix(in srgb, var(--mpanel-accent) 8%, transparent);
}
.avatar {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--mpanel-accent) 25%, transparent);
  color: var(--mpanel-accent);
  font-size: 12px;
  font-weight: 700;
  flex: 0 0 auto;
}
.account-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: 1.25;
}
.account-meta strong {
  font-size: 12px;
}
</style>
