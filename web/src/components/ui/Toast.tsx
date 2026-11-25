import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import { cn } from '../../lib/cn';

export type ToastTone = 'info' | 'success' | 'warning' | 'error';

export interface ToastInput {
  title: string;
  description?: string;
  tone?: ToastTone;
  /** 0 表示不自动关闭。 */
  durationMs?: number;
}

export interface ToastApi {
  push(input: ToastInput): void;
  success(title: string, description?: string): void;
  error(title: string, description?: string): void;
  info(title: string, description?: string): void;
  warning(title: string, description?: string): void;
  dismiss(id: number): void;
}

interface ToastItem extends ToastInput {
  id: number;
}

const ToastContext = createContext<ToastApi>({
  push: () => undefined,
  success: () => undefined,
  error: () => undefined,
  info: () => undefined,
  warning: () => undefined,
  dismiss: () => undefined,
});

const TONE_CLASS: Record<ToastTone, string> = {
  info: 'border-app-info/50 bg-app-surface text-app-text',
  success: 'border-app-success/50 bg-app-surface text-app-text',
  warning: 'border-app-warning/50 bg-app-surface text-app-text',
  error: 'border-app-danger/60 bg-app-surface text-app-text',
};

const TONE_ICON: Record<ToastTone, ReactNode> = {
  info: <Info className="h-4 w-4 text-app-info" />,
  success: <CircleCheck className="h-4 w-4 text-app-success" />,
  warning: <TriangleAlert className="h-4 w-4 text-app-warning" />,
  error: <CircleAlert className="h-4 w-4 text-app-danger" />,
};

export function ToastProvider(props: { children: ReactNode }): JSX.Element {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (input: ToastInput) => {
      const id = nextId.current;
      nextId.current += 1;
      setItems((current) => [...current.slice(-4), { ...input, id }]);
      const duration = input.durationMs ?? (input.tone === 'error' ? 7000 : 4000);
      if (duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration),
        );
      }
    },
    [dismiss],
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const timer of map.values()) clearTimeout(timer);
      map.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      push,
      dismiss,
      success: (title, description) => push({ title, description, tone: 'success' }),
      error: (title, description) => push({ title, description, tone: 'error' }),
      info: (title, description) => push({ title, description, tone: 'info' }),
      warning: (title, description) => push({ title, description, tone: 'warning' }),
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {props.children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2"
        aria-live="polite"
        aria-atomic="false"
      >
        {items.map((item) => (
          <div
            key={item.id}
            className={cn(
              'pointer-events-auto flex items-start gap-2.5 rounded-lg border px-3 py-2.5 shadow-panel animate-slide-in-bottom',
              TONE_CLASS[item.tone ?? 'info'],
            )}
            role={item.tone === 'error' ? 'alert' : 'status'}
          >
            <span className="mt-0.5 shrink-0">{TONE_ICON[item.tone ?? 'info']}</span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium leading-snug">{item.title}</p>
              {item.description === undefined ? null : (
                <p className="mt-0.5 break-words text-xs leading-relaxed text-app-muted">
                  {item.description}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => dismiss(item.id)}
              aria-label="关闭提示"
              className="rounded p-0.5 text-app-muted hover:bg-app-elevated hover:text-app-text"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  return useContext(ToastContext);
}
