import { forwardRef } from 'react';
import type { TextareaHTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
  mono?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  props,
  ref,
) {
  const { invalid = false, mono = false, className, rows = 3, ...rest } = props;
  return (
    <textarea
      {...rest}
      ref={ref}
      rows={rows}
      aria-invalid={invalid || undefined}
      className={cn(
        'w-full resize-y rounded-md border bg-app-surface px-3 py-2 text-sm text-app-text placeholder:text-app-muted/70',
        'focus:border-app-accent focus:outline-none focus:ring-1 focus:ring-app-accent disabled:cursor-not-allowed disabled:opacity-60',
        invalid ? 'border-app-danger' : 'border-app-border',
        mono ? 'font-mono text-xs leading-relaxed' : '',
        className,
      )}
    />
  );
});
