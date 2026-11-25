import type { ContainerPort, ContainerSummary } from '../../api/types';

export const CONTAINER_ACTION_LABEL = {
  start: '启动',
  stop: '停止',
  restart: '重启',
} as const;

export function containerName(container: Pick<ContainerSummary, 'id' | 'names'>): string {
  const first = container.names[0];
  if (first !== undefined && first.length > 0) return first.replace(/^\//, '');
  return container.id.slice(0, 12);
}

export function containerShortId(id: string): string {
  return id.slice(0, 12);
}

/** 端口展示：`0.0.0.0:8080→80/tcp`，未映射时显示 `80/tcp`。 */
export function formatPort(port: ContainerPort): string {
  const protocol = `/${port.type}`;
  if (port.publicPort === undefined) return `${port.privatePort}${protocol}`;
  const host = port.ip === undefined || port.ip === '0.0.0.0' || port.ip === '::' ? '' : `${port.ip}:`;
  return `${host}${port.publicPort}→${port.privatePort}${protocol}`;
}

export function formatPorts(ports: readonly ContainerPort[]): string {
  if (ports.length === 0) return '—';
  return ports.map(formatPort).join('，');
}

/** docker 的 state 字段用于配色，status 字段用于展示运行时长。 */
export function containerStateLabel(state: string): string {
  const labels: Record<string, string> = {
    running: '运行中',
    exited: '已退出',
    created: '已创建',
    paused: '已暂停',
    restarting: '重启中',
    removing: '删除中',
    dead: '异常',
  };
  return labels[state] ?? state;
}

export function isRunningState(state: string): boolean {
  return state === 'running' || state === 'paused' || state === 'restarting';
}
