import { cn } from '../../lib/cn';

export interface UsageBarProps {
  /** 0–100；null/非法值显示空条。 */
  percent: number | null;
  className?: string;
  /** 紧凑模式用于机器卡片/节点表格。 */
  size?: 'sm' | 'md';
}

function barTone(percent: number): string {
  if (percent >= 90) return 'bg-app-danger';
  if (percent >= 75) return 'bg-app-warning';
  return 'bg-app-success';
}

export function clampPercent(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

export function percentOf(used: number, total: number | null | undefined): number | null {
  if (total === null || total === undefined || total <= 0) return null;
  return clampPercent((used / total) * 100);
}

/** 细进度条：内存/磁盘使用率。 */
export function UsageBar(props: UsageBarProps): JSX.Element {
  const percent = clampPercent(props.percent);
  return (
    <div
      className={cn(
        'w-full overflow-hidden rounded-full bg-app-elevated',
        props.size === 'sm' ? 'h-1' : 'h-1.5',
        props.className,
      )}
      role="progressbar"
      aria-valuenow={Math.round(percent)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={cn('h-full rounded-full transition-all', barTone(percent))}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
