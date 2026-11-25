import { Loader2 } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface SpinnerProps {
  size?: 'xs' | 'sm' | 'md' | 'lg';
  label?: string;
  className?: string;
}

const SIZE_CLASS: Record<NonNullable<SpinnerProps['size']>, string> = {
  xs: 'h-3 w-3',
  sm: 'h-4 w-4',
  md: 'h-5 w-5',
  lg: 'h-7 w-7',
};

export function Spinner(props: SpinnerProps): JSX.Element {
  return (
    <span
      className={cn('inline-flex items-center gap-2 text-app-muted', props.className)}
      role="status"
      aria-live="polite"
    >
      <Loader2 className={cn('animate-spin', SIZE_CLASS[props.size ?? 'md'])} aria-hidden />
      {props.label === undefined ? null : <span className="text-xs">{props.label}</span>}
      <span className="sr-only">{props.label ?? '加载中'}</span>
    </span>
  );
}
