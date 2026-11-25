import { useEffect, useState } from 'react';
import { cn } from '../../lib/cn';
import { formatDate, formatRelativeTime } from '../../lib/format';

export interface RelativeTimeProps {
  value: string | Date | null | undefined;
  className?: string;
  prefix?: string;
  suffix?: string;
  fallback?: string;
  /** 悬停时显示绝对时间（默认是）。 */
  showAbsoluteOnHover?: boolean;
}

/** 相对时间，每 30 秒自刷新；title 提供绝对时间。 */
export function RelativeTime(props: RelativeTimeProps): JSX.Element {
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  if (props.value === null || props.value === undefined || props.value === '') {
    return <span className={cn('text-app-muted', props.className)}>{props.fallback ?? '—'}</span>;
  }

  const relative = formatRelativeTime(props.value);
  const absolute = formatDate(typeof props.value === 'string' ? props.value : props.value.toISOString());

  return (
    <time
      dateTime={typeof props.value === 'string' ? props.value : props.value.toISOString()}
      title={props.showAbsoluteOnHover === false ? undefined : absolute}
      className={cn('tabular-nums', props.className)}
    >
      {props.prefix}
      {relative}
      {props.suffix}
    </time>
  );
}
