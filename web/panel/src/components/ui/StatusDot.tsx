import { cn } from '../../lib/cn';
import { statusTone, TONE_CLASS } from './tones';

export type StatusDotStatus =
  | 'online'
  | 'offline'
  | 'degraded'
  | 'error'
  | 'starting'
  | 'success'
  | 'warning'
  | 'pending'
  | 'unknown';

export interface StatusDotProps {
  status: StatusDotStatus | string;
  pulse?: boolean;
  label?: string;
  className?: string;
}

export function StatusDot(props: StatusDotProps): JSX.Element {
  const tone = statusTone(props.status);
  return (
    <span
      className={cn('relative inline-flex h-2 w-2 shrink-0', props.className)}
      title={props.label}
      aria-label={props.label}
    >
      {props.pulse === true ? (
        <span
          className={cn(
            'absolute inline-flex h-full w-full animate-ping rounded-full opacity-60',
            TONE_CLASS[tone].dot,
          )}
        />
      ) : null}
      <span className={cn('relative inline-flex h-2 w-2 rounded-full', TONE_CLASS[tone].dot)} />
    </span>
  );
}
