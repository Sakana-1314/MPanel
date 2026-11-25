import type { ReactNode } from 'react';
import { Inbox } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface EmptyStateProps {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
  compact?: boolean;
}

export function EmptyState(props: EmptyStateProps): JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-app-border bg-app-surface/40 text-center',
        props.compact === true ? 'px-4 py-6' : 'px-6 py-12',
        props.className,
      )}
    >
      <span className="rounded-full bg-app-elevated p-2.5 text-app-muted">
        {props.icon ?? <Inbox className="h-5 w-5" />}
      </span>
      <p className="text-sm font-medium text-app-text">{props.title}</p>
      {props.description === undefined ? null : (
        <p className="max-w-md text-xs leading-relaxed text-app-muted">{props.description}</p>
      )}
      {props.action === undefined ? null : <div className="mt-1">{props.action}</div>}
    </div>
  );
}
