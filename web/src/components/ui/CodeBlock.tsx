import { cn } from '../../lib/cn';
import { CopyButton } from './CopyButton';

export interface CodeBlockProps {
  code: string;
  language?: string;
  maxHeight?: string | number;
  className?: string;
  /** 显示右上角复制按钮。 */
  copyable?: boolean;
  emptyText?: string;
}

/** 轻量只读代码块（不做语法高亮，避免额外依赖）。 */
export function CodeBlock(props: CodeBlockProps): JSX.Element {
  return (
    <div
      className={cn(
        'relative overflow-hidden rounded-lg border border-app-border bg-app-elevated/60',
        props.className,
      )}
    >
      {props.language === undefined ? null : (
        <span className="absolute left-2 top-2 rounded bg-app-border/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-app-muted">
          {props.language}
        </span>
      )}
      {props.copyable === false ? null : (
        <div className="absolute right-1.5 top-1.5">
          <CopyButton value={props.code} />
        </div>
      )}
      <pre
        className={cn(
          'overflow-auto p-3 font-mono text-xs leading-relaxed text-app-text',
          props.language === undefined ? '' : 'pt-7',
          props.copyable === false ? '' : 'pr-10',
        )}
        style={{ maxHeight: props.maxHeight ?? '320px' }}
      >
        <code>{props.code.length === 0 ? (props.emptyText ?? '（空）') : props.code}</code>
      </pre>
    </div>
  );
}
