<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { NButton, NDropdown, NIcon, NTooltip, useMessage } from 'naive-ui';
import {
  ChevronDownOutline,
  LogOutOutline,
  MenuOutline,
  MoonOutline,
  PersonCircleOutline,
  SearchOutline,
  SettingsOutline,
  SunnyOutline,
  SwapHorizontalOutline,
} from '@vicons/ionicons5';
import {
  activeConnection,
  activeConnectionId,
  listConnections,
  setActiveConnection,
} from '@/lib/connection-store';
import { sessionSnapshot } from '@/lib/session';
import { logout } from '@/lib/session';
import { activeTab } from '@/lib/workspace';
import { useMachinesQuery } from '@/lib/machines';
import { useTheme } from '@/lib/theme';

const emit = defineEmits<{ menu: []; quickOpen: [] }>();

const router = useRouter();
const message = useMessage();
const { isDark, toggle } = useTheme();
const machinesQuery = useMachinesQuery();

const connections = computed(() => listConnections());
const connection = activeConnection;
const user = computed(() => sessionSnapshot().user);

const machineName = computed(() => {
  const id = activeTab.value?.machineId;
  if (id === null || id === undefined) return null;
  return (
    machinesQuery.data.value?.items.find((machine) => machine.id === id)?.name ?? id
  );
});

const connectionOptions = computed(() => [
  ...connections.value.map((item) => ({
    label: `${item.name}${item.id === activeConnectionId.value ? '（当前）' : ''}`,
    key: item.id,
  })),
  { label: '连接设置…', key: '__settings' },
]);

const userOptions = [
  { label: '设置', key: 'settings', icon: () => null },
  { label: '退出登录', key: 'logout', icon: () => null },
];

function onConnectionSelect(key: string): void {
  if (key === '__settings') {
    void router.push('/settings');
    return;
  }
  setActiveConnection(key);
}

async function onUserSelect(key: string): Promise<void> {
  if (key === 'settings') {
    void router.push('/settings');
    return;
  }
  if (key === 'logout') {
    try {
      await logout();
    } catch {
      // 即使 core 请求失败也清理本地登录态。
    }
    message.success('已退出登录');
    void router.replace('/login');
  }
}
</script>

<template>
  <header class="topbar">
    <div class="left">
      <n-button quaternary circle class="mobile-menu" title="菜单" @click="emit('menu')">
        <template #icon><n-icon :component="MenuOutline" /></template>
      </n-button>
      <div class="crumbs">
        <n-icon :component="SwapHorizontalOutline" class="muted" />
        <span v-if="machineName" class="crumb-machine truncate">{{ machineName }}</span>
        <span v-if="machineName" class="muted">/</span>
        <span class="crumb-page truncate">{{ activeTab?.pageTitle ?? '概览' }}</span>
      </div>
    </div>

    <div class="right">
      <n-button size="small" quaternary class="quick-btn" @click="emit('quickOpen')">
        <template #icon><n-icon :component="SearchOutline" /></template>
        打开页面
        <span class="kbd">Ctrl K</span>
      </n-button>

      <n-dropdown trigger="click" :options="connectionOptions" @select="onConnectionSelect">
        <n-button size="small" secondary>
          <template #icon><n-icon :component="SwapHorizontalOutline" /></template>
          <span class="truncate conn-name">{{ connection?.name ?? '未连接' }}</span>
          <n-icon :component="ChevronDownOutline" size="12" />
        </n-button>
      </n-dropdown>

      <n-tooltip>
        <template #trigger>
          <n-button quaternary circle size="small" :title="isDark ? '切换到浅色' : '切换到深色'" @click="toggle">
            <template #icon><n-icon :component="isDark ? SunnyOutline : MoonOutline" /></template>
          </n-button>
        </template>
        {{ isDark ? '浅色主题' : '深色主题' }}
      </n-tooltip>

      <n-dropdown trigger="click" :options="userOptions" @select="onUserSelect">
        <n-button size="small" quaternary>
          <template #icon><n-icon :component="PersonCircleOutline" /></template>
          {{ user?.displayName ?? user?.username ?? '账户' }}
          <n-icon :component="ChevronDownOutline" size="12" />
        </n-button>
      </n-dropdown>
    </div>
  </header>
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: 54px;
  padding: 0 14px;
  border-bottom: 1px solid var(--mpanel-border);
  background: color-mix(in srgb, var(--mpanel-bg) 86%, transparent);
  backdrop-filter: blur(10px);
}
.left,
.right {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.crumbs {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 13px;
}
.crumb-machine {
  font-weight: 600;
  max-width: 160px;
}
.crumb-page {
  color: var(--mpanel-muted);
  max-width: 160px;
}
.mobile-menu {
  display: none;
}
.conn-name {
  max-width: 130px;
  margin: 0 4px;
}
.kbd {
  margin-left: 6px;
  padding: 1px 5px;
  border: 1px solid var(--mpanel-border);
  border-radius: 4px;
  font-size: 10px;
  color: var(--mpanel-muted);
}
.quick-btn {
  color: var(--mpanel-muted);
}
@media (max-width: 900px) {
  .mobile-menu {
    display: inline-flex;
  }
  .quick-btn .kbd {
    display: none;
  }
  .conn-name {
    max-width: 90px;
  }
}
@media (max-width: 640px) {
  .quick-btn {
    display: none;
  }
}
</style>
