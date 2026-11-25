import { cn } from '../../lib/cn';

export interface UsageMeterProps {
  percent: number | null;
  size?: 'sm' | 'md';
  className?: string;
}

export function clampPercent(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

export function percentOf(used: number, total: number | null | undefined): number | null {
  if (total === null || total === undefined || total <= 0) return null;
  return clampPercent((used / total) * 100);
}

function meterTone(percent: number): string {
  if (percent >= 90) return 'bg-app-danger';
  if (percent >= 75) return 'bg-app-warning';
  return 'bg-app-success';
}

/** 边缘节点内存/磁盘小进度条。 */
export function UsageMeter(props: UsageMeterProps): JSX.Element {
  const percent = clampPercent(props.percent);
  return (
    <div
      className={cn(
        'overflow-hidden rounded-full bg-app-elevated',
        props.size === 'sm' ? 'h-1' : 'h-1.5',
        props.className,
      )}
      role="progressbar"
      aria-valuenow={Math.round(percent)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={cn('h-full rounded-full transition-all', meterTone(percent))}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
