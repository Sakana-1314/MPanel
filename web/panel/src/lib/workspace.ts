import { computed, reactive } from 'vue';

const PERSIST_KEY = 'mpanel.workspace.v1';

export interface WorkspaceTab {
  /** 标签页唯一 id；页面缓存按它区分。 */
  id: string;
  /** core 连接 id，切换连接后旧标签不再展示。 */
  connectionId: string;
  /** 机器级标签保存 machineId；core 级页面为 null。 */
  machineId: string | null;
  /** 当前路由完整路径（含 query）。 */
  path: string;
  /** 页面标题（如“站点”“容器”）。 */
  pageTitle: string;
  /** 打开时间，用于排序。 */
  createdAt: number;
}

interface WorkspaceState {
  connectionId: string | null;
  tabs: WorkspaceTab[];
  activeId: string | null;
}

const state = reactive<WorkspaceState>({
  connectionId: null,
  tabs: [],
  activeId: null,
});

function makeTabId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `tab_${crypto.randomUUID()}`;
  }
  return `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function persist(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        connectionId: state.connectionId,
        activeId: state.activeId,
        tabs: state.tabs,
      }),
    );
  } catch {
    // 忽略配额/隐私模式错误。
  }
}

/** 启动时恢复（仅当连接 id 仍匹配）。 */
export function restoreWorkspace(connectionId: string | null): void {
  state.connectionId = connectionId;
  state.tabs = [];
  state.activeId = null;
  if (connectionId === null || typeof localStorage === 'undefined') return;
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (raw === null) return;
    const parsed = JSON.parse(raw) as WorkspaceState;
    if (parsed.connectionId !== connectionId || !Array.isArray(parsed.tabs)) return;
    state.tabs = parsed.tabs.filter(
      (tab): tab is WorkspaceTab =>
        typeof tab === 'object' &&
        tab !== null &&
        typeof tab.id === 'string' &&
        typeof tab.path === 'string' &&
        (tab.machineId === null || typeof tab.machineId === 'string'),
    );
    state.activeId =
      typeof parsed.activeId === 'string' && state.tabs.some((tab) => tab.id === parsed.activeId)
        ? parsed.activeId
        : (state.tabs[0]?.id ?? null);
  } catch {
    // 损坏的本地状态直接丢弃。
  }
}

/** 连接切换/退出时清空工作台，避免把旧 core 的标签带到新连接。 */
export function resetWorkspace(connectionId: string | null = null): void {
  state.connectionId = connectionId;
  state.tabs = [];
  state.activeId = null;
  persist();
}

export const tabs = computed(() => state.tabs);
export const activeTabId = computed(() => state.activeId);
export const activeTab = computed<WorkspaceTab | undefined>(() =>
  state.tabs.find((tab) => tab.id === state.activeId),
);
export const workspaceConnectionId = computed(() => state.connectionId);

export function findTab(id: string): WorkspaceTab | undefined {
  return state.tabs.find((tab) => tab.id === id);
}

export function findTabByPath(path: string): WorkspaceTab | undefined {
  return state.tabs.find((tab) => tab.path === path);
}

export function setActiveTab(id: string): WorkspaceTab | undefined {
  const tab = findTab(id);
  if (tab === undefined) return undefined;
  state.activeId = id;
  persist();
  return tab;
}

export function createTab(input: {
  connectionId: string;
  machineId: string | null;
  path: string;
  pageTitle: string;
}): WorkspaceTab {
  const tab: WorkspaceTab = {
    id: makeTabId(),
    connectionId: input.connectionId,
    machineId: input.machineId,
    path: input.path,
    pageTitle: input.pageTitle,
    createdAt: Date.now(),
  };
  state.tabs.push(tab);
  state.activeId = tab.id;
  persist();
  return tab;
}

export function openOrFocusTab(input: {
  connectionId: string;
  machineId: string | null;
  path: string;
  pageTitle: string;
}): WorkspaceTab {
  const existing = findTabByPath(input.path);
  if (existing !== undefined) {
    state.activeId = existing.id;
    persist();
    return existing;
  }
  return createTab(input);
}

/** 页面内导航：更新当前标签路径与标题。 */
export function updateActiveTab(path: string, pageTitle: string): void {
  const tab = activeTab.value;
  if (tab === undefined) return;
  tab.path = path;
  tab.pageTitle = pageTitle;
  persist();
}

export function updateTabMachineTitle(machineId: string, machineName: string): void {
  // 机器名由 UI 实时查询；这里不存储冗余名称，保留接口以便未来扩展。
  void machineId;
  void machineName;
}

export interface CloseTabResult {
  /** 关闭后应导航到的路径；null 表示无标签，回首页。 */
  nextPath: string | null;
}

export function closeTab(id: string): CloseTabResult {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return { nextPath: null };
  const wasActive = state.activeId === id;
  state.tabs.splice(index, 1);
  if (wasActive) {
    const next = state.tabs[Math.min(index, state.tabs.length - 1)];
    state.activeId = next?.id ?? null;
    persist();
    return { nextPath: next?.path ?? null };
  }
  persist();
  return { nextPath: activeTab.value?.path ?? null };
}

export function closeOtherTabs(id: string): void {
  const keep = findTab(id);
  if (keep === undefined) return;
  state.tabs = [keep];
  state.activeId = keep.id;
  persist();
}

export function closeAllTabs(): void {
  state.tabs = [];
  state.activeId = null;
  persist();
}

/** 工作台内是否已有该机器页面。 */
export function tabsForMachine(machineId: string): WorkspaceTab[] {
  return state.tabs.filter((tab) => tab.machineId === machineId);
}
