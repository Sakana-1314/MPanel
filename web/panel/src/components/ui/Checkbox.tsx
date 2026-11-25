import { forwardRef } from 'react';
import type { InputHTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: ReactNode;
  description?: ReactNode;
  invalid?: boolean;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(props, ref) {
  const { label, description, invalid = false, className, id, ...rest } = props;
  const input = (
    <input
      {...rest}
      ref={ref}
      id={id}
      type="checkbox"
      aria-invalid={invalid || undefined}
      className={cn(
        'h-4 w-4 shrink-0 rounded border-app-border bg-app-surface accent-app-accent',
        invalid ? 'ring-1 ring-app-danger' : '',
        label === undefined ? className : '',
      )}
    />
  );
  if (label === undefined && description === undefined) return input;
  return (
    <label
      htmlFor={id}
      className={cn('flex cursor-pointer items-start gap-2 text-sm text-app-text', className)}
    >
      <span className="mt-0.5">{input}</span>
      <span className="flex flex-col gap-0.5">
        <span>{label}</span>
        {description === undefined ? null : (
          <span className="text-xs text-app-muted">{description}</span>
        )}
      </span>
    </label>
  );
});
