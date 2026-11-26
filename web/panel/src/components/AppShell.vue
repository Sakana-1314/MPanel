<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useEventListener, useMediaQuery } from '@vueuse/core';
import {
  NDrawer,
  NDrawerContent,
  NLayout,
  NLayoutContent,
  NLayoutSider,
} from 'naive-ui';
import AppSidebar from './AppSidebar.vue';
import WorkspaceTabs from './WorkspaceTabs.vue';
import QuickOpen from './QuickOpen.vue';
import { activeConnectionId } from '@/lib/connection-store';
import { useMachinesQuery } from '@/lib/machines';
import { pageTitleForRoute } from '@/lib/navigation';
import {
  activeTab,
  createTab,
  findTabByPath,
  pruneMissingMachines,
  setActiveTab,
  updateActiveTab,
} from '@/lib/workspace';

const route = useRoute();
const router = useRouter();
const machinesQuery = useMachinesQuery();
const isMobile = useMediaQuery('(max-width: 900px)');
const mobileOpen = ref(false);
const quickOpen = ref(false);

const machineId = computed<string | null>(() => {
  const value = route.params.machineId;
  return typeof value === 'string' && value.length > 0 ? value : null;
});

/**
 * 路由 → 工作台标签同步：
 * - 同一机器（或 core 级页面）内导航更新当前标签；
 * - 切换机器 / 从 core 页面进入机器页面时创建新标签，保留其它标签；
 * - 直达 URL 时优先聚焦已有同路径标签。
 */
watch(
  () => route.fullPath,
  () => {
    const connectionId = activeConnectionId.value;
    if (connectionId === null) return;
    const targetMachineId = machineId.value;
    const pageTitle = pageTitleForRoute(route);
    const tab = activeTab.value;
    if (
      tab !== undefined &&
      tab.connectionId === connectionId &&
      tab.machineId === targetMachineId
    ) {
      updateActiveTab(route.fullPath, pageTitle);
      return;
    }
    const existing = findTabByPath(route.fullPath);
    if (existing !== undefined) {
      setActiveTab(existing.id);
      return;
    }
    createTab({
      connectionId,
      machineId: targetMachineId,
      path: route.fullPath,
      pageTitle,
    });
  },
  { immediate: true },
);

const pageKey = computed(() => {
  const tabId = activeTab.value?.id ?? 'no-tab';
  const name = String(route.name ?? 'page');
  const identity = [
    route.params.machineId,
    route.params.siteId,
    route.params.taskId,
    route.params.stackName,
    route.query.kind,
  ]
    .filter((value) => typeof value === 'string' && value.length > 0)
    .join(':');
  return `${tabId}:${name}:${identity}`;
});

watch(
  () => machinesQuery.data.value,
  (data) => {
    if (data === undefined || data.available === false) return;
    const result = pruneMissingMachines(new Set(data.items.map((machine) => machine.id)));
    if (result.removedActive) void router.push(result.nextPath ?? '/');
  },
);

useEventListener(window, 'keydown', (event: KeyboardEvent) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    quickOpen.value = true;
  }
});

function closeMobile(): void {
  mobileOpen.value = false;
}

watch(
  () => route.fullPath,
  () => {
    closeMobile();
  },
);

</script>

<template>
  <n-layout has-sider style="height: 100vh">
    <n-layout-sider
      v-if="!isMobile"
      :width="210"
      :native-scrollbar="false"
      content-style="height: 100%"
    >
      <AppSidebar @quick-open="quickOpen = true" />
    </n-layout-sider>

    <n-layout style="height: 100vh">
      <WorkspaceTabs
        :mobile="isMobile"
        @menu="mobileOpen = true"
        @quick-open="quickOpen = true"
      />

      <n-layout-content
        :native-scrollbar="false"
        content-style="height: calc(100vh - 46px); overflow: auto"
      >
        <div class="content-inner">
          <router-view v-slot="{ Component }">
            <keep-alive :max="24">
              <component :is="Component" :key="pageKey" />
            </keep-alive>
          </router-view>
        </div>
      </n-layout-content>
    </n-layout>
  </n-layout>

  <n-drawer v-model:show="mobileOpen" placement="left" :width="240">
    <n-drawer-content :native-scrollbar="false" body-content-style="padding: 0">
      <div style="height: 100vh">
        <AppSidebar @quick-open="quickOpen = true" />
      </div>
    </n-drawer-content>
  </n-drawer>

  <QuickOpen v-model:show="quickOpen" />
</template>

<style scoped>
.content-inner {
  width: 100%;
  max-width: 1480px;
  margin: 0 auto;
  padding: 16px 18px 32px;
}
@media (max-width: 640px) {
  .content-inner {
    padding: 12px 12px 28px;
  }
}
</style>
