import type { TagProps } from 'naive-ui';
import type {
  CertificateStatus,
  ContainerSummary,
  DatabaseJob,
  EdgeJobStatus,
  MachineStatus,
  SiteStatus,
  TaskRunStatus,
} from '../api/types';

export type TagType = TagProps['type'];

export function machineStatusLabel(status: MachineStatus): string {
  return {
    online: '在线',
    offline: '离线',
    starting: '启动中',
    degraded: '降级',
    error: '错误',
  }[status];
}

export function machineStatusType(status: MachineStatus): TagType {
  switch (status) {
    case 'online':
      return 'success';
    case 'starting':
      return 'info';
    case 'degraded':
      return 'warning';
    case 'error':
      return 'error';
    default:
      return 'default';
  }
}

export function siteStatusLabel(status: SiteStatus): string {
  return {
    draft: '草稿',
    pending: '待应用',
    applied: '已应用',
    error: '应用失败',
    disabled: '已禁用',
  }[status];
}

export function siteStatusType(status: SiteStatus): TagType {
  switch (status) {
    case 'applied':
      return 'success';
    case 'pending':
      return 'warning';
    case 'error':
      return 'error';
    case 'draft':
      return 'info';
    default:
      return 'default';
  }
}

export function certStatusLabel(status: CertificateStatus): string {
  return {
    valid: '有效',
    expiring: '即将到期',
    expired: '已过期',
    unknown: '未知',
  }[status];
}

export function certStatusType(status: CertificateStatus): TagType {
  switch (status) {
    case 'valid':
      return 'success';
    case 'expiring':
      return 'warning';
    case 'expired':
      return 'error';
    default:
      return 'default';
  }
}

export function containerStateType(container: ContainerSummary): TagType {
  switch (container.state) {
    case 'running':
      return 'success';
    case 'paused':
    case 'restarting':
      return 'warning';
    case 'exited':
    case 'dead':
      return 'error';
    default:
      return 'default';
  }
}

export function taskRunStatusLabel(status: TaskRunStatus): string {
  return {
    running: '运行中',
    success: '成功',
    failed: '失败',
    timeout: '超时',
    skipped: '已跳过',
  }[status];
}

export function taskRunStatusType(status: TaskRunStatus): TagType {
  switch (status) {
    case 'success':
      return 'success';
    case 'running':
      return 'info';
    case 'failed':
    case 'timeout':
      return 'error';
    default:
      return 'default';
  }
}

export function edgeJobStatusLabel(status: EdgeJobStatus): string {
  return {
    pending: '排队中',
    running: '执行中',
    succeeded: '成功',
    failed: '失败',
    canceled: '已取消',
  }[status];
}

export function edgeJobStatusType(status: EdgeJobStatus): TagType {
  switch (status) {
    case 'succeeded':
      return 'success';
    case 'running':
      return 'info';
    case 'failed':
      return 'error';
    case 'canceled':
      return 'default';
    default:
      return 'warning';
  }
}

export function databaseJobStatusLabel(status: DatabaseJob['status']): string {
  return {
    queued: '排队中',
    running: '执行中',
    success: '成功',
    failed: '失败',
  }[status];
}

export function databaseJobStatusType(status: DatabaseJob['status']): TagType {
  switch (status) {
    case 'success':
      return 'success';
    case 'running':
      return 'info';
    case 'failed':
      return 'error';
    default:
      return 'warning';
  }
}
