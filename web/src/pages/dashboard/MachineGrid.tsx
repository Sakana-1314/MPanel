import { Link } from 'react-router-dom';
import {
  Activity,
  HardDrive,
  MemoryStick,
  Server,
  SquareArrowOutUpRight,
} from 'lucide-react';
import type { Machine, SystemMetrics } from '../../api/types';
import { formatBytes, formatPercent } from '../../lib/format';
import { cn } from '../../lib/cn';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorState } from '../../components/ui/ErrorState';
import { RelativeTime } from '../../components/ui/RelativeTime';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { UsageBar, percentOf } from './UsageBar';

const CAPABILITY_ITEMS: { key: 'caddy' | 'docker' | 'postgres' | 'redis' | 'pty'; label: string }[] = [
  { key: 'caddy', label: 'Caddy' },
  { key: 'docker', label: 'Docker' },
  { key: 'postgres', label: 'PG' },
  { key: 'redis', label: 'Redis' },
  { key: 'pty', label: 'PTY' },
];

export interface MachineGridProps {
  machines: Machine[];
  loading: boolean;
  error: unknown;
  selectedMachineId?: string;
  /** 仅覆盖当前选中机器的实时指标（快照不含 CPU 百分比）。 */
  liveMetrics?: SystemMetrics;
  onSelect: (machine: Machine) => void;
  onRetry: () => void;
}

function versionOf(machine: Machine): string {
  return machine.worker?.version ?? machine.snapshot?.workerVersion ?? '—';
}

function platformOf(machine: Machine): string {
  const platform = machine.worker?.platform ?? machine.snapshot?.platform;
  const arch = machine.worker?.arch ?? machine.snapshot?.arch;
  if (platform === undefined || arch === undefined) return '—';
  return `${platform}/${arch}`;
}

function MachineCard(props: {
  machine: Machine;
  selected: boolean;
  liveMetrics?: SystemMetrics;
  onSelect: (machine: Machine) => void;
}): JSX.Element {
  const { machine } = props;
  const snapshot = machine.snapshot ?? null;
  const memUsed = snapshot === null ? 0 : Math.max(0, snapshot.memTotalBytes - snapshot.memFreeBytes);
  const memPercent = snapshot === null ? null : percentOf(memUsed, snapshot.memTotalBytes);
  let diskPercent: number | null = null;
  if (
    snapshot !== null &&
    snapshot.diskTotalBytes !== null &&
    snapshot.diskFreeBytes !== null
  ) {
    const diskUsed = Math.max(0, snapshot.diskTotalBytes - snapshot.diskFreeBytes);
    diskPercent = percentOf(diskUsed, snapshot.diskTotalBytes);
  }

  const liveCpu = props.selected ? props.liveMetrics?.cpuPercent ?? null : null;
  const load = snapshot?.loadavg ?? null;
  const capabilities = machine.capabilities ?? null;

  return (
    <button
      type="button"
      onClick={() => props.onSelect(machine)}
      aria-pressed={props.selected}
      title={props.selected ? '当前机器（点击保持选择）' : `切换当前机器到 ${machine.name}`}
      className={cn(
        'flex flex-col gap-2.5 rounded-xl border bg-app-surface p-4 text-left shadow-panel transition-colors',
        props.selected
          ? 'border-app-accent/70 ring-1 ring-app-accent/30'
          : 'border-app-border hover:border-app-accent/50 hover:bg-app-elevated/40',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-app-text">{machine.name}</p>
          <p className="truncate font-mono text-[10px] text-app-muted">{machine.id}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <StatusBadge status={machine.status} size="sm" />
          {props.selected ? (
            <Badge tone="accent" className="text-[10px]">
              当前机器
            </Badge>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-app-muted">
        <span>v{versionOf(machine)}</span>
        <span aria-hidden>·</span>
        <span>{platformOf(machine)}</span>
        <span aria-hidden>·</span>
        <span>{machine.transport}</span>
      </div>

      <div className="flex flex-wrap gap-1">
        {capabilities === null ? (
          <span className="text-[10px] text-app-muted">能力未上报</span>
        ) : (
          CAPABILITY_ITEMS.map((item) => {
            const status = capabilities[item.key];
            if (status === undefined) return null;
            return (
              <Badge
                key={item.key}
                tone={status.available ? 'success' : 'neutral'}
                className="text-[10px]"
                title={
                  status.available
                    ? `${item.label} 可用${status.version === undefined ? '' : ` · ${status.version}`}`
                    : `${item.label} 不可用${status.reason === undefined ? '' : `：${status.reason}`}`
                }
              >
                {item.label}
              </Badge>
            );
          })
        )}
      </div>

      <div className="text-[11px] text-app-muted">
        最后在线 <RelativeTime value={machine.lastSeenAt} />
      </div>

      {snapshot === null ? (
        <div className="rounded-lg border border-dashed border-app-border px-2.5 py-2 text-[11px] leading-relaxed text-app-muted">
          尚无快照。core 对 online 的边缘节点每 5 分钟采集一次；节点上线时会立即取一次。
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span className="flex min-w-0 items-center gap-1 text-app-muted">
              <Server className="h-3 w-3 shrink-0" />
              <span className="truncate" title={snapshot.hostname}>
                {snapshot.hostname}
              </span>
            </span>
            <span className="shrink-0 text-app-muted">
              快照 <RelativeTime value={snapshot.collectedAt} />
            </span>
          </div>

          <div className="flex items-center gap-2 text-[11px]">
            <span className="flex w-16 shrink-0 items-center gap-1 text-app-muted">
              <Activity className="h-3 w-3" />
              {liveCpu === null ? '负载 1m' : 'CPU'}
            </span>
            <span className="flex-1 truncate text-app-text">
              {liveCpu === null
                ? load === null
                  ? '—'
                  : `${load[0].toFixed(2)}（${snapshot.cpuCount} 核）`
                : formatPercent(liveCpu)}
            </span>
          </div>

          <div className="flex items-center gap-2 text-[11px]">
            <span className="flex w-16 shrink-0 items-center gap-1 text-app-muted">
              <MemoryStick className="h-3 w-3" />
              内存
            </span>
            <UsageBar percent={memPercent} size="sm" className="flex-1" />
            <span className="w-24 shrink-0 text-right text-app-muted">
              {memPercent === null ? '—' : formatPercent(memPercent)}
            </span>
          </div>

          <div className="flex items-center gap-2 text-[11px]">
            <span className="flex w-16 shrink-0 items-center gap-1 text-app-muted">
              <HardDrive className="h-3 w-3" />
              磁盘
            </span>
            {diskPercent === null ? (
              <span className="flex-1 text-app-muted">不适用</span>
            ) : (
              <UsageBar percent={diskPercent} size="sm" className="flex-1" />
            )}
            <span className="w-24 shrink-0 text-right text-app-muted">
              {diskPercent === null ? '—' : formatPercent(diskPercent)}
            </span>
          </div>

          <p className="text-[10px] leading-snug text-app-muted">
            {liveCpu === null
              ? '节点快照只提供 loadavg，不含 CPU 百分比。'
              : `CPU 来自实时指标；内存 ${formatBytes(memUsed)} / ${formatBytes(snapshot.memTotalBytes)}`}
          </p>
        </div>
      )}
    </button>
  );
}

/** core 连接的机器卡片网格：点击卡片切换当前机器（所有特性请求改走该机器代理）。 */
export function MachineGrid(props: MachineGridProps): JSX.Element {
  return (
    <section id="overview-machines">
      <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-app-text">机器</h2>
          <p className="text-xs text-app-muted">
            点击卡片切换当前机器；站点、证书、容器等请求会改为代理到该机器。
          </p>
        </div>
        <Link
          to="/machines"
          className="inline-flex items-center gap-1 text-xs text-app-muted transition-colors hover:text-app-accent"
        >
          机器管理
          <SquareArrowOutUpRight className="h-3 w-3" />
        </Link>
      </div>

      {props.error !== undefined && props.error !== null ? (
        <ErrorState error={props.error} onRetry={props.onRetry} />
      ) : props.loading && props.machines.length === 0 ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }, (_, index) => (
            <div
              key={index}
              className="h-56 rounded-xl border border-app-border bg-app-surface p-4"
              aria-hidden
            >
              <div className="skeleton h-4 w-1/2" />
              <div className="mt-3 skeleton h-3 w-3/4" />
              <div className="mt-6 skeleton h-2.5 w-full" />
              <div className="mt-2 skeleton h-2.5 w-5/6" />
            </div>
          ))}
        </div>
      ) : props.machines.length === 0 ? (
        <EmptyState
          title="core 上还没有机器"
          description="添加 http/stdio/reverse-ws 机器，或使用下方边缘节点的入网密钥让 worker 自助接入。"
          icon={<Server className="h-5 w-5" />}
          action={
            <Link to="/machines">
              <Button size="sm" variant="secondary">
                前往机器管理
              </Button>
            </Link>
          }
        />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {props.machines.map((machine) => (
            <MachineCard
              key={machine.id}
              machine={machine}
              selected={machine.id === props.selectedMachineId}
              liveMetrics={
                machine.id === props.selectedMachineId ? props.liveMetrics : undefined
              }
              onSelect={props.onSelect}
            />
          ))}
        </div>
      )}
    </section>
  );
}
