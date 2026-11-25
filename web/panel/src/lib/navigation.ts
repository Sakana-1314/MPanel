import { router } from '@/router';
import { activeConnectionId } from './connection-store';
import { createTab, findTabByPath, openOrFocusTab, setActiveTab } from './workspace';

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

export const MACHINE_AREAS: MachineAreaItem[] = [
  { area: 'sites', title: '站点', description: 'Caddy 站点、反向代理与文件服务' },
  { area: 'certs', title: '证书', description: 'Caddy 数据目录中的证书与到期时间' },
  { area: 'databases', title: '数据库', description: 'PostgreSQL / Redis 档案、统计与备份' },
  { area: 'containers', title: '容器', description: '容器列表、日志、统计与执行' },
  { area: 'images', title: '镜像', description: 'Docker 镜像拉取、删除与清理' },
  { area: 'stacks', title: 'Compose 栈', description: 'Compose 项目与容器编排' },
  { area: 'files', title: '文件', description: '沙箱文件浏览、编辑、上传与回收站' },
  { area: 'terminal', title: '终端', description: '经 core 代理的 PTY/管道会话' },
  { area: 'tasks', title: '计划任务', description: 'Cron 任务、手动运行与历史' },
];

const AREA_TITLE = new Map<string, string>(MACHINE_AREAS.map((item) => [item.area, item.title]));

export function areaTitle(area: string): string {
  return AREA_TITLE.get(area) ?? area;
}

export function machinePath(machineId: string, area: MachineArea | string): string {
  return `/m/${encodeURIComponent(machineId)}/${area}`;
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
  options: { forceNew?: boolean; query?: Record<string, string> } = {},
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
      pageTitle: areaTitle(area),
    });
  }
  if (router.currentRoute.value.fullPath !== path) {
    void router.push(path);
  }
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
