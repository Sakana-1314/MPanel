import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { TONE_CLASS, type StatusTone } from './tones';

export interface BadgeProps {
  tone?: StatusTone;
  children: ReactNode;
  className?: string;
  dot?: boolean;
  title?: string;
}

export function Badge(props: BadgeProps): JSX.Element {
  const tone = props.tone ?? 'neutral';
  return (
    <span
      title={props.title}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4',
        TONE_CLASS[tone].badge,
        props.className,
      )}
    >
      {props.dot === true ? (
        <span className={cn('h-1.5 w-1.5 rounded-full', TONE_CLASS[tone].dot)} />
      ) : null}
      {props.children}
    </span>
  );
}
