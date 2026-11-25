import { cn } from '../../lib/cn';

export type StatusTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

const STATUS_TONE: Record<string, StatusTone> = {
  // 机器
  online: 'success',
  offline: 'danger',
  starting: 'info',
  degraded: 'warning',
  error: 'danger',
  // 站点
  draft: 'neutral',
  pending: 'warning',
  applied: 'success',
  disabled: 'neutral',
  // 证书
  valid: 'success',
  expiring: 'warning',
  expired: 'danger',
  unknown: 'neutral',
  // 任务/作业/容器
  running: 'info',
  queued: 'info',
  success: 'success',
  failed: 'danger',
  timeout: 'warning',
  skipped: 'neutral',
  exited: 'neutral',
  paused: 'warning',
  dead: 'danger',
  available: 'success',
  unavailable: 'neutral',
};

const STATUS_LABEL: Record<string, string> = {
  online: '在线',
  offline: '离线',
  starting: '启动中',
  degraded: '降级',
  error: '错误',
  draft: '草稿',
  pending: '待应用',
  applied: '已应用',
  disabled: '已禁用',
  valid: '有效',
  expiring: '即将到期',
  expired: '已过期',
  unknown: '未知',
  running: '运行中',
  queued: '排队中',
  success: '成功',
  failed: '失败',
  timeout: '超时',
  skipped: '已跳过',
  exited: '已退出',
  paused: '已暂停',
  dead: '已死亡',
  available: '可用',
  unavailable: '不可用',
};

export function statusTone(status: string): StatusTone {
  return STATUS_TONE[status] ?? 'neutral';
}

export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

/** 静态 class 片段，保证被 Tailwind 扫描到。 */
export const TONE_CLASS: Record<
  StatusTone,
  { badge: string; dot: string; text: string; softBg: string; border: string; button: string }
> = {
  neutral: {
    badge: 'border-app-border bg-app-elevated text-app-muted',
    dot: 'bg-app-muted',
    text: 'text-app-muted',
    softBg: 'bg-app-elevated',
    border: 'border-app-border',
    button: 'border-app-border bg-app-elevated text-app-text hover:bg-app-surface',
  },
  accent: {
    badge: 'border-app-accent/40 bg-app-accent/15 text-app-accent',
    dot: 'bg-app-accent',
    text: 'text-app-accent',
    softBg: 'bg-app-accent/10',
    border: 'border-app-accent/40',
    button: 'border-app-accent/50 bg-app-accent text-white hover:bg-app-accent-strong',
  },
  success: {
    badge: 'border-app-success/40 bg-app-success/15 text-app-success',
    dot: 'bg-app-success',
    text: 'text-app-success',
    softBg: 'bg-app-success/10',
    border: 'border-app-success/40',
    button: 'border-app-success/50 bg-app-success text-white hover:opacity-90',
  },
  warning: {
    badge: 'border-app-warning/40 bg-app-warning/15 text-app-warning',
    dot: 'bg-app-warning',
    text: 'text-app-warning',
    softBg: 'bg-app-warning/10',
    border: 'border-app-warning/40',
    button: 'border-app-warning/50 bg-app-warning text-black hover:opacity-90',
  },
  danger: {
    badge: 'border-app-danger/40 bg-app-danger/15 text-app-danger',
    dot: 'bg-app-danger',
    text: 'text-app-danger',
    softBg: 'bg-app-danger/10',
    border: 'border-app-danger/40',
    button: 'border-app-danger/50 bg-app-danger text-white hover:opacity-90',
  },
  info: {
    badge: 'border-app-info/40 bg-app-info/15 text-app-info',
    dot: 'bg-app-info',
    text: 'text-app-info',
    softBg: 'bg-app-info/10',
    border: 'border-app-info/40',
    button: 'border-app-info/50 bg-app-info text-white hover:opacity-90',
  },
};

export function toneClass(tone: StatusTone): string {
  return TONE_CLASS[tone].badge;
}

export function cnTone(base: string, tone: StatusTone): string {
  return cn(base, TONE_CLASS[tone].badge);
}
