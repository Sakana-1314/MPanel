import type { CapabilityStatus } from '../../api/types';
import { Alert } from './Alert';

export interface CapabilityNoticeProps {
  capability: string;
  status: CapabilityStatus;
  hint?: string;
  className?: string;
}

const CAPABILITY_LABEL: Record<string, string> = {
  caddy: 'Caddy',
  docker: 'Docker',
  postgres: 'PostgreSQL',
  redis: 'Redis',
  pty: 'PTY',
};

/** 能力探测结果提示：可用时显示版本，不可用时显示 reason/hint。 */
export function CapabilityNotice(props: CapabilityNoticeProps): JSX.Element | null {
  const label = CAPABILITY_LABEL[props.capability] ?? props.capability;
  if (props.status.available) {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-app-success/30 bg-app-success/10 px-2 py-0.5 text-[11px] text-app-success">
        {label} 可用{props.status.version === undefined ? '' : ` · ${props.status.version}`}
      </span>
    );
  }
  return (
    <Alert tone="warning" title={`${label} 不可用`} hint={props.hint ?? props.status.reason} className={props.className}>
      {props.status.reason ?? '后端能力探测失败。'}
    </Alert>
  );
}
