import { cn } from '../../lib/cn';

export interface SparklineProps {
  values: readonly number[];
  /** 固定上限（例如内存百分比固定 100）；缺省用样本最大值。 */
  max?: number;
  tone?: 'accent' | 'success' | 'warning' | 'danger';
  width?: number;
  height?: number;
  className?: string;
  title?: string;
}

const TONE_CLASS = {
  accent: 'text-app-accent',
  success: 'text-app-success',
  warning: 'text-app-warning',
  danger: 'text-app-danger',
} as const;

/**
 * 轻量 SVG 迷你趋势图，不引入图表库。
 * 样本不足 2 个时显示“采样中”，避免绘制无意义的直线。
 */
export function Sparkline(props: SparklineProps): JSX.Element {
  const width = props.width ?? 88;
  const height = props.height ?? 22;
  const values = props.values;

  if (values.length < 2) {
    return (
      <span className={cn('text-[10px] text-app-muted', props.className)} title={props.title}>
        采样中
      </span>
    );
  }

  const maximum = props.max ?? Math.max(...values, 1);
  const floor = Math.min(...values, 0);
  const span = Math.max(maximum - floor, 0.0001);
  const stepX = width / (values.length - 1);
  const points = values.map((value, index) => {
    const normalized = (Math.min(Math.max(value, floor), maximum) - floor) / span;
    const x = index * stepX;
    const y = height - 2 - normalized * (height - 4);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const last = points[points.length - 1] ?? `${width},${height}`;

  return (
    <svg
      role="img"
      aria-label={props.title ?? '最近趋势'}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn('shrink-0', TONE_CLASS[props.tone ?? 'accent'], props.className)}
    >
      {props.title === undefined ? null : <title>{props.title}</title>}
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={last.split(',')[0]} cy={last.split(',')[1]} r="1.6" fill="currentColor" />
    </svg>
  );
}
