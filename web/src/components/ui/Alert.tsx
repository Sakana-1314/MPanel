import type { ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import { cn } from '../../lib/cn';
import { describeError, type AppError } from '../../api/errors';

export type AlertTone = 'info' | 'success' | 'warning' | 'danger' | 'neutral';

export interface AlertProps {
  tone?: AlertTone;
  title?: ReactNode;
  children?: ReactNode;
  /** 可执行的下一步提示（UNAVAILABLE 的 details.hint 展示在这里）。 */
  hint?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode | false;
  className?: string;
}

const TONE: Record<AlertTone, { wrap: string; icon: string; title: string }> = {
  info: {
    wrap: 'border-app-info/40 bg-app-info/10 text-app-text',
    icon: 'text-app-info',
    title: 'text-app-info',
  },
  success: {
    wrap: 'border-app-success/40 bg-app-success/10 text-app-text',
    icon: 'text-app-success',
    title: 'text-app-success',
  },
  warning: {
    wrap: 'border-app-warning/40 bg-app-warning/10 text-app-text',
    icon: 'text-app-warning',
    title: 'text-app-warning',
  },
  danger: {
    wrap: 'border-app-danger/40 bg-app-danger/10 text-app-text',
    icon: 'text-app-danger',
    title: 'text-app-danger',
  },
  neutral: {
    wrap: 'border-app-border bg-app-elevated text-app-text',
    icon: 'text-app-muted',
    title: 'text-app-text',
  },
};

const DEFAULT_ICON: Record<AlertTone, ReactNode> = {
  info: <Info className="h-4 w-4" />,
  success: <CircleCheck className="h-4 w-4" />,
  warning: <TriangleAlert className="h-4 w-4" />,
  danger: <CircleAlert className="h-4 w-4" />,
  neutral: <Info className="h-4 w-4" />,
};

export function Alert(props: AlertProps): JSX.Element {
  const tone = props.tone ?? 'info';
  const palette = TONE[tone];
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn('flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm', palette.wrap, props.className)}
    >
      {props.icon === false ? null : (
        <span className={cn('mt-0.5 shrink-0', palette.icon)}>
          {props.icon ?? DEFAULT_ICON[tone]}
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {props.title === undefined ? null : (
          <p className={cn('text-sm font-medium', palette.title)}>{props.title}</p>
        )}
        {props.children === undefined ? null : (
          <div className="text-xs leading-relaxed text-app-muted">{props.children}</div>
        )}
        {props.hint === undefined ? null : (
          <p className="text-xs leading-relaxed text-app-text">{props.hint}</p>
        )}
      </div>
      {props.action === undefined ? null : <div className="shrink-0">{props.action}</div>}
    </div>
  );
}

export interface UnavailableAlertProps {
  /** 已捕获的错误（UNAVAILABLE 时展示 hint）。 */
  error?: unknown;
  /** 列表/能力探测给出的 available=false 原因。 */
  available?: boolean;
  reason?: string;
  hint?: string;
  title?: string;
  capability?: string;
  className?: string;
  action?: ReactNode;
}

/**
 * 能力不可用提示的统一出口：
 * 展示 reason（来自 available=false / details.reason）与可执行 hint（details.hint）。
 */
export function UnavailableAlert(props: UnavailableAlertProps): JSX.Element | null {
  const errorInfo =
    props.error === undefined ? undefined : describeError(props.error);
  const isUnavailable =
    props.available === false ||
    (props.error !== undefined &&
      typeof props.error === 'object' &&
      props.error !== null &&
      (props.error as AppError).code === 'UNAVAILABLE');

  if (!isUnavailable && props.error === undefined) return null;

  const hint = props.hint ?? extractHint(props.error) ?? errorInfo?.hint;
  const reason =
    props.reason ??
    extractReason(props.error) ??
    (props.available === false ? '后端报告该能力当前不可用。' : errorInfo?.description);

  return (
    <Alert
      tone={props.error !== undefined && !isUnavailable ? 'danger' : 'warning'}
      title={props.title ?? (props.capability === undefined ? '能力不可用' : `${props.capability} 不可用`)}
      hint={hint}
      action={props.action}
      className={props.className}
    >
      {reason}
    </Alert>
  );
}

function extractHint(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && error instanceof Error) {
    const candidate = (error as AppError).hint;
    return typeof candidate === 'string' ? candidate : undefined;
  }
  return undefined;
}

function extractReason(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && error instanceof Error) {
    return (error as AppError).reason;
  }
  return undefined;
}
