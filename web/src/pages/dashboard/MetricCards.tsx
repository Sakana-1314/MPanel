import type { ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { Activity, Cpu, HardDrive, MemoryStick } from 'lucide-react';
import type { SystemMetrics } from '../../api/types';
import { describeError } from '../../api/errors';
import { formatBytes, formatPercent } from '../../lib/format';
import { cn } from '../../lib/cn';
import { Card, CardBody } from '../../components/ui/Card';
import { RelativeTime } from '../../components/ui/RelativeTime';
import type { StatusTone } from '../../components/ui/tones';
import { TONE_CLASS } from '../../components/ui/tones';
import { UsageBar, percentOf } from './UsageBar';

export interface MetricsSectionProps {
  query: UseQueryResult<SystemMetrics, Error>;
  /** worker 直连或 core 已选择机器。 */
  enabled: boolean;
}

interface MetricCardProps {
  label: string;
  icon: ReactNode;
  tone: StatusTone;
  value: ReactNode;
  hint?: ReactNode;
  bar?: ReactNode;
  loading?: boolean;
  error?: unknown;
  disabledHint?: string;
}

function MetricCard(props: MetricCardProps): JSX.Element {
  const errorInfo = props.error === undefined ? undefined : describeError(props.error);
  const unavailable = errorInfo !== undefined;

  return (
    <Card>
      <CardBody className="p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-app-muted">{props.label}</span>
          <span
            className={cn(
              'rounded-md p-1.5',
              TONE_CLASS[unavailable ? 'danger' : props.tone].softBg,
              TONE_CLASS[unavailable ? 'danger' : props.tone].text,
            )}
          >
            {props.icon}
          </span>
        </div>
        {props.loading === true ? (
          <div className="mt-2 flex flex-col gap-2">
            <span className="skeleton inline-block h-7 w-20" />
            <span className="skeleton inline-block h-2 w-full" />
          </div>
        ) : unavailable ? (
          <div className="mt-2 flex flex-col gap-1">
            <span className="text-xl font-semibold text-app-danger">不可用</span>
            <span className="text-[10px] font-medium text-app-danger">{errorInfo?.title}</span>
            <span className="break-words text-xs leading-relaxed text-app-muted">
              {errorInfo?.description}
            </span>
            <span className="break-words text-xs leading-relaxed text-app-text">
              {errorInfo?.hint}
            </span>
          </div>
        ) : props.disabledHint !== undefined ? (
          <div className="mt-2 flex flex-col gap-1">
            <span className="text-xl font-semibold text-app-muted">—</span>
            <span className="text-xs leading-relaxed text-app-muted">{props.disabledHint}</span>
          </div>
        ) : (
          <>
            <div className="mt-2 text-2xl font-semibold tabular-nums text-app-text">
              {props.value}
            </div>
            {props.bar === undefined ? null : <div className="mt-2">{props.bar}</div>}
            {props.hint === undefined ? null : (
              <p className="mt-1 text-xs leading-relaxed text-app-muted">{props.hint}</p>
            )}
          </>
        )}
      </CardBody>
    </Card>
  );
}

/** 概览页实时指标：CPU、内存、磁盘、负载；20 秒轮询由调用方控制。 */
export function MetricsSection(props: MetricsSectionProps): JSX.Element {
  const { query } = props;
  const data = query.data;
  const error = query.isError ? query.error : undefined;
  const loading = query.isLoading && data === undefined;
  const disabledHint = props.enabled
    ? undefined
    : 'core 连接需要先在下方机器卡片或侧边栏选择目标机器。';

  const memUsed =
    data === undefined ? 0 : Math.max(0, data.memTotalBytes - data.memFreeBytes);
  const memPercent = data === undefined ? null : percentOf(memUsed, data.memTotalBytes);

  const diskTotal = data?.diskTotalBytes ?? null;
  const diskFree = data?.diskFreeBytes ?? null;
  const diskUsed = diskTotal === null || diskFree === null ? null : Math.max(0, diskTotal - diskFree);
  const diskPercent =
    diskUsed === null || diskTotal === null ? null : percentOf(diskUsed, diskTotal);

  const loadavg = data?.loadavg ?? null;

  return (
    <section>
      <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-app-text">实时指标</h2>
          <p className="text-xs text-app-muted">
            来自 worker <code className="font-mono">GET /system/metrics</code>；20 秒刷新，窗口隐藏时暂停。
          </p>
        </div>
        {data === undefined ? null : (
          <span className="text-[11px] text-app-muted">
            采集于 <RelativeTime value={data.collectedAt} />
          </span>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="CPU 使用率"
          icon={<Cpu className="h-4 w-4" />}
          tone="accent"
          loading={loading}
          error={error}
          disabledHint={disabledHint}
          value={
            data === undefined || data.cpuPercent === null ? '—' : formatPercent(data.cpuPercent)
          }
          hint={
            data === undefined
              ? undefined
              : data.cpuPercent === null
                ? `${data.cpuCount} 核 · 采样失败，后端返回 null`
                : `${data.cpuCount} 核 · 整机 200ms 采样`
          }
        />
        <MetricCard
          label="内存"
          icon={<MemoryStick className="h-4 w-4" />}
          tone="info"
          loading={loading}
          error={error}
          disabledHint={disabledHint}
          value={memPercent === null ? '—' : formatPercent(memPercent)}
          bar={<UsageBar percent={memPercent} />}
          hint={
            data === undefined
              ? undefined
              : `已用 ${formatBytes(memUsed)} / 总量 ${formatBytes(data.memTotalBytes)}`
          }
        />
        <MetricCard
          label="磁盘"
          icon={<HardDrive className="h-4 w-4" />}
          tone="warning"
          loading={loading}
          error={error}
          disabledHint={disabledHint}
          value={
            data === undefined
              ? '—'
              : diskPercent === null
                ? '不适用'
                : formatPercent(diskPercent)
          }
          bar={diskPercent === null ? undefined : <UsageBar percent={diskPercent} />}
          hint={
            data === undefined
              ? undefined
              : diskPercent === null
                ? '无法读取 MPANEL_HOME 所在文件系统（后端返回 null）。'
                : `已用 ${formatBytes(diskUsed ?? 0)} / 总量 ${formatBytes(diskTotal ?? 0)}`
          }
        />
        <MetricCard
          label="负载（1 / 5 / 15 分钟）"
          icon={<Activity className="h-4 w-4" />}
          tone="success"
          loading={loading}
          error={error}
          disabledHint={disabledHint}
          value={
            data === undefined ? (
              '—'
            ) : loadavg === null ? (
              '不适用'
            ) : (
              <span className="flex items-baseline gap-2">
                {loadavg.map((value, index) => (
                  <span key={index} className="text-xl">
                    {value.toFixed(2)}
                    {index < loadavg.length - 1 ? (
                      <span className="mx-1 text-xs font-normal text-app-muted">/</span>
                    ) : null}
                  </span>
                ))}
              </span>
            )
          }
          hint={
            data === undefined
              ? undefined
              : loadavg === null
                ? '当前平台不提供 loadavg（Windows）。'
                : `${data.cpuCount} 核 · 数值越低越好`
          }
        />
      </div>
    </section>
  );
}
