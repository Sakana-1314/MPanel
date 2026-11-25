import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface TabItem {
  id: string;
  label: ReactNode;
  badge?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  tabs: readonly TabItem[];
  active: string;
  onChange: (id: string) => void;
  className?: string;
  /** 紧凑模式（卡片内筛选）。 */
  compact?: boolean;
}

export function Tabs(props: TabsProps): JSX.Element {
  return (
    <div
      role="tablist"
      className={cn(
        'flex flex-wrap items-center gap-1 border-b border-app-border',
        props.compact === true ? 'pb-1.5' : 'pb-2',
        props.className,
      )}
    >
      {props.tabs.map((tab) => {
        const selected = tab.id === props.active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            disabled={tab.disabled}
            onClick={() => props.onChange(tab.id)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              props.compact === true ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm',
              selected
                ? 'bg-app-elevated text-app-text'
                : 'text-app-muted hover:bg-app-elevated/60 hover:text-app-text',
            )}
          >
            {tab.label}
            {tab.badge === undefined ? null : (
              <span className="rounded-full bg-app-border/60 px-1.5 text-[10px] text-app-muted">
                {tab.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
