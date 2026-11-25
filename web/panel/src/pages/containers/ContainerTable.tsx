import type { ReactNode } from 'react';
import { Play, RotateCw, ScrollText, Square, Trash2 } from 'lucide-react';
import type { ContainerStats, ContainerSummary } from '../../api/types';
import type { ContainerAction } from '../../api/containers';
import { formatBytes, formatDate, formatPercent } from '../../lib/format';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { RelativeTime } from '../../components/ui/RelativeTime';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { Tooltip } from '../../components/ui/Tooltip';
import { Sparkline } from './Sparkline';
import { containerName, containerShortId, containerStateLabel, formatPort } from './container-utils';
import { seriesValues, type StatsPoint } from './useContainerStats';

export interface ContainerTableProps {
  items: readonly ContainerSummary[];
  loading: boolean;
  onOpen: (id: string) => void;
  onAction: (id: string, action: ContainerAction) => void;
  onRemove?: (id: string) => void;
  onOpenLogs?: (id: string) => void;
  selectedIds?: ReadonlySet<string>;
  onToggleSelect?: (id: string, checked: boolean) => void;
  onToggleAll?: (checked: boolean) => void;
  statsById?: ReadonlyMap<string, ContainerStats>;
  historyById?: ReadonlyMap<string, readonly StatsPoint[]>;
  actionBusy?: { id: string; action: ContainerAction } | null;
  actionsDisabled?: boolean;
  footer?: ReactNode;
  empty?: ReactNode;
}

/** 容器列表：名称、镜像、状态、端口、CPU/内存与行内最近 30 个采样点趋势。 */
export function ContainerTable(props: ContainerTableProps): JSX.Element {
  const selected = props.selectedIds ?? new Set<string>();
  const selectable = props.onToggleSelect !== undefined;
  const allSelected =
    selectable && props.items.length > 0 && props.items.every((item) => selected.has(item.id));

  const columns: Column<ContainerSummary>[] = [];

  if (selectable) {
    columns.push({
      key: 'select',
      width: 36,
      header: (
        <Checkbox
          aria-label="全选当前列表"
          checked={allSelected}
          onChange={(event) => props.onToggleAll?.(event.target.checked)}
          onClick={(event) => event.stopPropagation()}
        />
      ),
      render: (container) => (
        <Checkbox
          aria-label={`选择容器 ${containerName(container)}`}
          checked={selected.has(container.id)}
          onChange={(event) => props.onToggleSelect?.(container.id, event.target.checked)}
          onClick={(event) => event.stopPropagation()}
        />
      ),
    });
  }

  columns.push(
    {
      key: 'name',
      header: '名称',
      sortable: true,
      sortValue: (container) => containerName(container),
      render: (container) => {
        const compose = container.composeProject;
        return (
          <div className="min-w-0">
            <p
              className="max-w-[16rem] truncate font-medium text-app-text"
              title={containerName(container)}
            >
              {containerName(container)}
            </p>
            <div className="flex flex-wrap items-center gap-1">
              <span className="font-mono text-[10px] text-app-muted" title={container.id}>
                {containerShortId(container.id)}
              </span>
              {compose !== undefined && compose !== null && compose.length > 0 ? (
                <Badge tone="info" title={`compose 项目：${compose}`}>
                  {compose}
                </Badge>
              ) : null}
              {container.composeService !== undefined && container.composeService !== null ? (
                <span className="text-[10px] text-app-muted">/ {container.composeService}</span>
              ) : null}
            </div>
          </div>
        );
      },
    },
    {
      key: 'image',
      header: '镜像',
      sortable: true,
      sortValue: (container) => container.image,
      render: (container) => (
        <span
          className="block max-w-[18rem] truncate font-mono text-[11px] text-app-muted"
          title={container.image}
        >
          {container.image}
        </span>
      ),
    },
    {
      key: 'state',
      header: '状态',
      sortable: true,
      sortValue: (container) => container.state,
      render: (container) => (
        <div className="flex flex-col gap-0.5">
          <StatusBadge
            status={container.state}
            label={containerStateLabel(container.state)}
            size="sm"
            title={container.status}
          />
          <span
            className="max-w-[12rem] truncate text-[10px] text-app-muted"
            title={container.status}
          >
            {container.status}
          </span>
        </div>
      ),
    },
    {
      key: 'ports',
      header: '端口',
      render: (container) => {
        if (container.ports.length === 0) return <span className="text-app-muted">—</span>;
        const shown = container.ports.slice(0, 2);
        const rest = container.ports.length - shown.length;
        return (
          <div className="flex flex-col gap-0.5 font-mono text-[10.5px] text-app-muted">
            {shown.map((port, index) => (
              <span key={`${port.privatePort}-${port.type}-${index}`}>{formatPort(port)}</span>
            ))}
            {rest > 0 ? (
              <span
                title={container.ports.map(formatPort).join('\n')}
                className="text-app-muted/80"
              >
                +{rest} 个端口
              </span>
            ) : null}
          </div>
        );
      },
    },
    {
      key: 'cpu',
      header: 'CPU',
      align: 'right',
      sortable: true,
      sortValue: (container) => props.statsById?.get(container.id)?.cpuPercent ?? null,
      render: (container) => {
        const stats = props.statsById?.get(container.id);
        if (stats === undefined) {
          return <span className="text-xs text-app-muted">—</span>;
        }
        const history = props.historyById?.get(container.id);
        return (
          <div className="flex items-center justify-end gap-2">
            <span className="tabular-nums text-xs text-app-text">
              {formatPercent(stats.cpuPercent)}
            </span>
            <Sparkline
              values={seriesValues(history, (point) => point.cpuPercent)}
              title={`CPU 最近 ${history?.length ?? 0} 次采样`}
            />
          </div>
        );
      },
    },
    {
      key: 'memory',
      header: '内存',
      align: 'right',
      sortable: true,
      sortValue: (container) => props.statsById?.get(container.id)?.memoryPercent ?? null,
      render: (container) => {
        const stats = props.statsById?.get(container.id);
        if (stats === undefined) {
          return <span className="text-xs text-app-muted">—</span>;
        }
        const history = props.historyById?.get(container.id);
        return (
          <div className="flex items-center justify-end gap-2">
            <div className="flex flex-col items-end leading-tight">
              <span className="tabular-nums text-xs text-app-text">
                {formatPercent(stats.memoryPercent)}
              </span>
              <span className="text-[10px] tabular-nums text-app-muted">
                {formatBytes(stats.memoryUsageBytes)} / {formatBytes(stats.memoryLimitBytes)}
              </span>
            </div>
            <Sparkline
              values={seriesValues(history, (point) => point.memoryPercent)}
              max={100}
              tone="success"
              title={`内存最近 ${history?.length ?? 0} 次采样`}
            />
          </div>
        );
      },
    },
    {
      key: 'created',
      header: '创建时间',
      sortable: true,
      sortValue: (container) => container.created,
      render: (container) => (
        <span
          className="whitespace-nowrap text-xs text-app-muted"
          title={formatDate(container.created)}
        >
          <RelativeTime value={container.created} />
        </span>
      ),
    },
    {
      key: 'actions',
      header: '操作',
      align: 'right',
      width: 168,
      render: (container) => {
        const busy = props.actionBusy?.id === container.id ? props.actionBusy.action : null;
        const disabled = props.actionsDisabled === true;
        const running = container.state === 'running';
        return (
          <div
            className="flex items-center justify-end gap-0.5"
            onClick={(event) => event.stopPropagation()}
          >
            <Tooltip content="启动">
              <Button
                aria-label="启动"
                variant="ghost"
                size="icon"
                disabled={disabled || running || container.state === 'paused'}
                loading={busy === 'start'}
                onClick={() => props.onAction(container.id, 'start')}
                icon={<Play className="h-3.5 w-3.5" />}
              />
            </Tooltip>
            <Tooltip content="停止">
              <Button
                aria-label="停止"
                variant="ghost"
                size="icon"
                disabled={disabled || (!running && container.state !== 'paused')}
                loading={busy === 'stop'}
                onClick={() => props.onAction(container.id, 'stop')}
                icon={<Square className="h-3.5 w-3.5" />}
              />
            </Tooltip>
            <Tooltip content="重启">
              <Button
                aria-label="重启"
                variant="ghost"
                size="icon"
                disabled={disabled || container.state === 'removing' || container.state === 'dead'}
                loading={busy === 'restart'}
                onClick={() => props.onAction(container.id, 'restart')}
                icon={<RotateCw className="h-3.5 w-3.5" />}
              />
            </Tooltip>
            {props.onOpenLogs === undefined ? null : (
              <Tooltip content="实时日志">
                <Button
                  aria-label="实时日志"
                  variant="ghost"
                  size="icon"
                  disabled={disabled}
                  onClick={() => props.onOpenLogs?.(container.id)}
                  icon={<ScrollText className="h-3.5 w-3.5" />}
                />
              </Tooltip>
            )}
            {props.onRemove === undefined ? null : (
              <Tooltip content="删除">
                <Button
                  aria-label="删除"
                  variant="ghost"
                  size="icon"
                  disabled={disabled}
                  onClick={() => props.onRemove?.(container.id)}
                  icon={<Trash2 className="h-3.5 w-3.5 text-app-danger" />}
                />
              </Tooltip>
            )}
          </div>
        );
      },
    },
  );

  return (
    <DataTable
      columns={columns}
      rows={props.items}
      rowKey={(container) => container.id}
      loading={props.loading}
      onRowClick={(container) => props.onOpen(container.id)}
      rowClassName={(container) =>
        selected.has(container.id) ? 'bg-app-accent/5' : undefined
      }
      empty={
        props.empty ?? (
          <div className="flex flex-col items-center gap-1">
            <span className="text-sm text-app-text">暂无容器</span>
            <span className="text-xs text-app-muted">
              可调整状态筛选，或确认 Docker 中已有容器。
            </span>
          </div>
        )
      }
      footer={props.footer}
      dense
    />
  );
}
