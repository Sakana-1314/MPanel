import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Server } from 'lucide-react';
import { useActiveConnection, useConnectionStore, useSelectedMachineId } from '../lib/connection-store';
import { useMachines } from '../lib/use-machines';
import { useSession } from '../lib/use-session';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { Spinner } from '../components/ui/Spinner';
import { StatusDot } from '../components/ui/StatusDot';
import { StatusBadge } from '../components/ui/StatusBadge';

const MACHINE_SCOPED_PREFIXES = [
  '/sites',
  '/certs',
  '/databases',
  '/containers',
  '/images',
  '/stacks',
  '/files',
  '/terminal',
  '/tasks',
];

export function requiresMachine(pathname: string): boolean {
  return MACHINE_SCOPED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * core 连接未选择机器时，特性页只显示“选择机器”，不向 /proxy 发请求。
 * 机器列表查询与侧边栏共用同一个 queryKey，不会重复请求。
 */
export function MachineGate(props: { children: ReactNode }): JSX.Element {
  const connection = useActiveConnection();
  const selected = useSelectedMachineId();
  const selectMachine = useConnectionStore((state) => state.selectMachine);
  const location = useLocation();
  const session = useSession();
  const machines = useMachines(session.status === 'authenticated');

  const needsMachine =
    connection !== undefined &&
    connection.kind === 'core' &&
    selected === undefined &&
    requiresMachine(location.pathname);

  if (!needsMachine) return <>{props.children}</>;

  const items = machines.data?.items ?? [];

  return (
    <div className="mx-auto max-w-2xl py-6">
      {machines.isLoading ? (
        <div className="flex min-h-[30vh] items-center justify-center">
          <Spinner size="lg" label="正在加载机器列表…" />
        </div>
      ) : machines.isError ? (
        <Alert
          tone="danger"
          title="机器列表加载失败"
          hint="请确认 core 在线、登录会话有效后重试。"
          action={
            <Button variant="secondary" size="sm" onClick={() => void machines.refetch()}>
              重试
            </Button>
          }
        >
          {machines.error.message}
        </Alert>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Server className="h-5 w-5" />}
          title="core 上还没有机器"
          description="站点、证书、容器等功能通过机器代理访问，请先在“机器”页添加 http/stdio/reverse-ws 机器。"
          action={
            <Link to="/machines">
              <Button size="sm">前往机器管理</Button>
            </Link>
          }
        />
      ) : (
        <div className="rounded-xl border border-app-border bg-app-surface p-4">
          <div className="flex items-start gap-2">
            <Server className="mt-0.5 h-4 w-4 text-app-accent" />
            <div>
              <h2 className="text-sm font-semibold text-app-text">请选择机器</h2>
              <p className="mt-0.5 text-xs text-app-muted">
                core 连接需要选定目标机器后才会发起 /api/v1/machines/:id/proxy 请求。
              </p>
            </div>
          </div>
          <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
            {items.map((machine) => (
              <li key={machine.id}>
                <button
                  type="button"
                  onClick={() => selectMachine(connection.id, machine.id)}
                  className="flex w-full items-center gap-2 rounded-lg border border-app-border bg-app-elevated/40 px-3 py-2 text-left transition-colors hover:border-app-accent/50 hover:bg-app-elevated"
                >
                  <StatusDot status={machine.status} pulse={machine.status === 'online'} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-app-text">{machine.name}</span>
                    <span className="block truncate text-[11px] text-app-muted">
                      {machine.transport} · {machine.endpoint ?? 'stdio'}
                    </span>
                  </span>
                  <StatusBadge status={machine.status} size="sm" />
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex justify-end">
            <Link to="/machines">
              <Button variant="ghost" size="sm">
                机器管理
              </Button>
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
