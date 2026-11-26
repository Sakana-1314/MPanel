<script setup lang="ts">
import { computed, h, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NButton, NDropdown, NIcon, NScrollbar, NSpin, useMessage } from 'naive-ui';
import type { Component } from 'vue';
import {
  AddOutline,
  ChevronDownOutline,
  ChevronForwardOutline,
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
import { transportLabel } from '@/lib/format';
import logoMark from '@/assets/logo-mark.png';

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

const machineNav = [
  { path: '/machines', title: '机器总览', icon: ServerOutline },
  { path: '/settings', title: '设置', icon: SettingsOutline },
];

const navIcons: Record<string, Component> = {
  sites: GlobeOutline,
  certs: ShieldCheckmarkOutline,
  postgres: LayersOutline,
  redis: FlashOutline,
  containers: CubeOutline,
  'container-config': SettingsOutline,
  images: LayersOutline,
  stacks: LayersOutline,
  files: FolderOpenOutline,
  terminal: TerminalOutline,
  tasks: TimeOutline,
};

/**
 * 手风琴：同一时刻只展开一个分组。
 * 默认展开当前路由命中的分组，切换机器时重新对齐。
 */
const openGroup = ref<string | null>(null);

function groupOfActiveItem(): string | null {
  const machineId = activeMachineId.value;
  if (machineId === null) return null;
  for (const group of MACHINE_NAV_GROUPS) {
    if (group.items.some((item) => isNavItemActive(machineId, item, route.path, route.query))) {
      return group.title;
    }
  }
  return null;
}

watch(
  () => [route.fullPath, activeMachineId.value] as const,
  () => {
    const current = groupOfActiveItem();
    if (current !== null) openGroup.value = current;
  },
  { immediate: true },
);

function toggleGroup(title: string): void {
  openGroup.value = openGroup.value === title ? null : title;
}

const accountOptions = [
  { label: '设置', key: 'settings', icon: () => h(NIcon, { component: SettingsOutline }) },
  { label: '退出登录', key: 'logout', icon: () => h(NIcon, { component: LogOutOutline }) },
];

function navActive(item: MachineNavItem): boolean {
  return isNavItemActive(activeMachineId.value, item, route.path, route.query);
}

function openMachine(machineId: string): void {
  openMachinePage(machineId, 'sites');
}

function go(path: string, title: string): void {
  openCorePage(path, title);
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
      <span class="logo"><img :src="logoMark" alt="MPanel" /></span>
      <div class="brand-text">
        <strong>MPanel</strong>
        <span class="tiny muted">服务器管理面板</span>
      </div>
    </div>

    <n-scrollbar style="flex: 1">
      <div class="roll">
        <!-- 机器切换器 -->
        <section class="machine-switch">
          <button
            v-for="machine in machines"
            :key="machine.id"
            type="button"
            class="machine-row"
            :class="{ active: machine.id === activeMachineId }"
            :title="machine.name"
            @click="openMachine(machine.id)"
          >
            <span class="status-dot" :class="`dot-${machineStatusType(machine.status)}`" />
            <span class="machine-name truncate">{{ machine.name }}</span>
            <span class="tiny muted transport">{{ transportLabel(machine.transport) }}</span>
          </button>
          <n-spin v-if="machinesQuery.isLoading.value && machines.length === 0" size="small" />
          <div v-else-if="machines.length === 0" class="empty tiny muted">还没有机器</div>
        </section>

        <!-- 机器导航手风琴 -->
        <nav v-if="activeMachineId !== null" class="accordion" aria-label="机器导航">
          <div v-for="group in MACHINE_NAV_GROUPS" :key="group.title" class="acc-group">
            <button
              type="button"
              class="acc-head"
              :class="{ open: openGroup === group.title }"
              :aria-expanded="openGroup === group.title"
              @click="toggleGroup(group.title)"
            >
              <n-icon
                :component="openGroup === group.title ? ChevronDownOutline : ChevronForwardOutline"
                size="12"
                class="acc-chevron"
              />
              <span class="acc-title">{{ group.title }}</span>
              <span v-if="openGroup !== group.title" class="acc-count">{{ group.items.length }}</span>
            </button>
            <div v-show="openGroup === group.title" class="acc-body">
              <button
                v-for="item in group.items"
                :key="item.key"
                type="button"
                class="acc-item"
                :class="{ active: navActive(item) }"
                @click="goNav(item)"
              >
                <n-icon :component="navIcons[item.key] ?? GlobeOutline" size="14" />
                <span class="truncate">{{ item.title }}</span>
              </button>
            </div>
          </div>
        </nav>

        <nav class="bottom-nav">
          <button
            v-for="item in machineNav"
            :key="item.path"
            type="button"
            class="flat-item"
            :class="{ active: route.path === item.path }"
            @click="go(item.path, item.title)"
          >
            <n-icon :component="item.icon" size="15" />
            <span>{{ item.title }}</span>
          </button>
          <button type="button" class="flat-item" @click="emit('quickOpen')">
            <n-icon :component="AddOutline" size="15" />
            <span>打开新页面</span>
          </button>
        </nav>
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
        </button>
      </n-dropdown>
      <n-button quaternary circle size="small" :title="isDark ? '浅色主题' : '深色主题'" @click="toggle">
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
  background: var(--mpanel-bg);
}
.brand {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 14px 14px 10px;
}
.logo {
  width: 34px;
  height: 26px;
  display: grid;
  place-items: center;
  padding: 2px 4px;
  border-radius: 6px;
  background: #fff;
  border: 1px solid var(--mpanel-border-muted);
  flex: 0 0 auto;
}
.logo img {
  display: block;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.25;
  min-width: 0;
}
.brand-text strong {
  font-size: 13px;
  font-weight: 600;
}
.roll {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 0 8px 12px;
}

/* --------------------------- machine switcher --------------------------- */

.machine-switch {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 6px;
  border-radius: 10px;
  background: var(--mpanel-surface-inset);
}
.machine-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--mpanel-text);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.machine-row:hover {
  background: color-mix(in srgb, var(--mpanel-surface) 55%, transparent);
}
.machine-row.active {
  background: var(--mpanel-surface);
  box-shadow: var(--mpanel-shadow);
  font-weight: 600;
}
.machine-name {
  flex: 1;
  min-width: 0;
}
.transport {
  flex: 0 0 auto;
  opacity: 0.75;
}
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--mpanel-muted);
  flex: 0 0 auto;
}

/* ------------------------------- accordion ------------------------------ */

.accordion {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.acc-group {
  display: flex;
  flex-direction: column;
}
.acc-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--mpanel-muted);
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.01em;
  text-align: left;
  cursor: pointer;
}
.acc-head:hover {
  color: var(--mpanel-text);
  background: var(--mpanel-surface-soft);
}
.acc-head.open {
  color: var(--mpanel-text);
}
.acc-chevron {
  flex: 0 0 auto;
  opacity: 0.8;
}
.acc-title {
  flex: 1;
}
.acc-count {
  font-size: 10.5px;
  font-weight: 500;
  opacity: 0.65;
  font-variant-numeric: tabular-nums;
}
.acc-body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 3px;
  margin: 2px 0 4px;
  border-radius: 9px;
  background: var(--mpanel-surface-inset);
}
.acc-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 5px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--mpanel-text);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.acc-item:hover {
  background: var(--mpanel-surface-soft);
}
.acc-item.active {
  background: var(--mpanel-accent-soft);
  color: var(--mpanel-accent);
  font-weight: 600;
}

/* ------------------------------ bottom nav ------------------------------ */

.bottom-nav {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 6px;
  margin-top: 2px;
  border-radius: 10px;
  background: var(--mpanel-surface-inset);
}
.flat-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--mpanel-text);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
}
.flat-item:hover {
  background: var(--mpanel-surface-soft);
}
.flat-item.active {
  background: var(--mpanel-accent-soft);
  color: var(--mpanel-accent);
  font-weight: 600;
}
.empty {
  padding: 6px 8px;
}

/* -------------------------------- footer -------------------------------- */

.account-footer {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px;
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
  border-radius: 6px;
  cursor: pointer;
  text-align: left;
}
.account-btn:hover {
  background: var(--mpanel-surface-soft);
}
.avatar {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: var(--mpanel-accent);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
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
