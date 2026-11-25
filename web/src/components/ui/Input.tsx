import { forwardRef } from 'react';
import type { InputHTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
  containerClassName?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(props, ref) {
  const { invalid = false, leading, trailing, className, containerClassName, ...rest } = props;
  return (
    <span className={cn('relative flex w-full items-center', containerClassName)}>
      {leading === undefined ? null : (
        <span className="pointer-events-none absolute left-2.5 flex text-app-muted">{leading}</span>
      )}
      <input
        {...rest}
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(
          'h-9 w-full rounded-md border bg-app-surface px-3 text-sm text-app-text placeholder:text-app-muted/70',
          'focus:border-app-accent focus:outline-none focus:ring-1 focus:ring-app-accent disabled:cursor-not-allowed disabled:opacity-60',
          invalid ? 'border-app-danger' : 'border-app-border',
          leading === undefined ? '' : 'pl-8',
          trailing === undefined ? '' : 'pr-9',
          className,
        )}
      />
      {trailing === undefined ? null : (
        <span className="absolute right-2 flex items-center text-app-muted">{trailing}</span>
      )}
    </span>
  );
});
