import type { RouteLocationNormalizedLoaded } from 'vue-router';
import { router } from '@/router';
import { activeConnectionId } from './connection-store';
import { createTab, findTabByPath, setActiveTab } from './workspace';

export type MachineArea =
  | 'sites'
  | 'certs'
  | 'databases'
  | 'containers'
  | 'images'
  | 'stacks'
  | 'files'
  | 'terminal'
  | 'tasks';

export interface MachineAreaItem {
  area: MachineArea;
  title: string;
  description: string;
}

/** 仅用于路由/标题兜底；左侧导航以 MACHINE_NAV_GROUPS 为准。 */
export const MACHINE_AREAS: MachineAreaItem[] = [
  { area: 'sites', title: '站点', description: 'Caddy 站点与反向代理' },
  { area: 'certs', title: '证书', description: '证书与到期时间' },
  { area: 'databases', title: '数据库', description: 'PostgreSQL / Redis' },
  { area: 'containers', title: '容器', description: 'Docker 容器' },
  { area: 'images', title: '镜像', description: 'Docker 镜像' },
  { area: 'stacks', title: '编排', description: 'Compose 编排' },
  { area: 'files', title: '文件', description: '文件浏览与编辑' },
  { area: 'terminal', title: '终端', description: 'PTY / 管道会话' },
  { area: 'tasks', title: '计划任务', description: 'Cron 任务' },
];

export interface MachineNavItem {
  key: string;
  area: MachineArea;
  title: string;
  query?: Record<string, string>;
}

export interface MachineNavGroup {
  title: string;
  items: MachineNavItem[];
}

/** 左侧机器导航；顺序与分组即产品信息架构。 */
export const MACHINE_NAV_GROUPS: MachineNavGroup[] = [
  {
    title: '网站',
    items: [
      { key: 'sites', area: 'sites', title: '站点' },
      { key: 'certs', area: 'certs', title: '证书' },
    ],
  },
  {
    title: '数据库',
    items: [
      { key: 'postgres', area: 'databases', title: 'PostgreSQL', query: { kind: 'postgres' } },
      { key: 'redis', area: 'databases', title: 'Redis', query: { kind: 'redis' } },
    ],
  },
  {
    title: '容器',
    items: [
      { key: 'containers', area: 'containers', title: '容器' },
      { key: 'stacks', area: 'stacks', title: '编排' },
    ],
  },
  {
    title: '系统',
    items: [
      { key: 'files', area: 'files', title: '文件' },
      { key: 'terminal', area: 'terminal', title: '终端' },
    ],
  },
  {
    title: '工具箱',
    items: [{ key: 'tasks', area: 'tasks', title: '计划任务' }],
  },
];

export const MACHINE_NAV_ITEMS: MachineNavItem[] = MACHINE_NAV_GROUPS.flatMap(
  (group) => group.items,
);

const AREA_TITLE = new Map<string, string>(MACHINE_AREAS.map((item) => [item.area, item.title]));

export function areaTitle(area: string): string {
  return AREA_TITLE.get(area) ?? area;
}

export function machinePath(machineId: string, area: MachineArea | string): string {
  return `/m/${encodeURIComponent(machineId)}/${area}`;
}

export function machineNavPath(machineId: string, item: MachineNavItem): string {
  let path = machinePath(machineId, item.area);
  if (item.query !== undefined) {
    const params = new URLSearchParams(item.query);
    const qs = params.toString();
    if (qs.length > 0) path = `${path}?${qs}`;
  }
  return path;
}

/** 标签页/文档标题：数据库按 kind 区分 PostgreSQL / Redis。 */
export function pageTitleForRoute(route: RouteLocationNormalizedLoaded): string {
  if (route.name === 'databases') {
    const kind = route.query.kind;
    if (kind === 'postgres') return 'PostgreSQL';
    if (kind === 'redis') return 'Redis';
  }
  return typeof route.meta.title === 'string' ? route.meta.title : 'MPanel';
}

/** 当前路由是否命中导航项（含 kind 等 query 约束）。 */
export function isNavItemActive(
  machineId: string | null,
  item: MachineNavItem,
  path: string,
  query: Record<string, unknown>,
): boolean {
  if (machineId === null) return false;
  if (path !== machinePath(machineId, item.area)) return false;
  if (item.query === undefined) return true;
  return Object.entries(item.query).every(([key, value]) => query[key] === value);
}

/**
 * 打开机器页面。
 * - 默认在新标签页打开（多机/多页面混合工作台）；
 * - 已存在完全相同的路径时聚焦旧标签，避免重复；
 * - forceNew=true 时总是新建标签页（同一台机器打开多个页面）。
 */
export function openMachinePage(
  machineId: string,
  area: MachineArea | string,
  options: { forceNew?: boolean; query?: Record<string, string>; title?: string } = {},
): void {
  const connectionId = activeConnectionId.value;
  if (connectionId === null) return;
  let path = machinePath(machineId, area);
  if (options.query !== undefined) {
    const params = new URLSearchParams(options.query);
    const qs = params.toString();
    if (qs.length > 0) path = `${path}?${qs}`;
  }
  const existing = findTabByPath(path);
  if (!options.forceNew && existing !== undefined) {
    setActiveTab(existing.id);
  } else {
    createTab({
      connectionId,
      machineId,
      path,
      pageTitle: options.title ?? areaTitle(area),
    });
  }
  if (router.currentRoute.value.fullPath !== path) {
    void router.push(path);
  }
}

export function openMachineNavItem(
  machineId: string,
  item: MachineNavItem,
  options: { forceNew?: boolean } = {},
): void {
  openMachinePage(machineId, item.area, {
    forceNew: options.forceNew,
    query: item.query,
    title: item.title,
  });
}

/** 打开 core 级页面（概览/机器/边缘/设置），支持强制新标签。 */
export function openCorePage(path: string, title: string, forceNew = false): void {
  const connectionId = activeConnectionId.value;
  if (connectionId === null) return;
  const existing = findTabByPath(path);
  if (!forceNew && existing !== undefined) {
    setActiveTab(existing.id);
  } else {
    createTab({ connectionId, machineId: null, path, pageTitle: title });
  }
  if (router.currentRoute.value.fullPath !== path) {
    void router.push(path);
  }
}

/** 机器详情（core 页面，不是工作台机器上下文）。 */
export function openMachineDetail(machineId: string): void {
  openCorePage(`/machines/${encodeURIComponent(machineId)}`, '机器详情');
}

export function navigateTab(path: string): void {
  if (router.currentRoute.value.fullPath !== path) void router.push(path);
}
