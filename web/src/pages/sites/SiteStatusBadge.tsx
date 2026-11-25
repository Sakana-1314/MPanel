import type { SiteStatus } from '../../api/types';
import { StatusBadge } from '../../components/ui/StatusBadge';

const LABEL: Record<SiteStatus, string> = {
  draft: '草稿',
  pending: '待应用',
  applied: '已应用',
  error: '应用失败',
  disabled: '已禁用',
};

const HINT: Record<SiteStatus, string> = {
  draft: '尚未应用；保存后点击“应用”写入 Caddy。',
  pending: '有未应用的修改；应用后才会写入 Caddy。',
  applied: '当前草稿已写入 Caddy。',
  error: '最近一次应用失败，线上配置已回滚或未变更。',
  disabled: '站点已禁用，应用全量时会从 Caddy 移除。',
};

export interface SiteStatusBadgeProps {
  status: SiteStatus;
}

export function SiteStatusBadge(props: SiteStatusBadgeProps): JSX.Element {
  return <StatusBadge status={props.status} label={LABEL[props.status]} title={HINT[props.status]} />;
}
