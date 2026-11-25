import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Button } from './Button';
import { Alert } from './Alert';
import { describeError } from '../../api/errors';

export interface ErrorStateProps {
  error: unknown;
  onRetry?: () => void;
  title?: string;
  className?: string;
}

/** 统一的错误展示：错误码、消息、可执行 hint 与重试。 */
export function ErrorState(props: ErrorStateProps): JSX.Element {
  const info = describeError(props.error, props.title ?? '加载失败');
  return (
    <Alert
      tone="danger"
      title={props.title ?? info.title}
      hint={info.hint}
      className={props.className}
      action={
        props.onRetry === undefined ? undefined : (
          <Button variant="secondary" size="sm" onClick={props.onRetry}>
            重试
          </Button>
        )
      }
    >
      {info.description}
    </Alert>
  );
}

export interface InlineErrorProps {
  error: unknown;
  className?: string;
}

export function InlineError(props: InlineErrorProps): JSX.Element {
  const info = describeError(props.error);
  return (
    <p className={cn('text-xs text-app-danger', props.className)}>
      {info.title}：{info.description}
    </p>
  );
}

export interface SkeletonProps {
  className?: string;
  lines?: number;
}

export function Skeleton(props: SkeletonProps): JSX.Element {
  const lines = props.lines ?? 3;
  return (
    <div className={cn('flex flex-col gap-2', props.className)} aria-hidden>
      {Array.from({ length: lines }, (_, index) => (
        <div
          key={index}
          className="skeleton h-3"
          style={{ width: `${Math.max(35, 100 - index * 12)}%` }}
        />
      ))}
    </div>
  );
}

export interface LoadingSkeletonProps {
  rows?: number;
  className?: string;
  children?: ReactNode;
}

export function LoadingSkeleton(props: LoadingSkeletonProps): JSX.Element {
  return (
    <div className={cn('flex flex-col gap-3', props.className)} aria-busy>
      {props.children ?? <Skeleton lines={props.rows ?? 4} />}
    </div>
  );
}
