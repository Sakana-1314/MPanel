import { useEffect, useRef, useState } from 'react';
import { Check, Minus, Pencil, Plus, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { StatusDot } from '../../components/ui/StatusDot';
import type { StatusDotStatus } from '../../components/ui/StatusDot';

import type { TerminalSession } from '../../api/types';

/** WebSocket 桥接状态（与后端会话进程状态分开：WS 断开不杀会话）。 */
export type TerminalConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed' | 'error';

/** 页面内的一个终端标签（一个标签对应一个服务端会话）。 */
export interface TerminalTabState {
  /** 会话 id，同时作为标签唯一键。 */
  id: string;
  /** 展示名称，用户可重命名（仅本地）。 */
  title: string;
  session: TerminalSession | null;
  status: 'running' | 'exited';
  exitCode: number | null;
  /** null 表示尚未收到 ready 消息。 */
  pty: boolean | null;
  connection: TerminalConnectionState;
}

export const TERMINAL_CONNECTION_LABEL: Record<TerminalConnectionState, string> = {
  connecting: '连接中',
  open: '已连接',
  reconnecting: '重连中',
  closed: '已断开',
  error: '连接失败',
};

/** 取 shell 文件名（兼容 Windows 反斜杠路径）。 */
export function shellName(shell: string): string {
  const normalized = shell.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

/** 会话默认标签名：shell 名 + 会话短 id。 */
export function defaultTabTitle(session: TerminalSession): string {
  return `${shellName(session.shell)} · ${session.id.slice(0, 6)}`;
}

/** 把服务端会话转换成页面标签初始状态。 */
export function createTabState(session: TerminalSession): TerminalTabState {
  return {
    id: session.id,
    title: defaultTabTitle(session),
    session,
    status: session.status,
    exitCode: session.exitCode,
    pty: session.pty,
    connection: 'connecting',
  };
}

export interface TerminalTabsProps {
  sessions: readonly TerminalTabState[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew?: () => void;
  onRename?: (id: string, title: string) => void;
  onCloseOthers?: () => void;
  fontSize?: number;
  onFontSizeChange?: (size: number) => void;
}

const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 24;
const DEFAULT_FONT_SIZE = 13;

/** 多会话标签栏：切换、重命名、关闭、关闭其他、字号调节。 */
export function TerminalTabs(props: TerminalTabsProps): JSX.Element {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editingId === null) return;
    const input = inputRef.current;
    if (input === null) return;
    input.focus();
    input.select();
  }, [editingId]);

  const beginRename = (tab: TerminalTabState): void => {
    if (props.onRename === undefined) return;
    setEditingId(tab.id);
    setDraftTitle(tab.title);
  };

  const commitRename = (): void => {
    if (editingId === null) return;
    const title = draftTitle.trim();
    if (title.length > 0) props.onRename?.(editingId, title);
    setEditingId(null);
  };

  const cancelRename = (): void => {
    setEditingId(null);
  };

  const adjustFont = (delta: number): void => {
    const current = props.fontSize ?? DEFAULT_FONT_SIZE;
    const next = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, current + delta));
    props.onFontSizeChange?.(next);
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-1 border-b border-app-border bg-app-surface px-1.5 py-1">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {props.sessions.length === 0 ? (
          <span className="px-2 py-1 text-xs text-app-muted">暂无打开的终端标签</span>
        ) : (
          props.sessions.map((tab) => {
            const active = tab.id === props.activeId;
            const dot = tabDot(tab);
            return (
              <div
                key={tab.id}
                role="tab"
                aria-selected={active}
                tabIndex={0}
                onClick={() => props.onSelect(tab.id)}
                onDoubleClick={() => beginRename(tab)}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    props.onSelect(tab.id);
                  }
                }}
                title={`${tab.title}${tab.session?.cwd === undefined ? '' : ` · ${tab.session.cwd}`}`}
                className={cn(
                  'group flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors',
                  active
                    ? 'border-app-border bg-app-elevated text-app-text'
                    : 'border-transparent text-app-muted hover:bg-app-elevated/60 hover:text-app-text',
                )}
              >
                <StatusDot
                  status={dot.status}
                  pulse={dot.pulse}
                  label={dot.label}
                  className={tab.status === 'exited' ? 'opacity-50' : ''}
                />
                {editingId === tab.id ? (
                  <span className="flex w-40 items-center gap-1">
                    <Input
                      ref={inputRef}
                      value={draftTitle}
                      onChange={(event) => setDraftTitle(event.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          commitRename();
                        } else if (event.key === 'Escape') {
                          event.preventDefault();
                          cancelRename();
                        }
                      }}
                      onClick={(event) => event.stopPropagation()}
                      className="h-6 px-1.5 text-xs"
                      maxLength={64}
                      aria-label="标签名称"
                    />
                    <button
                      type="button"
                      aria-label="确认重命名"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={(event) => {
                        event.stopPropagation();
                        commitRename();
                      }}
                      className="rounded p-0.5 text-app-success hover:bg-app-bg"
                    >
                      <Check className="h-3 w-3" />
                    </button>
                  </span>
                ) : (
                  <span className="max-w-[12rem] truncate">{tab.title}</span>
                )}
                {tab.status === 'exited' ? (
                  <span className="rounded bg-app-border/60 px-1 text-[10px] text-app-muted">已退出</span>
                ) : null}
                {editingId === tab.id ? null : (
                  <span className={cn('flex items-center gap-0.5', active ? '' : 'opacity-0 group-hover:opacity-100')}>
                    <button
                      type="button"
                      aria-label={`重命名 ${tab.title}`}
                      title="重命名标签（也可双击标签）"
                      onClick={(event) => {
                        event.stopPropagation();
                        beginRename(tab);
                      }}
                      className="rounded p-0.5 text-app-muted hover:bg-app-bg hover:text-app-text"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      aria-label={`关闭 ${tab.title}`}
                      title="关闭标签（只断开 WS，不终止远端会话）"
                      onClick={(event) => {
                        event.stopPropagation();
                        props.onClose(tab.id);
                      }}
                      className="rounded p-0.5 text-app-muted hover:bg-app-bg hover:text-app-danger"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                )}
              </div>
            );
          })
        )}
        {props.onNew === undefined ? null : (
          <Button
            variant="ghost"
            size="xs"
            icon={<Plus className="h-3.5 w-3.5" />}
            onClick={props.onNew}
            className="ml-0.5"
          >
            新建
          </Button>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1 border-l border-app-border pl-1.5">
        <Button
          variant="ghost"
          size="icon"
          aria-label="减小字号"
          title="减小字号（Ctrl+Shift+-）"
          disabled={props.onFontSizeChange === undefined}
          onClick={() => adjustFont(-1)}
        >
          <Minus className="h-3.5 w-3.5" />
        </Button>
        <button
          type="button"
          title="重置为 13px（Ctrl+Shift+0）"
          onClick={() => props.onFontSizeChange?.(DEFAULT_FONT_SIZE)}
          className="min-w-[3rem] rounded px-1 py-0.5 text-[11px] tabular-nums text-app-muted hover:bg-app-elevated hover:text-app-text"
        >
          {props.fontSize ?? DEFAULT_FONT_SIZE}px
        </button>
        <Button
          variant="ghost"
          size="icon"
          aria-label="增大字号"
          title="增大字号（Ctrl+Shift++）"
          disabled={props.onFontSizeChange === undefined}
          onClick={() => adjustFont(1)}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
        {props.onCloseOthers === undefined || props.sessions.length <= 1 ? null : (
          <Button
            variant="ghost"
            size="xs"
            icon={<X className="h-3.5 w-3.5" />}
            onClick={props.onCloseOthers}
            title="关闭除当前标签外的其他标签（远端会话继续运行）"
          >
            关闭其他
          </Button>
        )}
      </div>
    </div>
  );
}

function tabDot(tab: TerminalTabState): {
  status: StatusDotStatus;
  pulse: boolean;
  label: string;
} {
  if (tab.status === 'exited') {
    return { status: 'unknown', pulse: false, label: '会话已退出' };
  }
  switch (tab.connection) {
    case 'open':
      return { status: 'success', pulse: false, label: '已连接' };
    case 'connecting':
      return { status: 'starting', pulse: true, label: '连接中' };
    case 'reconnecting':
      return { status: 'warning', pulse: true, label: '重连中' };
    case 'error':
      return { status: 'error', pulse: false, label: '连接失败' };
    case 'closed':
    default:
      return { status: 'offline', pulse: false, label: '已断开' };
  }
}
