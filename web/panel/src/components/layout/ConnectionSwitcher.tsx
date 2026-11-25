import { useState } from 'react';
import { Check, ChevronDown, Plus, Server, Settings2 } from 'lucide-react';
import { useConnectionStore } from '../../lib/connection-store';
import { cn } from '../../lib/cn';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { ConnectionManager } from '../ConnectionManager';
import { ConnectionDialog } from '../ConnectionDialog';
import { Spinner } from '../ui/Spinner';

/** 侧边栏顶部的连接切换器；点击展开连接列表，底部进入连接管理。 */
export function ConnectionSwitcher(): JSX.Element {
  const connections = useConnectionStore((state) => state.connections);
  const activeId = useConnectionStore((state) => state.activeId);
  const setActive = useConnectionStore((state) => state.setActive);

  const [open, setOpen] = useState(false);
  const [managerOpen, setManagerOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  const active = connections.find((connection) => connection.id === activeId);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label="切换后端连接"
        className="flex w-full items-center gap-2 rounded-lg border border-app-border bg-app-elevated/70 px-2.5 py-2 text-left transition-colors hover:bg-app-elevated"
      >
        <span className="rounded-md bg-app-accent/15 p-1.5 text-app-accent">
          <Server className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-app-text">
            {active?.name ?? (connections.length === 0 ? '未连接' : '选择连接')}
          </span>
          <span className="block truncate text-[11px] text-app-muted">
            {active === undefined ? '新增或选择一个后端' : `${active.kind} · ${active.baseUrl}`}
          </span>
        </span>
        <ChevronDown
          className={cn('h-4 w-4 shrink-0 text-app-muted transition-transform', open ? 'rotate-180' : '')}
        />
      </button>

      {open ? (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden />
          <div className="absolute left-0 right-0 z-40 mt-1 overflow-hidden rounded-lg border border-app-border bg-app-surface shadow-pop animate-scale-in">
            <div className="max-h-72 overflow-auto p-1">
              {connections.length === 0 ? (
                <p className="px-2 py-3 text-xs text-app-muted">还没有连接。</p>
              ) : (
                connections.map((connection) => {
                  const selected = connection.id === activeId;
                  return (
                    <button
                      key={connection.id}
                      type="button"
                      onClick={() => {
                        setActive(connection.id);
                        setOpen(false);
                      }}
                      className={cn(
                        'flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                        selected ? 'bg-app-accent/10' : 'hover:bg-app-elevated',
                      )}
                    >
                      <span className="mt-0.5 w-4 shrink-0">
                        {selected ? <Check className="h-3.5 w-3.5 text-app-accent" /> : null}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium text-app-text">
                          {connection.name}
                        </span>
                        <span className="block truncate text-[10px] text-app-muted">
                          {connection.baseUrl}
                        </span>
                      </span>
                      <Badge tone={connection.kind === 'core' ? 'accent' : 'info'}>
                        {connection.kind}
                      </Badge>
                    </button>
                  );
                })
              )}
            </div>
            <div className="flex items-center justify-between gap-1 border-t border-app-border p-1.5">
              <Button
                variant="ghost"
                size="sm"
                icon={<Settings2 className="h-3.5 w-3.5" />}
                onClick={() => {
                  setOpen(false);
                  setManagerOpen(true);
                }}
              >
                管理连接
              </Button>
              <Button
                variant="secondary"
                size="sm"
                icon={<Plus className="h-3.5 w-3.5" />}
                onClick={() => {
                  setOpen(false);
                  setDialogOpen(true);
                }}
              >
                新增
              </Button>
            </div>
          </div>
        </>
      ) : null}

      <ConnectionManager open={managerOpen} onClose={() => setManagerOpen(false)} />
      <ConnectionDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </div>
  );
}

/** 顶栏用的连接状态小徽标。 */
export function ConnectionKindBadge(props: { kind: 'worker' | 'core' }): JSX.Element {
  return (
    <Badge tone={props.kind === 'core' ? 'accent' : 'info'} dot>
      {props.kind}
    </Badge>
  );
}

/** 空态占位，避免图标组件被摇树误删。 */
export function ConnectionSwitcherLoading(): JSX.Element {
  return <Spinner size="sm" label="连接中…" />;
}
