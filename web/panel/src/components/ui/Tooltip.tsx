import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  className?: string;
}

const SIDE_CLASS: Record<NonNullable<TooltipProps['side']>, string> = {
  top: 'bottom-full left-1/2 mb-1.5 -translate-x-1/2',
  bottom: 'top-full left-1/2 mt-1.5 -translate-x-1/2',
  left: 'right-full top-1/2 mr-1.5 -translate-y-1/2',
  right: 'left-full top-1/2 ml-1.5 -translate-y-1/2',
};

/** 轻量 tooltip（CSS hover/focus），不引入额外依赖。 */
export function Tooltip(props: TooltipProps): JSX.Element {
  return (
    <span className={cn('group relative inline-flex', props.className)}>
      {props.children}
      <span
        role="tooltip"
        className={cn(
          'pointer-events-none absolute z-50 hidden max-w-xs whitespace-normal rounded-md border border-app-border bg-app-elevated px-2 py-1 text-[11px] leading-snug text-app-text shadow-pop group-hover:block group-focus-within:block',
          SIDE_CLASS[props.side ?? 'top'],
        )}
      >
        {props.content}
      </span>
    </span>
  );
}
