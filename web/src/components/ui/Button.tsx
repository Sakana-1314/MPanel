import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger' | 'success';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'icon';

export interface ButtonProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
  iconRight?: ReactNode;
  fullWidth?: boolean;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary:
    'bg-app-accent text-white hover:bg-app-accent-strong border border-transparent shadow-sm disabled:bg-app-accent/50',
  secondary:
    'bg-app-elevated text-app-text hover:bg-app-surface border border-app-border disabled:opacity-60',
  outline:
    'bg-transparent text-app-text hover:bg-app-elevated border border-app-border disabled:opacity-60',
  ghost:
    'bg-transparent text-app-muted hover:bg-app-elevated hover:text-app-text border border-transparent disabled:opacity-50',
  danger:
    'bg-app-danger text-white hover:opacity-90 border border-transparent disabled:bg-app-danger/50',
  success:
    'bg-app-success text-white hover:opacity-90 border border-transparent disabled:bg-app-success/50',
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  xs: 'h-7 px-2 text-xs gap-1.5',
  sm: 'h-8 px-2.5 text-xs gap-1.5',
  md: 'h-9 px-3.5 text-sm gap-2',
  lg: 'h-11 px-5 text-sm gap-2',
  icon: 'h-8 w-8 p-0',
};

export function Button(props: ButtonProps & ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  const {
    variant = 'primary',
    size = 'md',
    loading = false,
    icon,
    iconRight,
    fullWidth = false,
    className,
    children,
    disabled,
    type = 'button',
    ...rest
  } = props;
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-md font-medium transition-colors focus-visible:outline-none disabled:cursor-not-allowed',
        VARIANT_CLASS[variant],
        SIZE_CLASS[size],
        fullWidth ? 'w-full' : '',
        className,
      )}
    >
      {loading ? <Spinner size="xs" /> : icon}
      {children}
      {iconRight}
    </button>
  );
}
