import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { statusLabel, statusTone, TONE_CLASS, type StatusTone } from './tones';

export interface StatusBadgeProps {
  /** 机器/站点/证书/任务等状态字符串（中英文均可）。 */
  status: string;
  label?: ReactNode;
  tone?: StatusTone;
  size?: 'sm' | 'md';
  dot?: boolean;
  className?: string;
  title?: string;
}

/** 统一状态徽标：站点、证书、机器、任务共用一套颜色与中文文案。 */
export function StatusBadge(props: StatusBadgeProps): JSX.Element {
  const tone = props.tone ?? statusTone(props.status);
  const size = props.size ?? 'md';
  return (
    <span
      title={props.title}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border font-medium',
        size === 'sm' ? 'px-1.5 py-0 text-[10px]' : 'px-2 py-0.5 text-[11px]',
        TONE_CLASS[tone].badge,
        props.className,
      )}
    >
      {props.dot === false ? null : (
        <span className={cn('h-1.5 w-1.5 rounded-full', TONE_CLASS[tone].dot)} />
      )}
      {props.label ?? statusLabel(props.status)}
    </span>
  );
}
