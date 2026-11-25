import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
  id?: string;
}

export function Switch(props: SwitchProps): JSX.Element {
  const { checked, onChange, label, description, disabled = false, className, id } = props;
  const control = (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors',
        checked ? 'border-app-accent bg-app-accent' : 'border-app-border bg-app-elevated',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
      )}
    >
      <span
        className={cn(
          'inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-[1.15rem]' : 'translate-x-[0.15rem]',
        )}
      />
    </button>
  );
  if (label === undefined && description === undefined) {
    return <span className={className}>{control}</span>;
  }
  return (
    <div className={cn('flex items-start gap-3', className)}>
      <span className="mt-0.5">{control}</span>
      <label htmlFor={id} className="flex cursor-pointer flex-col gap-0.5 text-sm text-app-text">
        {label}
        {description === undefined ? null : (
          <span className="text-xs text-app-muted">{description}</span>
        )}
      </label>
    </div>
  );
}
