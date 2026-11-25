import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '../../lib/cn';

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: ModalSize;
  /** 点击遮罩关闭，默认 true。 */
  closeOnOverlay?: boolean;
  className?: string;
  bodyClassName?: string;
}

const SIZE_CLASS: Record<ModalSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-xl',
  lg: 'max-w-3xl',
  xl: 'max-w-5xl',
};

export function Modal(props: ModalProps): JSX.Element | null {
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 animate-fade-in"
      onMouseDown={(event) => {
        if (props.closeOnOverlay === false) return;
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={typeof props.title === 'string' ? props.title : '对话框'}
        className={cn(
          'flex max-h-[90vh] w-full flex-col rounded-xl border border-app-border bg-app-surface shadow-panel animate-scale-in',
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
      </div>
    </div>,
    document.body,
  );
}
