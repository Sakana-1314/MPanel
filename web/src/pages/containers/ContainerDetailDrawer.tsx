import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RotateCw, Terminal } from 'lucide-react';
import type { ContainerDetail } from '../../api/types';
import { containersKeys, getContainer } from '../../api/containers';
import { isAppError } from '../../api/errors';
import { formatDate } from '../../lib/format';
import { Alert, UnavailableAlert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Drawer } from '../../components/ui/Drawer';
import { ErrorState, LoadingSkeleton } from '../../components/ui/ErrorState';
import { RelativeTime } from '../../components/ui/RelativeTime';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { Tabs } from '../../components/ui/Tabs';
import { ContainerLogsPanel } from './ContainerLogsPanel';
import { ContainerStatsPanel } from './ContainerStatsPanel';
import { ContainerExecDialog } from './ContainerExecDialog';
import { containerName, containerShortId, containerStateLabel } from './container-utils';

export type ContainerDetailTab = 'overview' | 'logs' | 'stats';

export interface ContainerDetailDrawerProps {
  id: string;
  onClose: () => void;
  initialTab?: ContainerDetailTab;
  /** 外部页面的“重启容器”动作；不传则隐藏该按钮。 */
  onRestart?: () => void;
  restarting?: boolean;
}

const TABS = [
  { id: 'overview', label: '概览' },
  { id: 'logs', label: '实时日志' },
  { id: 'stats', label: '资源统计' },
] as const;

/** 容器详情抽屉：inspect 摘要、环境变量、挂载、网络 + 日志/统计标签页。 */
export function ContainerDetailDrawer(props: ContainerDetailDrawerProps): JSX.Element {
  const [tab, setTab] = useState<ContainerDetailTab>(props.initialTab ?? 'overview');
  const [execOpen, setExecOpen] = useState(false);

  useEffect(() => {
    setTab(props.initialTab ?? 'overview');
  }, [props.id, props.initialTab]);

  const detailQuery = useQuery({
    queryKey: containersKeys.detail(props.id),
    queryFn: () => getContainer(props.id),
    retry: 1,
    refetchInterval: 15_000,
  });

  const detail = detailQuery.data;
  const title = detail === undefined ? '容器详情' : containerName(detail);
  const description =
    detail === undefined
      ? props.id
      : `${detail.image} · ${containerShortId(detail.id)}`;

  return (
    <>
      <Drawer
        open
        onClose={props.onClose}
        title={title}
        description={description}
        size="xl"
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={props.onClose}>
              关闭
            </Button>
            {props.onRestart === undefined ? null : (
              <Button
                variant="secondary"
                size="sm"
                icon={<RotateCw className="h-4 w-4" />}
                loading={props.restarting}
                onClick={props.onRestart}
              >
                重启容器
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              icon={<Terminal className="h-4 w-4" />}
              disabled={detail === undefined || detail.state !== 'running'}
              onClick={() => setExecOpen(true)}
            >
              执行命令
            </Button>
          </>
        }
      >
        {detailQuery.isLoading ? (
          <LoadingSkeleton rows={6} />
        ) : isAppError(detailQuery.error, 'UNAVAILABLE') ? (
          <UnavailableAlert
            error={detailQuery.error}
            title="Docker 不可用"
            hint="请确认目标机器的 Docker daemon 正在运行，然后重试。"
          />
        ) : detailQuery.error !== null && detailQuery.error !== undefined ? (
          <ErrorState
            error={detailQuery.error}
            onRetry={() => {
              void detailQuery.refetch();
            }}
          />
        ) : detail === undefined ? (
          <ErrorState error={new Error('容器不存在或已被删除')} title="未找到容器" />
        ) : (
          <div className="flex flex-col gap-4">
            <Tabs
              tabs={TABS.map((item) => ({ id: item.id, label: item.label }))}
              active={tab}
              onChange={(next) => setTab(next as ContainerDetailTab)}
            />
            {tab === 'overview' ? <Overview detail={detail} /> : null}
            {tab === 'logs' ? <ContainerLogsPanel id={props.id} /> : null}
            {tab === 'stats' ? <ContainerStatsPanel id={props.id} /> : null}
          </div>
        )}
      </Drawer>
      <ContainerExecDialog id={props.id} open={execOpen} onClose={() => setExecOpen(false)} />
    </>
  );
}

function Overview(props: { detail: ContainerDetail }): JSX.Element {
  const detail = props.detail;
  return (
    <div className="flex flex-col gap-4">
      {detail.health !== undefined && detail.health !== null && detail.health.length > 0 ? (
        <Alert
          tone={detail.health === 'healthy' ? 'success' : detail.health === 'unhealthy' ? 'danger' : 'info'}
          title="健康检查"
        >
          {healthLabel(detail.health)}
        </Alert>
      ) : null}

      <section className="grid grid-cols-1 gap-x-6 gap-y-2 rounded-lg border border-app-border bg-app-elevated/30 p-3 sm:grid-cols-2">
        <Info label="状态">
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge
              status={detail.state}
              label={containerStateLabel(detail.state)}
              size="sm"
              title={detail.status}
            />
            <span className="text-xs text-app-muted">{detail.status}</span>
          </div>
        </Info>
        <Info label="容器 ID">
          <span className="break-all font-mono text-[11px]">{detail.id}</span>
        </Info>
        <Info label="镜像">
          <span className="break-all font-mono text-[11px]">{detail.image}</span>
          {detail.imageId === undefined ? null : (
            <span className="block text-[10px] text-app-muted">imageId：{detail.imageId.slice(7, 19)}</span>
          )}
        </Info>
        <Info label="创建时间">
          <span className="text-xs" title={formatDate(detail.created)}>
            {formatDate(detail.created)}（<RelativeTime value={detail.created} />）
          </span>
        </Info>
        <Info label="启动命令">
          <span className="break-all font-mono text-[11px]">{detail.command ?? '—'}</span>
        </Info>
        <Info label="重启策略">{detail.restartPolicy ?? '—'}</Info>
        <Info label="平台">{detail.platform ?? '—'}</Info>
        <Info label="网络模式">{detail.networkMode ?? '—'}</Info>
        <Info label="Compose 项目">
          {detail.composeProject === undefined || detail.composeProject === null ? (
            '—'
          ) : (
            <span>
              {detail.composeProject}
              {detail.composeService === undefined || detail.composeService === null
                ? ''
                : ` / ${detail.composeService}`}
            </span>
          )}
        </Info>
        <Info label="健康状态">{detail.health === undefined || detail.health === null ? '未配置' : healthLabel(detail.health)}</Info>
      </section>

      <section>
        <SectionTitle title="端口映射" count={detail.ports.length} />
        {detail.ports.length === 0 ? (
          <p className="text-xs text-app-muted">没有端口映射。</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-app-border">
            <table className="w-full text-left text-xs">
              <thead className="bg-app-elevated text-[10px] uppercase tracking-wide text-app-muted">
                <tr>
                  <th className="px-2 py-1.5">宿主 IP</th>
                  <th className="px-2 py-1.5">宿主端口</th>
                  <th className="px-2 py-1.5">容器端口</th>
                  <th className="px-2 py-1.5">协议</th>
                </tr>
              </thead>
              <tbody>
                {detail.ports.map((port, index) => (
                  <tr key={`${port.privatePort}-${port.type}-${index}`} className="border-t border-app-border/70">
                    <td className="px-2 py-1.5 font-mono text-[11px]">{port.ip ?? '—'}</td>
                    <td className="px-2 py-1.5 font-mono text-[11px]">{port.publicPort ?? '—'}</td>
                    <td className="px-2 py-1.5 font-mono text-[11px]">{port.privatePort}</td>
                    <td className="px-2 py-1.5">{port.type}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <SectionTitle title="环境变量" count={detail.env.length} />
        <p className="mb-1.5 text-[10px] text-app-muted">
          环境变量可能包含敏感信息，请勿在公开场合分享截图。
        </p>
        {detail.env.length === 0 ? (
          <p className="text-xs text-app-muted">没有环境变量。</p>
        ) : (
          <div className="max-h-60 overflow-auto rounded-lg border border-app-border">
            <table className="w-full text-left text-xs">
              <tbody>
                {detail.env.map((entry, index) => {
                  const split = splitEnv(entry);
                  return (
                    <tr key={`${split.key}-${index}`} className="border-b border-app-border/60 last:border-b-0">
                      <td className="w-1/3 max-w-[12rem] break-all px-2 py-1.5 align-top font-mono text-[11px] text-app-accent">
                        {split.key}
                      </td>
                      <td className="break-all px-2 py-1.5 align-top font-mono text-[11px] text-app-text">
                        {split.value.length === 0 ? '—' : split.value}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <SectionTitle title="挂载" count={detail.mounts.length} />
        {detail.mounts.length === 0 ? (
          <p className="text-xs text-app-muted">没有挂载。</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-app-border">
            <table className="w-full text-left text-xs">
              <thead className="bg-app-elevated text-[10px] uppercase tracking-wide text-app-muted">
                <tr>
                  <th className="px-2 py-1.5">类型</th>
                  <th className="px-2 py-1.5">宿主路径</th>
                  <th className="px-2 py-1.5">容器路径</th>
                  <th className="px-2 py-1.5">模式</th>
                </tr>
              </thead>
              <tbody>
                {detail.mounts.map((mount, index) => (
                  <tr key={`${mount.destination}-${index}`} className="border-t border-app-border/70">
                    <td className="px-2 py-1.5">{mount.type}</td>
                    <td className="break-all px-2 py-1.5 font-mono text-[11px]">{mount.source ?? '—'}</td>
                    <td className="break-all px-2 py-1.5 font-mono text-[11px]">{mount.destination}</td>
                    <td className="px-2 py-1.5">
                      <Badge tone={mount.rw ? 'warning' : 'neutral'}>{mount.rw ? '读写' : '只读'}</Badge>
                      {mount.mode === undefined ? null : (
                        <span className="ml-1 text-[10px] text-app-muted">{mount.mode}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <SectionTitle title="网络" count={detail.ports.length} />
        <p className="text-xs text-app-muted">
          网络模式：<span className="font-mono text-app-text">{detail.networkMode ?? '默认（bridge）'}</span>
          {detail.ports.length === 0
            ? '；没有对外暴露的端口。'
            : `；共 ${detail.ports.length} 条端口映射，详见上方端口映射表。`}
        </p>
      </section>
    </div>
  );
}

function Info(props: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wide text-app-muted">{props.label}</p>
      <div className="mt-0.5 break-words text-xs text-app-text">{props.children}</div>
    </div>
  );
}

function SectionTitle(props: { title: string; count?: number }): JSX.Element {
  return (
    <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-app-text">
      {props.title}
      {props.count === undefined ? null : (
        <span className="rounded-full bg-app-elevated px-1.5 text-[10px] font-normal text-app-muted">
          {props.count}
        </span>
      )}
    </h3>
  );
}

function healthLabel(health: string): string {
  const labels: Record<string, string> = {
    healthy: '健康',
    unhealthy: '异常',
    starting: '检查中',
    none: '未配置',
  };
  return labels[health] ?? health;
}

function splitEnv(entry: string): { key: string; value: string } {
  const index = entry.indexOf('=');
  if (index < 0) return { key: entry, value: '' };
  return { key: entry.slice(0, index), value: entry.slice(index + 1) };
}
