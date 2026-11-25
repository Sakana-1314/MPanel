import { NavLink } from 'react-router-dom';
import {
  Boxes,
  Clock,
  Container,
  Database,
  Files,
  Globe,
  Layers,
  LayoutDashboard,
  Network,
  RefreshCw,
  Server,
  Settings,
  ShieldCheck,
  Terminal,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useConnectionStore, useActiveConnection, useSelectedMachineId } from '../../lib/connection-store';
import { useSession } from '../../lib/use-session';
import { useMachines } from '../../lib/use-machines';
import { getRuntimeConfig } from '../../lib/runtime-config';
import { cn } from '../../lib/cn';
import { ConnectionSwitcher } from './ConnectionSwitcher';
import { StatusDot } from '../ui/StatusDot';
import { Spinner } from '../ui/Spinner';
import { Button } from '../ui/Button';

export interface SidebarProps {
  mobileOpen?: boolean;
  onClose?(): void;
}

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  coreOnly?: boolean;
}

const NAV_GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: '总览',
    items: [
      { to: '/', label: '概览', icon: LayoutDashboard },
      { to: '/edge', label: '边缘节点', icon: Network, coreOnly: true },
    ],
  },
  {
    title: '主机',
    items: [{ to: '/machines', label: '机器', icon: Server, coreOnly: true }],
  },
  {
    title: '站点',
    items: [
      { to: '/sites', label: '站点', icon: Globe },
      { to: '/certs', label: '证书', icon: ShieldCheck },
    ],
  },
  {
    title: '数据',
    items: [{ to: '/databases', label: '数据库', icon: Database }],
  },
  {
    title: '容器',
    items: [
      { to: '/containers', label: '容器', icon: Container },
      { to: '/images', label: '镜像', icon: Boxes },
      { to: '/stacks', label: '编排', icon: Layers },
    ],
  },
  {
    title: '运维',
    items: [
      { to: '/files', label: '文件', icon: Files },
      { to: '/terminal', label: '终端', icon: Terminal },
      { to: '/tasks', label: '计划任务', icon: Clock },
    ],
  },
];

/** 侧边栏：连接切换器 +（core）机器列表 + 分组导航。 */
export function Sidebar(props: SidebarProps = {}): JSX.Element {
  const connection = useActiveConnection();
  const isCore = connection?.kind === 'core';
  const appName = getRuntimeConfig().appName ?? 'MPanel';
  const close = props.onClose ?? (() => undefined);

  return (
    <>
      {props.mobileOpen === true ? (
        <div
          className="fixed inset-0 z-30 bg-black/60 md:hidden"
          onClick={close}
          aria-hidden
        />
      ) : null}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-40 flex w-64 shrink-0 flex-col border-r border-app-border bg-app-surface transition-transform md:static md:z-0 md:translate-x-0',
          props.mobileOpen === true ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-3">
          <div className="flex items-center gap-2">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-app-accent text-sm font-bold text-white">
              M
            </span>
            <div className="leading-tight">
              <p className="text-sm font-semibold tracking-tight text-app-text">{appName}</p>
              <p className="text-[10px] text-app-muted">自托管服务器面板</p>
            </div>
          </div>
          <Button variant="ghost" size="icon" className="md:hidden" onClick={close} aria-label="关闭菜单">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="px-3 pb-2">
          <ConnectionSwitcher />
        </div>

        {isCore ? <CoreMachineList /> : null}

        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {NAV_GROUPS.map((group) => (
            <div key={group.title} className="mb-1">
              <p className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-app-muted/80">
                {group.title}
              </p>
              {group.items
                .filter((item) => item.coreOnly !== true || isCore)
                .map((item) => (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === '/'}
                    onClick={close}
                    className={({ isActive }) =>
                      cn(
                        'mb-0.5 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
                        isActive
                          ? 'bg-app-accent/12 text-app-accent'
                          : 'text-app-muted hover:bg-app-elevated hover:text-app-text',
                      )
                    }
                  >
                    <item.icon className="h-4 w-4 shrink-0" />
                    {item.label}
                  </NavLink>
                ))}
            </div>
          ))}
        </nav>

        <div className="border-t border-app-border p-2">
          <NavLink
            to="/settings"
            onClick={close}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
                isActive
                  ? 'bg-app-accent/12 text-app-accent'
                  : 'text-app-muted hover:bg-app-elevated hover:text-app-text',
              )
            }
          >
            <Settings className="h-4 w-4" />
            设置
          </NavLink>
        </div>
      </aside>
    </>
  );
}

/** core 连接下的机器列表：选中机器后所有特性 API 走 /machines/:id/proxy。 */
function CoreMachineList(): JSX.Element {
  const connection = useActiveConnection();
  const selected = useSelectedMachineId();
  const selectMachine = useConnectionStore((state) => state.selectMachine);
  const session = useSession();
  const machines = useMachines(session.status === 'authenticated');

  const items = machines.data?.items ?? [];

  return (
    <div className="mx-3 mb-2 rounded-lg border border-app-border bg-app-elevated/40">
      <div className="flex items-center justify-between px-2 py-1.5">
        <span className="flex items-center gap-1.5 text-[11px] font-medium text-app-muted">
          <Server className="h-3 w-3" />
          机器
          {machines.isFetching ? <Spinner size="xs" /> : null}
        </span>
        <button
          type="button"
          onClick={() => {
            void machines.refetch();
          }}
          className="rounded p-0.5 text-app-muted hover:bg-app-elevated hover:text-app-text"
          aria-label="刷新机器列表"
        >
          <RefreshCw className={cn('h-3 w-3', machines.isFetching ? 'animate-spin' : '')} />
        </button>
      </div>

      <div className="max-h-48 overflow-y-auto px-1 pb-1">
        {session.status !== 'authenticated' ? (
          <p className="px-1.5 py-1 text-[11px] text-app-muted">登录后加载机器列表</p>
        ) : machines.isError ? (
          <p className="px-1.5 py-1 text-[11px] text-app-danger">机器列表加载失败</p>
        ) : machines.isLoading ? (
          <p className="px-1.5 py-1 text-[11px] text-app-muted">加载中…</p>
        ) : items.length === 0 ? (
          <p className="px-1.5 py-1 text-[11px] text-app-muted">
            还没有机器。到“机器”页添加或注册 agent。
          </p>
        ) : (
          <>
            {items.map((machine) => {
              const active = machine.id === selected;
              return (
                <button
                  key={machine.id}
                  type="button"
                  onClick={() => {
                    if (connection === undefined) return;
                    selectMachine(connection.id, active ? undefined : machine.id);
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs transition-colors',
                    active
                      ? 'bg-app-accent/15 text-app-text'
                      : 'text-app-muted hover:bg-app-elevated hover:text-app-text',
                  )}
                >
                  <StatusDot
                    status={machine.status}
                    pulse={machine.status === 'online'}
                    label={machine.status}
                  />
                  <span className="min-w-0 flex-1 truncate">{machine.name}</span>
                  <span className="shrink-0 text-[10px] text-app-muted">{machine.transport}</span>
                </button>
              );
            })}
            {selected === undefined ? (
              <p className="px-1.5 pb-1 pt-1.5 text-[10px] leading-snug text-app-muted">
                尚未选择机器：站点、证书等功能页会提示先选择机器。
              </p>
            ) : (
              <button
                type="button"
                onClick={() => {
                  if (connection !== undefined) selectMachine(connection.id, undefined);
                }}
                className="mt-1 w-full rounded-md px-1.5 py-1 text-left text-[10px] text-app-muted hover:bg-app-elevated hover:text-app-text"
              >
                清除机器选择
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
