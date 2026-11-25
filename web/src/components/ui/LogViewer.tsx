import { useEffect, useRef } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from './Button';
import { cn } from '../../lib/cn';

export interface LogLine {
  ts?: string;
  stream?: 'stdout' | 'stderr' | string;
  text: string;
}

export interface LogViewerProps {
  lines: readonly LogLine[];
  follow?: boolean;
  onClear?: () => void;
  emptyText?: string;
  height?: string;
  className?: string;
}

/** 容器日志/命令输出查看器：等宽、自动跟随底部、stderr 标红。 */
export function LogViewer(props: LogViewerProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const follow = props.follow !== false;

  useEffect(() => {
    if (!follow) return;
    const element = containerRef.current;
    if (element === null) return;
    element.scrollTop = element.scrollHeight;
  }, [props.lines, follow]);

  return (
    <div className={cn('overflow-hidden rounded-lg border border-app-border bg-app-bg', props.className)}>
      <div className="flex items-center justify-between border-b border-app-border bg-app-elevated/60 px-2 py-1">
        <span className="text-[11px] text-app-muted">
          {props.lines.length === 0 ? '无输出' : `${props.lines.length} 行`}
        </span>
        {props.onClear === undefined ? null : (
          <Button
            variant="ghost"
            size="xs"
            icon={<Trash2 className="h-3 w-3" />}
            onClick={props.onClear}
          >
            清空
          </Button>
        )}
      </div>
      <div
        ref={containerRef}
        className="overflow-auto p-2 font-mono text-[11.5px] leading-relaxed"
        style={{ height: props.height ?? '320px' }}
      >
        {props.lines.length === 0 ? (
          <p className="text-app-muted">{props.emptyText ?? '暂无日志。'}</p>
        ) : (
          props.lines.map((line, index) => (
            <div key={index} className="flex gap-2 whitespace-pre-wrap break-all">
              {line.ts === undefined ? null : (
                <span className="shrink-0 tabular-nums text-app-muted">{formatTs(line.ts)}</span>
              )}
              <span
                className={cn(
                  'min-w-0',
                  line.stream === 'stderr' ? 'text-app-danger' : 'text-app-text',
                )}
              >
                {line.text}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function formatTs(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}
