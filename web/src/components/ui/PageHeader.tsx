import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** 标题上方的面包屑/上下文。 */
  breadcrumbs?: ReactNode;
  /** 标题右侧的状态徽标/版本等。 */
  meta?: ReactNode;
  className?: string;
}

export function PageHeader(props: PageHeaderProps): JSX.Element {
  return (
    <header className={cn('mb-4 flex flex-col gap-2', props.className)}>
      {props.breadcrumbs === undefined ? null : (
        <div className="text-xs text-app-muted">{props.breadcrumbs}</div>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight text-app-text">{props.title}</h1>
            {props.meta}
          </div>
          {props.description === undefined ? null : (
            <p className="max-w-3xl text-sm leading-relaxed text-app-muted">{props.description}</p>
          )}
        </div>
        {props.actions === undefined ? null : (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{props.actions}</div>
        )}
      </div>
    </header>
  );
}
