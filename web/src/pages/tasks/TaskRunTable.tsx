import { useState } from 'react';
import { ChevronDown, ChevronRight, TerminalSquare } from 'lucide-react';
import type { TaskRun } from '../../api/types';
import { formatDate, formatDuration } from '../../lib/format';
import { cn } from '../../lib/cn';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { CopyButton } from '../../components/ui/CopyButton';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorState } from '../../components/ui/ErrorState';
import { RelativeTime } from '../../components/ui/RelativeTime';
import { Spinner } from '../../components/ui/Spinner';
import { StatusBadge } from '../../components/ui/StatusBadge';

export interface TaskRunTableProps {
  runs: readonly TaskRun[];
  onOpen?: (run: TaskRun) => void;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  emptyText?: string;
  className?: string;
}

const COLUMN_COUNT = 6;

/**
 * 运行历史表格：时间/耗时/退出码，行内可折叠查看 stdout/stderr 尾部（等宽、可复制）。
 */
export function TaskRunTable(props: TaskRunTableProps): JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  // TanStack Query 用 null 表示“无错误”，这里统一转成 undefined。
  const tableError = props.error ?? undefined;

  const toggle = (run: TaskRun): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(run.id)) {
        next.delete(run.id);
      } else {
        next.add(run.id);
        props.onOpen?.(run);
      }
      return next;
    });
  };

  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border border-app-border bg-app-surface',
        props.className,
      )}
    >
      <div className="overflow-auto">
        <table className="min-w-[760px] w-full border-collapse text-sm">
          <thead className="bg-app-elevated/80 text-left">
            <tr>
              {['状态', '开始时间', '触发', '耗时', '退出码', '输出'].map((header, index) => (
                <th
                  key={header}
                  scope="col"
                  className={cn(
                    'whitespace-nowrap border-b border-app-border px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-app-muted',
                    index === COLUMN_COUNT - 1 ? 'text-right' : '',
                  )}
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tableError !== undefined ? (
              <tr>
                <td colSpan={COLUMN_COUNT} className="px-3 py-4">
                  <ErrorState error={tableError} onRetry={props.onRetry} />
                </td>
              </tr>
            ) : props.loading === true && props.runs.length === 0 ? (
              <tr>
                <td colSpan={COLUMN_COUNT} className="px-3 py-8 text-center">
                  <Spinner label="加载运行历史…" />
                </td>
              </tr>
            ) : props.runs.length === 0 ? (
              <tr>
                <td colSpan={COLUMN_COUNT} className="px-3 py-6">
                  <EmptyState
                    compact
                    icon={<TerminalSquare className="h-5 w-5" />}
                    title="暂无运行记录"
                    description={props.emptyText ?? '定时触发或手动“立即运行”后，这里会显示退出码与输出尾部。'}
                  />
                </td>
              </tr>
            ) : (
              props.runs.map((run) => {
                const isOpen = expanded.has(run.id);
                return (
                  <RunRows
                    key={run.id}
                    run={run}
                    open={isOpen}
                    onToggle={() => toggle(run)}
                  />
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {props.loading === true && props.runs.length > 0 ? (
        <div className="flex items-center justify-center border-t border-app-border px-3 py-2">
          <Spinner size="sm" label="刷新中…" />
        </div>
      ) : null}
    </div>
  );
}

function RunRows(props: { run: TaskRun; open: boolean; onToggle(): void }): JSX.Element {
  const { run } = props;
  const duration = resolveDuration(run);
  return (
    <>
      <tr
        className={cn(
          'border-b border-app-border/70 last:border-b-0',
          run.status === 'running' ? 'bg-app-info/5' : '',
        )}
      >
        <td className="px-3 py-2">
          <StatusBadge status={run.status} size="sm" />
        </td>
        <td className="px-3 py-2">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs tabular-nums text-app-text" title={formatDate(run.startedAt)}>
              {formatDate(run.startedAt)}
            </span>
            <RelativeTime value={run.startedAt} className="text-[10px] text-app-muted" />
          </div>
        </td>
        <td className="px-3 py-2">
          <Badge tone={run.triggeredBy === 'manual' ? 'accent' : 'neutral'} className="px-1.5 py-0 text-[10px]">
            {run.triggeredBy === 'manual' ? '手动' : '定时'}
          </Badge>
        </td>
        <td className="px-3 py-2 text-xs tabular-nums text-app-text">
          {duration === null ? '—' : formatDuration(duration)}
        </td>
        <td className="px-3 py-2">
          <span
            className={cn(
              'font-mono text-xs',
              run.exitCode === 0
                ? 'text-app-success'
                : run.exitCode === null || run.exitCode === undefined
                  ? 'text-app-muted'
                  : 'text-app-danger',
            )}
          >
            {run.exitCode === null || run.exitCode === undefined ? '—' : run.exitCode}
          </span>
        </td>
        <td className="px-3 py-2 text-right">
          <Button
            variant="ghost"
            size="xs"
            icon={props.open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            onClick={props.onToggle}
            aria-expanded={props.open}
          >
            {props.open ? '收起' : '查看输出'}
          </Button>
        </td>
      </tr>
      {props.open ? (
        <tr className="border-b border-app-border/70 bg-app-bg/40">
          <td colSpan={COLUMN_COUNT} className="px-3 py-3">
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-app-muted">
                <span>运行 ID：<span className="font-mono text-app-text">{run.id}</span></span>
                {run.finishedAt === null || run.finishedAt === undefined ? null : (
                  <span>结束：{formatDate(run.finishedAt)}</span>
                )}
                {run.truncated ? <Badge tone="warning" className="px-1.5 py-0 text-[10px]">输出已截断（仅保留尾部）</Badge> : null}
                {run.logPath === null || run.logPath === undefined ? null : (
                  <span className="font-mono">完整日志：{run.logPath}</span>
                )}
              </div>
              <div className="grid gap-2 lg:grid-cols-2">
                <OutputBlock title="stdout" text={run.stdoutTail ?? ''} />
                <OutputBlock title="stderr" text={run.stderrTail ?? ''} />
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function OutputBlock(props: { title: string; text: string }): JSX.Element {
  return (
    <div className="overflow-hidden rounded-lg border border-app-border bg-app-bg">
      <div className="flex items-center justify-between gap-2 border-b border-app-border bg-app-elevated/60 px-2 py-1">
        <span className="font-mono text-[11px] uppercase tracking-wide text-app-muted">{props.title}</span>
        <CopyButton
          value={props.text}
          label="复制"
          size="xs"
          variant="ghost"
          title={`复制 ${props.title} 输出`}
        />
      </div>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all p-2 font-mono text-[11.5px] leading-relaxed text-app-text">
        {props.text.length === 0 ? <span className="text-app-muted">（无输出）</span> : props.text}
      </pre>
    </div>
  );
}

function resolveDuration(run: TaskRun): number | null {
  if (typeof run.durationMs === 'number' && Number.isFinite(run.durationMs)) {
    return Math.max(0, run.durationMs);
  }
  if (run.finishedAt !== null && run.finishedAt !== undefined) {
    const started = new Date(run.startedAt).getTime();
    const finished = new Date(run.finishedAt).getTime();
    if (Number.isFinite(started) && Number.isFinite(finished) && finished >= started) {
      return finished - started;
    }
  }
  return null;
}
