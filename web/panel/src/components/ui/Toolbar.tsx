import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export interface ToolbarProps {
  children?: ReactNode;
  /** 左侧区域（筛选、搜索）。 */
  left?: ReactNode;
  /** 右侧区域（主操作按钮）。 */
  right?: ReactNode;
  className?: string;
  /** 是否显示底部分隔线。 */
  bordered?: boolean;
}

/** 列表页工具栏：左侧筛选、右侧操作，换行自适应。 */
export function Toolbar(props: ToolbarProps): JSX.Element {
  return (
    <div
      className={cn(
        'mb-3 flex flex-wrap items-center justify-between gap-2',
        props.bordered === true ? 'border-b border-app-border pb-3' : '',
        props.className,
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {props.left}
        {props.children}
      </div>
      {props.right === undefined ? null : (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{props.right}</div>
      )}
    </div>
  );
}
