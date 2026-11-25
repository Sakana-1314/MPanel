import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface FormFieldProps {
  label?: ReactNode;
  /** 文件布局约定的字段说明（与 description 等价）。 */
  hint?: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
  /** 标签右侧的辅助操作（如“查看文档”）。 */
  actions?: ReactNode;
}

export function FormField(props: FormFieldProps): JSX.Element {
  const description = props.description ?? props.hint;
  const hasLabel = props.label !== undefined;
  return (
    <div className={cn('flex flex-col gap-1.5', props.className)}>
      {hasLabel || props.actions !== undefined ? (
        <div className="flex items-center justify-between gap-2">
          {hasLabel ? (
            <label htmlFor={props.htmlFor} className="text-xs font-medium text-app-text">
              {props.label}
              {props.required === true ? <span className="ml-0.5 text-app-danger">*</span> : null}
            </label>
          ) : (
            <span />
          )}
          {props.actions}
        </div>
      ) : null}
      {props.children}
      {description === undefined ? null : (
        <p className="text-xs text-app-muted">{description}</p>
      )}
      {props.error === undefined || props.error === null || props.error === '' ? null : (
        <p className="text-xs text-app-danger" role="alert">
          {props.error}
        </p>
      )}
    </div>
  );
}
