import { useMemo } from 'react';
import type { ReactNode } from 'react';
import type { ContainerStats } from '../../api/types';
import { describeError } from '../../api/errors';
import { formatBytes, formatPercent } from '../../lib/format';
import { Alert } from '../../components/ui/Alert';
import { EmptyState } from '../../components/ui/EmptyState';
import { LoadingSkeleton } from '../../components/ui/ErrorState';
import { RelativeTime } from '../../components/ui/RelativeTime';
import { Sparkline } from './Sparkline';
import {
  seriesValues,
  STATS_HISTORY_LIMIT,
  useContainerStats,
  type StatsPoint,
} from './useContainerStats';

export interface ContainerStatsPanelProps {
  id: string;
}

/** 单容器资源统计：每 5 秒轮询，保留最近 30 个采样点用于趋势。 */
export function ContainerStatsPanel(props: ContainerStatsPanelProps): JSX.Element {
  const ids = useMemo(() => [props.id], [props.id]);
  const { statsById, historyById, errorById, loading } = useContainerStats(ids);
  const stats = statsById.get(props.id);
  const history = historyById.get(props.id);
  const error = errorById.get(props.id);

  if (stats === undefined && loading) {
    return <LoadingSkeleton rows={4} />;
  }

  if (stats === undefined && error !== undefined) {
    return (
      <Alert
        tone="warning"
        title="暂无资源统计"
        hint="容器未运行时 Docker 不提供 stats；请启动容器后再查看。"
      >
        {describeError(error).description}
      </Alert>
    );
  }

  if (stats === undefined) {
    return (
      <EmptyState
        compact
        title="等待首个采样"
        description="资源统计每 5 秒刷新一次，采样完成后会显示 CPU、内存、网络与块 I/O。"
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {error === undefined ? null : (
        <Alert
          tone="warning"
          title="最近一次统计刷新失败"
          hint="图表显示最后一次成功采样；请确认容器仍在运行且 Docker 可达。"
        >
          {describeError(error).description}
        </Alert>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Metric
          label="CPU 使用率"
          value={formatPercent(stats.cpuPercent)}
          hint={`最近 ${history?.length ?? 0} 次采样`}
          chart={
            <Sparkline
              values={seriesValues(history, (point) => point.cpuPercent)}
              width={140}
              height={30}
              title="CPU 使用率趋势"
            />
          }
        />
        <Metric
          label="内存使用"
          value={formatBytes(stats.memoryUsageBytes)}
          hint={`${formatPercent(stats.memoryPercent)} / 上限 ${formatBytes(stats.memoryLimitBytes)}`}
          tone="text-app-success"
          chart={
            <Sparkline
              values={seriesValues(history, (point) => point.memoryPercent)}
              max={100}
              width={140}
              height={30}
              tone="success"
              title="内存使用率趋势"
            />
          }
        />
        <Metric
          label="网络接收 / 发送"
          value={formatBytes(stats.networkRxBytes)}
          hint={`发送 ${formatBytes(stats.networkTxBytes)}`}
        />
        <Metric
          label="块设备读取 / 写入"
          value={formatBytes(stats.blockReadBytes)}
          hint={`写入 ${formatBytes(stats.blockWriteBytes)}`}
        />
        <Metric label="进程数（PIDs）" value={stats.pids} hint="容器内当前进程数量" />
        <Metric
          label="最近采样时间"
          value={<RelativeTime value={stats.readAt} />}
          hint={`每 5 秒刷新；趋势最多保留 ${STATS_HISTORY_LIMIT} 个采样点`}
        />
      </div>

      {history !== undefined && history.length > 0 ? (
        <HistorySummary history={history} stats={stats} />
      ) : null}
    </div>
  );
}

function Metric(props: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  chart?: ReactNode;
  tone?: string;
}): JSX.Element {
  return (
    <div className="rounded-lg border border-app-border bg-app-elevated/40 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-app-muted">{props.label}</p>
          <p className={`mt-1 break-words text-lg font-semibold tabular-nums ${props.tone ?? 'text-app-text'}`}>
            {props.value}
          </p>
          {props.hint === undefined ? null : (
            <p className="mt-0.5 break-words text-[10px] text-app-muted">{props.hint}</p>
          )}
        </div>
        {props.chart === undefined ? null : <div className="shrink-0 pt-1">{props.chart}</div>}
      </div>
    </div>
  );
}

function HistorySummary(props: {
  history: readonly StatsPoint[];
  stats: ContainerStats;
}): JSX.Element {
  const cpuValues = props.history.map((point) => point.cpuPercent);
  const memoryValues = props.history.map((point) => point.memoryPercent);
  const first = props.history[0];
  const last = props.history[props.history.length - 1];
  const cpuDelta = first === undefined || last === undefined ? 0 : last.cpuPercent - first.cpuPercent;
  const memoryDelta =
    first === undefined || last === undefined ? 0 : last.memoryPercent - first.memoryPercent;
  return (
    <div className="rounded-lg border border-app-border bg-app-surface p-3">
      <p className="mb-2 text-[11px] font-medium text-app-muted">
        最近 {props.history.length} 个采样点（内存内维护）
      </p>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <div className="mb-1 flex items-center justify-between text-[10px] text-app-muted">
            <span>CPU 峰值 {formatPercent(Math.max(...cpuValues))}</span>
            <span className={cpuDelta > 0 ? 'text-app-danger' : 'text-app-success'}>
              {cpuDelta >= 0 ? '+' : ''}
              {cpuDelta.toFixed(2)}%
            </span>
          </div>
          <Sparkline
            values={cpuValues}
            width={260}
            height={44}
            className="w-full"
            title="CPU 趋势"
          />
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between text-[10px] text-app-muted">
            <span>内存峰值 {formatPercent(Math.max(...memoryValues))}</span>
            <span className={memoryDelta > 0 ? 'text-app-danger' : 'text-app-success'}>
              {memoryDelta >= 0 ? '+' : ''}
              {memoryDelta.toFixed(2)}%
            </span>
          </div>
          <Sparkline
            values={memoryValues}
            max={100}
            tone="success"
            width={260}
            height={44}
            className="w-full"
            title="内存趋势"
          />
        </div>
      </div>
      <p className="mt-2 text-[10px] text-app-muted">
        采样时间：<RelativeTime value={props.stats.readAt} />；数据不持久化，关闭页面即清空。
      </p>
    </div>
  );
}
