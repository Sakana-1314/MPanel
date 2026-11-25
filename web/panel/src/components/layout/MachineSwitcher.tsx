import { ChevronDown, Server } from 'lucide-react';
import { useActiveConnection, useConnectionStore, useSelectedMachineId } from '../../lib/connection-store';
import { useMachines } from '../../lib/use-machines';
import { useSession } from '../../lib/use-session';
import { cn } from '../../lib/cn';
import { StatusDot } from '../ui/StatusDot';
import { StatusBadge } from '../ui/StatusBadge';

/**
 * 顶栏当前机器：core 显示机器下拉（选择后所有特性 API 走 /proxy）；
 * worker 显示“直连”说明。
 */
export function MachineSwitcher(): JSX.Element | null {
  const connection = useActiveConnection();
  const selected = useSelectedMachineId();
  const selectMachine = useConnectionStore((state) => state.selectMachine);
  const session = useSession();
  const machines = useMachines(session.status === 'authenticated');

  if (connection === undefined) return null;
  if (connection.kind !== 'core') {
    return (
      <div className="flex items-center gap-2 text-xs text-app-muted">
        <Server className="h-3.5 w-3.5" />
        直连 agent
        <StatusBadge status="online" label="不代理" tone="info" size="sm" dot={false} />
      </div>
    );
  }

  const items = machines.data?.items ?? [];
  const current = items.find((machine) => machine.id === selected);

  return (
    <label className="flex items-center gap-1.5 text-xs text-app-muted">
      <Server className="h-3.5 w-3.5" />
      <span className="hidden sm:inline">机器</span>
      <span className="relative flex items-center">
        <select
          value={selected ?? ''}
          onChange={(event) => {
            const value = event.target.value;
            selectMachine(connection.id, value.length === 0 ? undefined : value);
          }}
          className={cn(
            'h-7 appearance-none rounded-md border border-app-border bg-app-surface pl-2 pr-7 text-xs text-app-text',
            'focus:border-app-accent focus:outline-none focus:ring-1 focus:ring-app-accent',
          )}
          aria-label="选择机器"
        >
          <option value="">
            {machines.isLoading ? '加载机器…' : items.length === 0 ? '无机器' : '选择机器'}
          </option>
          {items.map((machine) => (
            <option key={machine.id} value={machine.id}>
              {machine.name}（{machine.status}）
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-1.5 h-3.5 w-3.5 text-app-muted" />
      </span>
      {current === undefined ? null : (
        <span className="flex items-center gap-1">
          <StatusDot status={current.status} pulse={current.status === 'online'} />
          <span className="hidden lg:inline">{current.name}</span>
        </span>
      )}
    </label>
  );
}
