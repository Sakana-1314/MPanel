import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '../../lib/cn';

export type DrawerSize = 'sm' | 'md' | 'lg' | 'xl' | 'full';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: DrawerSize;
  side?: 'right' | 'left';
  className?: string;
  bodyClassName?: string;
}

const SIZE_CLASS: Record<DrawerSize, string> = {
  sm: 'w-full max-w-sm',
  md: 'w-full max-w-lg',
  lg: 'w-full max-w-2xl',
  xl: 'w-full max-w-4xl',
  full: 'w-full max-w-full',
};

/** 右侧抽屉：用于连接管理、证书详情、站点快速新建等。 */
export function Drawer(props: DrawerProps): JSX.Element | null {
  const { open, onClose } = props;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex bg-black/60 animate-fade-in"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={typeof props.title === 'string' ? props.title : '抽屉'}
        className={cn(
          'flex h-full flex-col border-app-border bg-app-surface shadow-panel',
          props.side === 'left'
            ? 'mr-auto border-r animate-slide-in-right'
            : 'ml-auto border-l animate-slide-in-right',
          SIZE_CLASS[props.size ?? 'md'],
          props.className,
        )}
      >
        <header className="flex items-start justify-between gap-3 border-b border-app-border px-4 py-3">
          <div className="min-w-0">
            {props.title === undefined ? null : (
              <h2 className="truncate text-sm font-semibold text-app-text">{props.title}</h2>
            )}
            {props.description === undefined ? null : (
              <p className="mt-0.5 text-xs text-app-muted">{props.description}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="rounded p-1 text-app-muted hover:bg-app-elevated hover:text-app-text"
          >
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className={cn('min-h-0 flex-1 overflow-auto px-4 py-4 text-sm', props.bodyClassName)}>
          {props.children}
        </div>
        {props.footer === undefined ? null : (
          <footer className="flex items-center justify-end gap-2 border-t border-app-border px-4 py-3">
            {props.footer}
          </footer>
        )}
      </aside>
    </div>,
    document.body,
  );
}
