import { format, formatDistanceToNowStrict, parseISO } from 'date-fns';
import { zhCN } from 'date-fns/locale';
import type { Machine } from '../api/types';

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = n;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  const digits = index === 0 ? 0 : value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[index] ?? 'B'}`;
}

/** 绝对时间（本地时区，秒级）。 */
export function formatDate(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso.length === 0) return '—';
  try {
    return format(parseISO(iso), 'yyyy-MM-dd HH:mm:ss');
  } catch {
    return iso;
  }
}

/** 只显示日期的版本，用于证书到期日。 */
export function formatDay(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso.length === 0) return '—';
  try {
    return format(parseISO(iso), 'yyyy-MM-dd');
  } catch {
    return iso;
  }
}

/** 相对时间，如“3 分钟前”“2 天后”。 */
export function formatRelativeTime(iso: string | Date | null | undefined): string {
  if (iso === null || iso === undefined) return '—';
  const date = typeof iso === 'string' ? safeParse(iso) : iso;
  if (date === null) return typeof iso === 'string' ? iso : '—';
  try {
    return formatDistanceToNowStrict(date, { addSuffix: true, locale: zhCN });
  } catch {
    return typeof iso === 'string' ? iso : '—';
  }
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60) return `${minutes} 分 ${rest} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

export function formatPercent(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(n < 10 ? 2 : 1)}%`;
}

/** 证书剩余天数文案。 */
export function formatDaysRemaining(days: number): string {
  if (!Number.isFinite(days)) return '未知';
  if (days < 0) return `已过期 ${Math.abs(Math.round(days))} 天`;
  if (days === 0) return '今天到期';
  return `剩余 ${Math.round(days)} 天`;
}

export function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分`;
}

function safeParse(iso: string): Date | null {
  try {
    const date = parseISO(iso);
    return Number.isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
}

/** 面向用户的接入方式标签；传输实现细节不出现在界面。 */
export function transportLabel(transport: Machine['transport'] | string): string {
  switch (transport) {
    case 'http':
      return '直连';
    case 'stdio':
      return '本机';
    case 'reverse-ws':
      return '隧道';
    default:
      return transport;
  }
}

/** 机器地址的可展示形式：不暴露隧道地址或内部进程参数。 */
export function machineAddressLabel(
  machine: Pick<Machine, 'transport' | 'endpoint'>,
): string {
  if (machine.transport === 'stdio') return '本机进程';
  if (machine.transport === 'reverse-ws') return '隧道接入';
  return machine.endpoint ?? '—';
}

