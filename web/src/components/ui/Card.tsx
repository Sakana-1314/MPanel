import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { TONE_CLASS, type StatusTone } from './tones';

export interface CardProps {
  children: ReactNode;
  className?: string;
  /** 紧凑卡片（列表项/提示）。 */
  compact?: boolean;
}

export function Card(props: CardProps): JSX.Element {
  return (
    <section
      className={cn(
        'rounded-xl border border-app-border bg-app-surface shadow-panel',
        props.compact === true ? 'p-3' : '',
        props.className,
      )}
    >
      {props.children}
    </section>
  );
}

export interface CardHeaderProps {
  title?: ReactNode;
  /** 兼容旧写法 <CardHeader>标题</CardHeader>。 */
  children?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  icon?: ReactNode;
  className?: string;
  /** 去掉底部分隔线（嵌在表单卡片里时更紧凑）。 */
  borderless?: boolean;
}

export function CardHeader(props: CardHeaderProps): JSX.Element {
  return (
    <header
      className={cn(
        'flex flex-wrap items-start justify-between gap-3 px-4 py-3',
        props.borderless === true ? '' : 'border-b border-app-border',
        props.className,
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        {props.icon === undefined ? null : (
          <span className="mt-0.5 text-app-muted">{props.icon}</span>
        )}
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-app-text">
            {props.title ?? props.children}
          </h2>
          {props.description === undefined ? null : (
            <p className="mt-0.5 text-xs text-app-muted">{props.description}</p>
          )}
        </div>
      </div>
      {props.actions === undefined ? null : (
        <div className="flex shrink-0 items-center gap-2">{props.actions}</div>
      )}
    </header>
  );
}

export interface CardBodyProps {
  children: ReactNode;
  className?: string;
  /** 是否允许内容滚动（配合 maxHeight 使用）。 */
  scroll?: boolean;
}

export function CardBody(props: CardBodyProps): JSX.Element {
  return (
    <div className={cn('p-4', props.scroll === true ? 'overflow-auto' : '', props.className)}>
      {props.children}
    </div>
  );
}

export interface StatCardProps {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  tone?: StatusTone;
  className?: string;
  loading?: boolean;
  onClick?: () => void;
}

export function StatCard(props: StatCardProps): JSX.Element {
  const tone = props.tone ?? 'neutral';
  const content = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-app-muted">{props.label}</span>
        {props.icon === undefined ? null : (
          <span className={cn('rounded-md p-1.5', TONE_CLASS[tone].softBg, TONE_CLASS[tone].text)}>
            {props.icon}
          </span>
        )}
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums text-app-text">
          {props.loading === true ? <span className="skeleton inline-block h-7 w-16" /> : props.value}
        </span>
      </div>
      {props.hint === undefined ? null : (
        <p className="mt-1 text-xs text-app-muted">{props.hint}</p>
      )}
    </>
  );

  if (props.onClick === undefined) {
    return (
      <div className={cn('rounded-xl border border-app-border bg-app-surface p-4', props.className)}>
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cn(
        'rounded-xl border border-app-border bg-app-surface p-4 text-left transition-colors hover:border-app-accent/50 hover:bg-app-elevated',
        props.className,
      )}
    >
      {content}
    </button>
  );
}
