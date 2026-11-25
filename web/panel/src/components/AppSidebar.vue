<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { NButton, NIcon, NScrollbar, NSpin, NTooltip } from 'naive-ui';
import {
  CubeOutline,
  FolderOpenOutline,
  GitNetworkOutline,
  GlobeOutline,
  GridOutline,
  ImagesOutline,
  LayersOutline,
  ServerOutline,
  SettingsOutline,
  ShieldCheckmarkOutline,
  TerminalOutline,
  TimeOutline,
  PulseOutline,
  AddOutline,
} from '@vicons/ionicons5';
import { useMachinesQuery } from '@/lib/machines';
import { activeTab } from '@/lib/workspace';
import {
  MACHINE_AREAS,
  machinePath,
  openCorePage,
  openMachinePage,
} from '@/lib/navigation';
import { machineStatusType } from '@/lib/status';

const emit = defineEmits<{ quickOpen: [] }>();

const route = useRoute();
const router = useRouter();
const machinesQuery = useMachinesQuery();

const machines = computed(() => machinesQuery.data.value?.items ?? []);
const activeMachineId = computed(() => activeTab.value?.machineId ?? null);
const activeMachine = computed(() =>
  machines.value.find((machine) => machine.id === activeMachineId.value),
);

const coreNav = [
  { path: '/', title: '概览', icon: GridOutline },
  { path: '/machines', title: '机器', icon: ServerOutline },
  { path: '/edge', title: '边缘节点', icon: GitNetworkOutline },
  { path: '/settings', title: '设置', icon: SettingsOutline },
];

const areaIcons: Record<string, typeof GlobeOutline> = {
  sites: GlobeOutline,
  certs: ShieldCheckmarkOutline,
  databases: LayersOutline,
  containers: CubeOutline,
  images: ImagesOutline,
  stacks: LayersOutline,
  files: FolderOpenOutline,
  terminal: TerminalOutline,
  tasks: TimeOutline,
};

function isCoreActive(path: string): boolean {
  if (path === '/') return route.path === '/';
  if (path === '/machines') return route.path.startsWith('/machines');
  return route.path === path;
}

function areaActive(area: string): boolean {
  return route.path === machinePath(activeMachineId.value ?? '', area);
}

function openMachine(machineId: string): void {
  openMachinePage(machineId, 'sites');
}

function go(path: string): void {
  openCorePage(path, coreNav.find((item) => item.path === path)?.title ?? 'MPanel');
}

function goArea(area: string): void {
  const machineId = activeMachineId.value;
  if (machineId === null) {
    emit('quickOpen');
    return;
  }
  void router.push(machinePath(machineId, area));
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
        <div v-else-if="machines.length === 0" class="empty small muted">
          还没有机器。前往“机器”页添加，或使用边缘节点入网密钥。
        </div>
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
            <span class="tiny muted">{{ machine.transport === 'reverse-ws' ? 'edge' : machine.transport }}</span>
          </button>
        </div>
      </div>

      <div v-if="activeMachineId !== null" class="section">
        <div class="section-title">
          <span class="truncate">当前标签 · {{ activeMachine?.name ?? activeMachineId }}</span>
          <n-tooltip>
            <template #trigger>
              <n-icon :component="PulseOutline" class="muted" />
            </template>
            当前标签页绑定的机器；切换其它机器会新开标签，不会替换本标签。
          </n-tooltip>
        </div>
        <nav class="nav">
          <button
            v-for="item in MACHINE_AREAS"
            :key="item.area"
            type="button"
            class="nav-item"
            :class="{ active: areaActive(item.area) }"
            @click="goArea(item.area)"
          >
            <n-icon :component="areaIcons[item.area] ?? GlobeOutline" />
            <span>{{ item.title }}</span>
          </button>
        </nav>
      </div>
      <div v-else class="section hint small muted">
        从上方选择一台机器，或打开新标签页；多台机器的页面可以同时在标签栏中混合打开。
      </div>
    </n-scrollbar>

    <div class="sidebar-footer tiny muted">
      前端只连接 core · 所有机器请求经代理转发
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
  padding: 16px 16px 10px;
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
  gap: 2px;
  padding: 4px 10px;
}
.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--mpanel-text);
  font-size: 13px;
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
  padding: 10px;
  border-top: 1px solid var(--mpanel-border);
  margin-top: 8px;
}
.section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 2px 6px 8px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.03em;
  color: var(--mpanel-muted);
  text-transform: uppercase;
}
.machine-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 220px;
  overflow-y: auto;
}
.machine-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 9px;
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
.hint {
  line-height: 1.7;
}
.sidebar-footer {
  padding: 10px 16px;
  border-top: 1px solid var(--mpanel-border);
  line-height: 1.5;
}
</style>
