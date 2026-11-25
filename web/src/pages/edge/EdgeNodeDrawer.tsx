import type { ReactNode } from 'react';
import { Play, Server, Target } from 'lucide-react';
import type { CapabilityStatus, Machine } from '../../api/types';
import { formatBytes, formatDate, formatPercent, formatUptime } from '../../lib/format';
import { Alert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Drawer } from '../../components/ui/Drawer';
import { RelativeTime } from '../../components/ui/RelativeTime';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { UsageMeter, percentOf } from './UsageMeter';

const CAPABILITY_LABEL: Record<string, string> = {
  caddy: 'Caddy',
  docker: 'Docker',
  postgres: 'PostgreSQL',
  redis: 'Redis',
  pty: 'PTY',
};

export interface EdgeNodeDrawerProps {
  machine: Machine | null;
  selected: boolean;
  onClose: () => void;
  onCreateJob: (machineId: string) => void;
  onSelectMachine: (machine: Machine) => void;
}

function Row(props: { label: string; children: ReactNode }): JSX.Element {
  return (
    <>
      <dt className="text-xs text-app-muted">{props.label}</dt>
      <dd className="min-w-0 break-words text-sm text-app-text">{props.children}</dd>
    </>
  );
}

/** 边缘节点详情：机器元数据、能力与 core 维护的快照。 */
export function EdgeNodeDrawer(props: EdgeNodeDrawerProps): JSX.Element {
  const machine = props.machine;
  const snapshot = machine?.snapshot ?? null;
  const capabilities = machine?.capabilities ?? null;
  const memUsed = snapshot === null ? 0 : Math.max(0, snapshot.memTotalBytes - snapshot.memFreeBytes);
  const memPercent = snapshot === null ? null : percentOf(memUsed, snapshot.memTotalBytes);
  const diskPercent =
    snapshot === null ||
    snapshot.diskTotalBytes === null ||
    snapshot.diskFreeBytes === null
      ? null
      : percentOf(
          Math.max(0, snapshot.diskTotalBytes - snapshot.diskFreeBytes),
          snapshot.diskTotalBytes,
        );

  return (
    <Drawer
      open={machine !== null}
      onClose={props.onClose}
      title={machine === null ? '边缘节点' : machine.name}
      description={
        machine === null ? undefined : (
          <span className="font-mono text-[11px]">{machine.id}</span>
        )
      }
      size="lg"
      footer={
        machine === null ? undefined : (
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={<Target className="h-3.5 w-3.5" />}
              disabled={props.selected}
              title={props.selected ? '已经是当前机器' : '切换当前机器'}
              onClick={() => props.onSelectMachine(machine)}
            >
              {props.selected ? '当前机器' : '设为当前机器'}
            </Button>
            <Button
              size="sm"
              icon={<Play className="h-3.5 w-3.5" />}
              onClick={() => props.onCreateJob(machine.id)}
            >
              新建作业
            </Button>
            <Button variant="ghost" size="sm" onClick={props.onClose}>
              关闭
            </Button>
          </>
        )
      }
    >
      {machine === null ? null : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={machine.status} />
            <Badge tone="accent">reverse-ws</Badge>
            <Badge tone={machine.enabled ? 'success' : 'neutral'}>
              {machine.enabled ? '已启用' : '已禁用'}
            </Badge>
            {props.selected ? <Badge tone="accent">当前机器</Badge> : null}
          </div>

          {machine.lastError === null || machine.lastError.length === 0 ? null : (
            <Alert tone="danger" title="最近一次错误">
              {machine.lastError}
            </Alert>
          )}

          <section>
            <h3 className="mb-1.5 flex items-center gap-1 text-xs font-semibold text-app-text">
              <Server className="h-3.5 w-3.5" />
              机器
            </h3>
            <dl className="grid grid-cols-[6.5rem_1fr] gap-y-1.5">
              <Row label="状态">
                <StatusBadge status={machine.status} size="sm" />
              </Row>
              <Row label="分组">{machine.group ?? '未分组'}</Row>
              <Row label="入网密钥">
                <span className="font-mono text-xs">{machine.edgeKeyId ?? '—'}</span>
              </Row>
              <Row label="传输">{machine.transport}</Row>
              <Row label="端点">
                <span className="break-all font-mono text-xs">{machine.endpoint ?? '—'}</span>
              </Row>
              <Row label="最后在线">
                <RelativeTime value={machine.lastSeenAt} fallback="从未在线" />
              </Row>
              <Row label="创建时间">{formatDate(machine.createdAt)}</Row>
              <Row label="更新时间">{formatDate(machine.updatedAt)}</Row>
            </dl>
          </section>

          <section>
            <h3 className="mb-1.5 text-xs font-semibold text-app-text">能力</h3>
            {capabilities === null ? (
              <p className="text-xs text-app-muted">worker 尚未上报能力信息。</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {Object.entries(CAPABILITY_LABEL).map(([key, label]) => {
                  const status = (capabilities as unknown as Record<string, CapabilityStatus>)[key];
                  if (status === undefined) return null;
                  return (
                    <li key={key} className="flex items-start justify-between gap-3">
                      <span className="text-xs text-app-text">{label}</span>
                      <span className="flex max-w-[70%] flex-col items-end gap-0.5 text-right">
                        <Badge tone={status.available ? 'success' : 'neutral'}>
                          {status.available ? '可用' : '不可用'}
                        </Badge>
                        <span className="break-words text-[10px] text-app-muted">
                          {status.available ? (status.version ?? '—') : (status.reason ?? '—')}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section>
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold text-app-text">节点快照</h3>
              {snapshot === null ? null : (
                <span className="text-[10px] text-app-muted">
                  采集于 <RelativeTime value={snapshot.collectedAt} />
                </span>
              )}
            </div>
            {snapshot === null ? (
              <Alert tone="info" title="尚无快照">
                core 对 online 的边缘节点每 5 分钟请求 GET /system/snapshot；节点上线时会立即取一次。
                也可以在这里下发“快照”作业。
              </Alert>
            ) : (
              <dl className="grid grid-cols-[6.5rem_1fr] gap-y-1.5">
                <Row label="主机名">
                  <span className="font-mono text-xs">{snapshot.hostname}</span>
                </Row>
                <Row label="平台 / 架构">
                  {snapshot.platform}/{snapshot.arch} · {snapshot.release}
                </Row>
                <Row label="Node / worker">
                  <span className="font-mono text-xs">
                    {snapshot.nodeVersion} / v{snapshot.workerVersion}
                  </span>
                </Row>
                <Row label="运行时长">{formatUptime(snapshot.uptimeSec)}</Row>
                <Row label="CPU 核数">{snapshot.cpuCount}</Row>
                <Row label="负载 1/5/15">
                  {snapshot.loadavg === null
                    ? '不适用（Windows）'
                    : snapshot.loadavg.map((value) => value.toFixed(2)).join(' / ')}
                </Row>
                <Row label="内存">
                  <span className="flex flex-col gap-1">
                    <span>
                      {formatBytes(memUsed)} / {formatBytes(snapshot.memTotalBytes)}
                      <span className="ml-1 text-xs text-app-muted">
                        {memPercent === null ? '' : formatPercent(memPercent)}
                      </span>
                    </span>
                    <UsageMeter percent={memPercent} />
                  </span>
                </Row>
                <Row label="磁盘">
                  {diskPercent === null ? (
                    '不适用（后端返回 null）'
                  ) : (
                    <span className="flex flex-col gap-1">
                      <span>
                        {formatBytes(snapshot.diskTotalBytes ?? 0)} 总量 ·
                        可用 {formatBytes(snapshot.diskFreeBytes ?? 0)}
                        <span className="ml-1 text-xs text-app-muted">
                          {formatPercent(diskPercent)}
                        </span>
                      </span>
                      <UsageMeter percent={diskPercent} />
                    </span>
                  )}
                </Row>
                <Row label="IP">
                  <span className="font-mono text-xs">
                    {snapshot.ips.length === 0 ? '—' : snapshot.ips.join(', ')}
                  </span>
                </Row>
                <Row label="传输 / PTY">
                  <span className="font-mono text-xs">
                    {snapshot.transport} / {snapshot.pty ? 'true' : 'false'}
                  </span>
                </Row>
              </dl>
            )}
          </section>
        </div>
      )}
    </Drawer>
  );
}
