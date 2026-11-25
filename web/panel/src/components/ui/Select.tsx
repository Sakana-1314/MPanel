import { forwardRef } from 'react';
import type { SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  options?: readonly SelectOption[];
  invalid?: boolean;
  placeholder?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(props, ref) {
  const { options, invalid = false, placeholder, className, children, ...rest } = props;
  return (
    <span className="relative flex w-full items-center">
      <select
        {...rest}
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(
          'h-9 w-full appearance-none rounded-md border bg-app-surface pl-3 pr-8 text-sm text-app-text',
          'focus:border-app-accent focus:outline-none focus:ring-1 focus:ring-app-accent disabled:cursor-not-allowed disabled:opacity-60',
          invalid ? 'border-app-danger' : 'border-app-border',
          className,
        )}
      >
        {placeholder === undefined ? null : (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options === undefined
          ? children
          : options.map((option) => (
              <option key={option.value} value={option.value} disabled={option.disabled}>
                {option.label}
              </option>
            ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 h-4 w-4 text-app-muted" />
    </span>
  );
});
