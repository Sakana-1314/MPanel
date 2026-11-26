<script setup lang="ts">
import { computed, h, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  NButton,
  NIcon,
  NMenu,
  NPopover,
  NScrollbar,
  NSpin,
  useMessage,
} from 'naive-ui';
import type { Component } from 'vue';
import type { MenuOption } from 'naive-ui';
import {
  AddOutline,
  ChevronForwardOutline,
  ChevronUpOutline,
  CubeOutline,
  FlashOutline,
  FolderOpenOutline,
  GlobeOutline,
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
} from '@/lib/navigation';
import { machineStatusType } from '@/lib/status';
import { activeConnection } from '@/lib/connection-store';
import { logout, sessionSnapshot } from '@/lib/session';
import { useTheme } from '@/lib/theme';
import { transportLabel } from '@/lib/format';
import logoMark from '@/assets/logo-square.png';

const emit = defineEmits<{ quickOpen: [] }>();

const route = useRoute();
const router = useRouter();
const message = useMessage();
const machinesQuery = useMachinesQuery();
const { isDark, toggle } = useTheme();

const machines = computed(() => machinesQuery.data.value?.items ?? []);
const activeMachineId = computed(() => activeTab.value?.machineId ?? null);

const user = computed(() => sessionSnapshot().user);
const displayName = computed(() => user.value?.displayName ?? user.value?.username ?? '账户');
const initial = computed(() => displayName.value.slice(0, 1).toUpperCase());
const roleLabel = computed(() => (activeConnection.value?.name ? '管理员' : '未连接'));

function renderIcon(component: Component): () => ReturnType<typeof h> {
  return () => h(NIcon, { component, size: 17 });
}

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

/** 分组 key → 组内菜单项；用于「进哪个页面就展开哪个分组」。 */
function groupKey(title: string): string {
  return `group:${title}`;
}

const menuOptions = computed<MenuOption[]>(() =>
  MACHINE_NAV_GROUPS.map((group) => ({
    key: groupKey(group.title),
    label: group.title,
    children: group.items.map((item) => ({
      key: item.key,
      label: item.title,
      icon: renderIcon(navIcons[item.key] ?? GlobeOutline),
    })),
  })),
);

/** 当前高亮的菜单项；不在机器页面时为空。 */
const activeKey = computed<string | null>(() => {
  const machineId = activeMachineId.value;
  if (machineId === null) return null;
  for (const group of MACHINE_NAV_GROUPS) {
    for (const item of group.items) {
      if (isNavItemActive(machineId, item, route.path, route.query)) return item.key;
    }
  }
  return null;
});

/**
 * 展开的分组：手风琴模式，同一时间只保留一个。
 * 用户点开新分组时收起其它分组；路由进入某页面时自动展开所在分组。
 */
const expandedKeys = ref<Array<string | number>>([]);

function onExpandedKeys(keys: Array<string | number>): void {
  expandedKeys.value = keys.length === 0 ? [] : [keys[keys.length - 1]];
}

watch(
  () => [route.fullPath, activeMachineId.value] as const,
  () => {
    const machineId = activeMachineId.value;
    if (machineId === null) {
      expandedKeys.value = [];
      return;
    }
    for (const group of MACHINE_NAV_GROUPS) {
      if (group.items.some((item) => isNavItemActive(machineId, item, route.path, route.query))) {
        expandedKeys.value = [groupKey(group.title)];
        return;
      }
    }
    expandedKeys.value = [];
  },
  { immediate: true },
);

function onMenuSelect(key: string): void {
  if (key.startsWith('group:')) return;
  const machineId = activeMachineId.value;
  if (machineId === null) {
    emit('quickOpen');
    return;
  }
  const item = MACHINE_NAV_GROUPS.flatMap((group) => group.items).find((entry) => entry.key === key);
  if (item === undefined) return;
  const path = machineNavPath(machineId, item);
  if (route.fullPath !== path) void router.push(path);
}

function openMachine(machineId: string): void {
  openMachinePage(machineId, 'sites');
}

const accountOpen = ref(false);

function goMachines(): void {
  accountOpen.value = false;
  openCorePage('/machines', '机器总览');
}

function goSettings(): void {
  accountOpen.value = false;
  openCorePage('/settings', '设置');
}

function goQuickOpen(): void {
  accountOpen.value = false;
  emit('quickOpen');
}

async function onLogout(): Promise<void> {
  accountOpen.value = false;
  try {
    await logout();
  } catch {
    // 即使请求失败也清理本地登录态。
  }
  message.success('已退出登录');
  void router.replace('/login');
}
</script>

<template>
  <div class="sidebar">
    <div class="brand">
      <span class="logo"><img :src="logoMark" alt="MPanel" /></span>
      <span class="brand-name">MPanel</span>
    </div>

    <n-scrollbar style="flex: 1">
      <div class="roll">
        <section class="machines" aria-label="机器">
          <div class="section-label">机器</div>
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
            <span class="machine-transport">{{ transportLabel(machine.transport) }}</span>
          </button>
          <n-spin v-if="machinesQuery.isLoading.value && machines.length === 0" size="small" />
          <div v-else-if="machines.length === 0" class="machine-empty">还没有机器</div>
        </section>

        <n-menu
          v-if="activeMachineId !== null"
          :value="activeKey ?? undefined"
          :options="menuOptions"
          :expanded-keys="expandedKeys"
          :indent="16"
          @update:value="onMenuSelect"
          @update:expanded-keys="onExpandedKeys"
        />
      </div>
    </n-scrollbar>

    <div class="account-footer">
      <n-popover
        v-model:show="accountOpen"
        placement="right-end"
        trigger="click"
        :show-arrow="false"
        :width="272"
        raw
      >
        <template #trigger>
          <button type="button" class="account-btn" title="账号与设置">
            <span class="avatar">{{ initial }}</span>
            <span class="account-meta">
              <strong class="truncate">{{ displayName }}</strong>
              <span class="account-sub truncate">{{ roleLabel }}</span>
            </span>
            <n-icon :component="ChevronUpOutline" size="14" class="account-caret" />
          </button>
        </template>

        <div class="panel">
          <div class="panel-identity">
            <span class="avatar avatar-lg">{{ initial }}</span>
            <span class="account-meta">
              <strong class="truncate">{{ displayName }}</strong>
              <span class="account-sub truncate">{{ activeConnection?.name ?? '未连接' }}</span>
            </span>
          </div>

          <div class="panel-section">
            <div class="panel-title">外观</div>
            <div class="segmented" role="radiogroup" aria-label="外观">
              <button
                type="button"
                role="radio"
                class="segmented-item"
                :class="{ on: !isDark }"
                :aria-checked="!isDark"
                @click="isDark && toggle()"
              >
                <n-icon :component="SunnyOutline" size="15" />
                浅色
              </button>
              <button
                type="button"
                role="radio"
                class="segmented-item"
                :class="{ on: isDark }"
                :aria-checked="isDark"
                @click="!isDark && toggle()"
              >
                <n-icon :component="MoonOutline" size="15" />
                深色
              </button>
            </div>
          </div>

          <div class="panel-section panel-actions">
            <button type="button" class="panel-action" @click="goMachines">
              <n-icon :component="ServerOutline" size="16" />
              机器总览
            </button>
            <button type="button" class="panel-action" @click="goSettings">
              <n-icon :component="SettingsOutline" size="16" />
              设置
            </button>
            <button type="button" class="panel-action" @click="goQuickOpen">
              <n-icon :component="AddOutline" size="16" />
              打开新页面
            </button>
          </div>

          <div class="panel-footer">
            <button type="button" class="panel-logout" @click="onLogout">
              <n-icon :component="LogOutOutline" size="16" />
              退出登录
            </button>
          </div>
        </div>
      </n-popover>
    </div>
  </div>
</template>

<style scoped>
.sidebar {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-width: 0;
  background: var(--mpanel-surface);
}

/* 品牌区与御坂学习管理端一致：64px 高、只留 logo 与产品名。 */
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 64px;
  padding: 0 20px;
  flex: 0 0 auto;
}
.logo {
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  flex: 0 0 auto;
}
.logo img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.brand-name {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.01em;
}

.roll {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0 10px 16px;
}

/* ------------------------------ 机器切换器 ------------------------------ */

.section-label {
  padding: 4px 10px 6px;
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--mpanel-muted);
}
.machines {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.machine-row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  height: 34px;
  padding: 0 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--mpanel-text);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.14s ease, color 0.14s ease;
}
.machine-row:hover {
  background: var(--mpanel-surface-soft);
}
.machine-row.active {
  background: var(--mpanel-accent-soft);
  color: var(--mpanel-accent);
  font-weight: 600;
}
.machine-name {
  flex: 1;
  min-width: 0;
}
.machine-transport {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--mpanel-muted);
  opacity: 0.8;
}
.machine-row.active .machine-transport {
  color: var(--mpanel-accent);
  opacity: 0.75;
}
.machine-empty {
  padding: 6px 10px;
  font-size: 12px;
  color: var(--mpanel-muted);
}

/* 状态灯只有两种颜色：主题蓝=在线，中性灰=离线/异常。 */
.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--mpanel-status-offline);
  flex: 0 0 auto;
}
.status-dot.dot-success,
.status-dot.dot-info {
  background: var(--mpanel-status-online);
}

/* ------------------------------- 菜单微调 ------------------------------- */

:deep(.n-menu) {
  --n-item-height: 34px;
  font-size: 13px;
}
/* 选中态是一块圆角色块，不是贴满侧栏的横条（与御坂学习一致）。 */
:deep(.n-menu .n-menu-item-content) {
  padding-left: 10px !important;
  border-radius: 8px;
}
:deep(.n-menu .n-menu-item-content::before) {
  left: 0;
  right: 0;
  border-radius: 8px;
}
:deep(.n-menu .n-menu-item-content-header) {
  font-size: 13px;
}
/* 分组标题与机器区标题同一套字号/字重，层级才一致。 */
:deep(.n-menu-item-group-title) {
  padding: 10px 10px 6px !important;
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--mpanel-muted);
}
:deep(.n-menu-item-group .n-menu-item-content) {
  padding-left: 22px !important;
}

/* ------------------------------- 账号区 -------------------------------- */

.account-footer {
  flex: 0 0 auto;
  padding: 10px 12px 12px;
}
.account-btn {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-width: 0;
  padding: 8px 10px;
  border: 0;
  border-radius: 10px;
  background: var(--mpanel-surface-soft);
  color: var(--mpanel-text);
  text-align: left;
  cursor: pointer;
  transition: background-color 0.15s ease;
}
.account-btn:hover {
  background: var(--mpanel-surface-inset);
}
.avatar {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: var(--mpanel-accent);
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  flex: 0 0 auto;
}
.avatar-lg {
  width: 38px;
  height: 38px;
  font-size: 15px;
}
.account-meta {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
  line-height: 1.3;
}
.account-meta strong {
  font-size: 13px;
  font-weight: 600;
}
.account-sub {
  font-size: 11.5px;
  color: var(--mpanel-muted);
}
.account-caret {
  flex: 0 0 auto;
  color: var(--mpanel-muted);
}

/* ------------------------------ 弹出面板 ------------------------------- */

.panel {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px;
  border-radius: 12px;
  background: var(--mpanel-surface);
  box-shadow: var(--mpanel-shadow-raised);
}
.panel-identity {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px 10px;
}
.panel-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
}
.panel-title {
  font-size: 11.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--mpanel-muted);
}
.segmented {
  display: flex;
  gap: 2px;
  padding: 3px;
  border-radius: 9px;
  background: var(--mpanel-surface-inset);
}
.segmented-item {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex: 1;
  height: 28px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--mpanel-muted);
  font-size: 12.5px;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.segmented-item:hover {
  color: var(--mpanel-text);
}
.segmented-item.on {
  background: var(--mpanel-surface);
  color: var(--mpanel-accent);
  font-weight: 600;
  box-shadow: var(--mpanel-shadow);
}
.panel-actions {
  gap: 1px;
  padding-top: 0;
}
.panel-action {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 34px;
  padding: 0 8px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--mpanel-text);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.panel-action:hover {
  background: var(--mpanel-surface-soft);
}
.panel-footer {
  display: flex;
  padding: 4px 8px 0;
}
.panel-logout {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 34px;
  padding: 0 6px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--mpanel-muted);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.panel-logout:hover {
  background: var(--mpanel-surface-soft);
  color: var(--mpanel-text);
}
</style>
