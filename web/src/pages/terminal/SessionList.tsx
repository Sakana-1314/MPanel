import type { TerminalSession } from '../../api/types';
import { formatDate } from '../../lib/format';
import { Alert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { EmptyState } from '../../components/ui/EmptyState';
import { RelativeTime } from '../../components/ui/RelativeTime';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { shellName } from './TerminalTabs';

export interface SessionListProps {
  sessions: readonly TerminalSession[];
  loading?: boolean;
  error?: unknown;
  available?: boolean;
  reason?: string;
  /** 已在本页标签中打开的会话 id。 */
  openIds?: readonly string[];
  onOpen: (session: TerminalSession) => void;
  onDelete: (session: TerminalSession) => void;
  onRetry?: () => void;
  onNew?: () => void;
}

/** 服务端终端会话列表：创建时间、状态、PTY 模式与打开/终止操作。 */
export function SessionList(props: SessionListProps): JSX.Element {
  const openIds = new Set(props.openIds ?? []);
  // TanStack Query 用 null 表示“无错误”，DataTable 只认 undefined。
  const tableError = props.error ?? undefined;

  const columns: readonly Column<TerminalSession>[] = [
    {
      key: 'shell',
      header: '会话',
      render: (session) => (
        <div className="flex min-w-0 flex-col">
          <span className="flex items-center gap-1.5">
            <span className="truncate font-medium text-app-text">{shellName(session.shell)}</span>
            <span className="font-mono text-[10px] text-app-muted">{session.id.slice(0, 8)}</span>
            {openIds.has(session.id) ? (
              <Badge tone="accent" className="px-1.5 py-0 text-[10px]">
                已打开
              </Badge>
            ) : null}
          </span>
          <span className="max-w-[18rem] truncate font-mono text-[11px] text-app-muted" title={session.cwd}>
            {session.cwd}
          </span>
        </div>
      ),
    },
    {
      key: 'createdAt',
      header: '创建时间',
      render: (session) => (
        <div className="flex flex-col gap-0.5">
          <RelativeTime value={session.createdAt} className="text-xs text-app-text" />
          <span className="text-[10px] text-app-muted">{formatDate(session.createdAt)}</span>
        </div>
      ),
    },
    {
      key: 'status',
      header: '状态',
      render: (session) => (
        <div className="flex flex-wrap items-center gap-1">
          <StatusBadge status={session.status} size="sm" />
          <Badge tone={session.pty ? 'info' : 'warning'} className="px-1.5 py-0 text-[10px]">
            {session.pty ? 'PTY' : '管道降级'}
          </Badge>
        </div>
      ),
    },
    {
      key: 'size',
      header: '尺寸',
      align: 'center',
      render: (session) => (
        <span className="font-mono text-[11px] text-app-muted">
          {session.cols} × {session.rows}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '操作',
      align: 'right',
      render: (session) => (
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="secondary"
            size="xs"
            disabled={session.status !== 'running'}
            title={session.status !== 'running' ? '会话进程已退出，无法继续交互' : undefined}
            onClick={() => props.onOpen(session)}
          >
            {openIds.has(session.id) ? '切换' : '打开'}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            className="text-app-danger hover:text-app-danger"
            onClick={() => props.onDelete(session)}
          >
            终止
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      {props.available === false ? (
        <Alert
          tone="warning"
          title="会话列表不可用"
          hint={props.reason ?? '后端未返回终端会话能力，请检查 worker 状态。'}
        >
          仍可以尝试新建会话；若新建失败，请查看 worker 日志与 PTY 依赖。
        </Alert>
      ) : null}

      <DataTable
        columns={columns}
        rows={props.sessions}
        rowKey={(session) => session.id}
        loading={props.loading === true}
        error={tableError}
        onRetry={props.onRetry}
        dense
        empty={
          <EmptyState
            compact
            title="暂无终端会话"
            description="新建会话会在 worker 上启动一个 shell；关闭页面不会终止会话。"
            action={
              props.onNew === undefined ? undefined : (
                <Button size="sm" onClick={props.onNew}>
                  新建会话
                </Button>
              )
            }
          />
        }
      />

      <p className="text-[11px] leading-relaxed text-app-muted">
        每个 worker 最多 20 个并行会话，空闲 30 分钟自动回收；这里的“终止”会真正结束远端 shell 进程。
        关闭标签页只会断开 WebSocket。
      </p>
    </div>
  );
}
