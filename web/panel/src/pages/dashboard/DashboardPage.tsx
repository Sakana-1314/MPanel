import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Clock,
  Container,
  Database,
  Files,
  Globe,
  RefreshCw,
  Server,
  ShieldCheck,
} from 'lucide-react';
import type { Machine } from '../../api/types';
import { getSystemInfo, getSystemMetrics, systemKeys } from '../../api/system';
import { listSites, sitesKeys } from '../../api/sites';
import { certsKeys, listCerts } from '../../api/certs';
import { databasesKeys, listProfiles } from '../../api/databases';
import { containersKeys, listContainers } from '../../api/containers';
import { listTasks, tasksKeys } from '../../api/tasks';
import { filesKeys, listRoots } from '../../api/files';
import { useActiveConnection, useConnectionStore, useSelectedMachineId } from '../../lib/connection-store';
import { useMachines } from '../../lib/use-machines';
import { useSession } from '../../lib/use-session';
import { formatDate, formatUptime } from '../../lib/format';
import { Alert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardBody } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorState } from '../../components/ui/ErrorState';
import { PageHeader } from '../../components/ui/PageHeader';
import { RelativeTime } from '../../components/ui/RelativeTime';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { useToast } from '../../components/ui/Toast';
import { MachineGrid } from './MachineGrid';
import { MetricsSection } from './MetricCards';
import { QuickActions } from './QuickActions';
import { ResourceCards } from './ResourceCards';
import { usePageVisible } from './use-page-visible';

const SITES_QUERY = { limit: 200 } as const;
const CERTS_QUERY = { limit: 200, includeExpired: true } as const;
const PROFILES_QUERY = { limit: 200 } as const;
const CONTAINERS_QUERY = { limit: 200, all: true } as const;
const TASKS_QUERY = { limit: 200 } as const;

function SummaryItem(props: {
  label: string;
  children: ReactNode;
  hint?: ReactNode;
}): JSX.Element {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-app-muted">{props.label}</p>
      <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-sm text-app-text">
        {props.children}
      </div>
      {props.hint === undefined ? null : (
        <p className="mt-0.5 truncate text-[10px] text-app-muted" title={String(props.hint)}>
          {props.hint}
        </p>
      )}
    </div>
  );
}

export default function DashboardPage(): JSX.Element {
  const connection = useActiveConnection();
  const session = useSession();
  const selectedMachineId = useSelectedMachineId();
  const selectMachine = useConnectionStore((state) => state.selectMachine);
  const queryClient = useQueryClient();
  const toast = useToast();
  const visible = usePageVisible();
  const [refreshing, setRefreshing] = useState(false);

  const authenticated = session.status === 'authenticated';
  const isCore = connection?.kind === 'core';
  const hasMachineContext =
    connection !== undefined &&
    (connection.kind === 'worker' || (connection.kind === 'core' && selectedMachineId !== undefined));

  const infoQuery = useQuery({
    queryKey: systemKeys.info(),
    queryFn: () => getSystemInfo(),
    enabled: authenticated,
    staleTime: 60_000,
    retry: 1,
  });

  const machinesQuery = useMachines(authenticated);

  const metricsQuery = useQuery({
    queryKey: systemKeys.metrics(),
    queryFn: getSystemMetrics,
    enabled: authenticated && hasMachineContext,
    staleTime: 10_000,
    refetchInterval: visible ? 20_000 : false,
    retry: 0,
  });

  const sitesQuery = useQuery({
    queryKey: sitesKeys.list(SITES_QUERY),
    queryFn: () => listSites(SITES_QUERY),
    enabled: authenticated && hasMachineContext,
    retry: 0,
  });

  const certsQuery = useQuery({
    queryKey: certsKeys.list(CERTS_QUERY),
    queryFn: () => listCerts(CERTS_QUERY),
    enabled: authenticated && hasMachineContext,
    retry: 0,
  });

  const profilesQuery = useQuery({
    queryKey: databasesKeys.profiles(PROFILES_QUERY),
    queryFn: () => listProfiles(PROFILES_QUERY),
    enabled: authenticated && hasMachineContext,
    retry: 0,
  });

  const containersQuery = useQuery({
    queryKey: containersKeys.list(CONTAINERS_QUERY),
    queryFn: () => listContainers(CONTAINERS_QUERY),
    enabled: authenticated && hasMachineContext,
    retry: 0,
  });

  const tasksQuery = useQuery({
    queryKey: tasksKeys.list(TASKS_QUERY),
    queryFn: () => listTasks(TASKS_QUERY),
    enabled: authenticated && hasMachineContext,
    retry: 0,
  });

  const rootsQuery = useQuery({
    queryKey: filesKeys.roots(),
    queryFn: listRoots,
    enabled: authenticated && hasMachineContext,
    retry: 0,
  });

  const machines = machinesQuery.data?.items ?? [];
  const selectedMachine = machines.find((machine) => machine.id === selectedMachineId);

  if (connection === undefined) {
    return (
      <EmptyState
        icon={<Server className="h-5 w-5" />}
        title="尚未连接后端"
        description="请先在侧边栏添加 agent 或 core 连接。"
      />
    );
  }

  const selectTargetMachine = (machine: Machine): void => {
    if (machine.id === selectedMachineId) {
      toast.info('已经是当前机器', machine.name);
      return;
    }
    selectMachine(connection.id, machine.id);
    toast.success(`已切换到 ${machine.name}`, '站点、证书、容器等请求已改为代理到该机器。');
  };

  const refreshAll = async (): Promise<void> => {
    setRefreshing(true);
    try {
      const tasks: Promise<unknown>[] = [
        queryClient.invalidateQueries({ queryKey: systemKeys.info() }),
      ];
      if (hasMachineContext) {
        tasks.push(
          queryClient.invalidateQueries({ queryKey: systemKeys.metrics() }),
          queryClient.invalidateQueries({ queryKey: sitesKeys.list(SITES_QUERY) }),
          queryClient.invalidateQueries({ queryKey: certsKeys.list(CERTS_QUERY) }),
          queryClient.invalidateQueries({ queryKey: databasesKeys.profiles(PROFILES_QUERY) }),
          queryClient.invalidateQueries({ queryKey: containersKeys.list(CONTAINERS_QUERY) }),
          queryClient.invalidateQueries({ queryKey: tasksKeys.list(TASKS_QUERY) }),
          queryClient.invalidateQueries({ queryKey: filesKeys.roots() }),
        );
      }
      if (isCore) tasks.push(machinesQuery.refetch());
      await Promise.all(tasks);
    } catch {
      // 各查询自身的错误态/卡片会展示失败原因；这里只负责收起刷新状态。
    } finally {
      setRefreshing(false);
    }
  };

  const scrollToMachines = (): void => {
    const target = document.getElementById('overview-machines');
    if (target !== null) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const certItems = certsQuery.data?.items ?? [];
  const expiringWithin30 = certItems.filter(
    (cert) => cert.daysRemaining >= 0 && cert.daysRemaining <= 30,
  ).length;

  const containerItems = containersQuery.data?.items ?? [];
  const runningContainers = containerItems.filter((item) => item.state === 'running').length;
  const containerTotal = containersQuery.data?.total ?? containerItems.length;

  const taskItems = tasksQuery.data?.items ?? [];
  const enabledTasks = taskItems.filter((task) => task.enabled).length;
  const taskTotal = tasksQuery.data?.total ?? taskItems.length;

  const siteCount = sitesQuery.data?.total ?? sitesQuery.data?.items.length ?? 0;
  const profileCount = profilesQuery.data?.total ?? profilesQuery.data?.items.length ?? 0;
  const rootCount = rootsQuery.data?.total ?? rootsQuery.data?.items.length ?? 0;

  const uptimeSec = metricsQuery.data?.uptimeSec ?? infoQuery.data?.uptimeSec;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="概览"
        description="当前连接、agent 实时指标与常用资源计数；指标请求在窗口隐藏时暂停。"
        meta={
          <>
            <Badge tone={isCore ? 'accent' : 'info'}>{connection.kind}</Badge>
            {infoQuery.data === undefined ? null : (
              <Badge tone="neutral">
                {infoQuery.data.role} v{infoQuery.data.version}
              </Badge>
            )}
            {selectedMachine === undefined ? null : (
              <StatusBadge status={selectedMachine.status} size="sm" />
            )}
          </>
        }
        actions={
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw className={refreshing ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />}
            loading={refreshing}
            onClick={() => {
              void refreshAll();
            }}
          >
            刷新
          </Button>
        }
      />

      <Card>
        <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <SummaryItem label="当前连接" hint={connection.baseUrl}>
            <span className="truncate font-medium">{connection.name}</span>
          </SummaryItem>
          <SummaryItem
            label="当前机器"
            hint={
              isCore
                ? selectedMachine === undefined
                  ? selectedMachineId === undefined
                    ? '在下方机器卡片或侧边栏选择'
                    : '正在加载机器信息…'
                  : `传输：${selectedMachine.transport}`
                : 'agent 直连，无机器代理'
            }
          >
            {isCore ? (
              selectedMachine === undefined ? (
                selectedMachineId === undefined ? (
                  <span className="text-app-muted">未选择</span>
                ) : (
                  <span className="truncate font-mono text-xs">{selectedMachineId}</span>
                )
              ) : (
                <>
                  <span className="truncate">{selectedMachine.name}</span>
                  <StatusBadge status={selectedMachine.status} size="sm" />
                </>
              )
            ) : (
              <span>agent 直连</span>
            )}
          </SummaryItem>
          <SummaryItem
            label="主机名"
            hint={
              infoQuery.data === undefined
                ? undefined
                : `${infoQuery.data.name} · node ${infoQuery.data.nodeVersion}`
            }
          >
            {infoQuery.isLoading ? (
              <span className="skeleton inline-block h-4 w-24" />
            ) : (
              <span className="truncate font-mono text-xs">
                {infoQuery.data?.hostname ?? '—'}
              </span>
            )}
          </SummaryItem>
          <SummaryItem
            label="系统 / 架构"
            hint={
              infoQuery.data === undefined
                ? undefined
                : `API v${infoQuery.data.apiVersion} · 协议 v${infoQuery.data.protocolVersion}`
            }
          >
            {infoQuery.isLoading ? (
              <span className="skeleton inline-block h-4 w-28" />
            ) : (
              <span className="truncate">
                {infoQuery.data === undefined
                  ? '—'
                  : `${infoQuery.data.platform} / ${infoQuery.data.arch}`}
              </span>
            )}
          </SummaryItem>
          <SummaryItem
            label="运行时长"
            hint={
              infoQuery.data === undefined
                ? undefined
                : `启动于 ${formatDate(infoQuery.data.startedAt)}`
            }
          >
            {infoQuery.isLoading ? (
              <span className="skeleton inline-block h-4 w-20" />
            ) : (
              <span className="tabular-nums">
                {uptimeSec === undefined ? '—' : formatUptime(uptimeSec)}
              </span>
            )}
          </SummaryItem>
        </CardBody>
      </Card>

      {infoQuery.isError ? (
        <ErrorState error={infoQuery.error} onRetry={() => void infoQuery.refetch()} />
      ) : null}

      {isCore && selectedMachineId === undefined && !machinesQuery.isError ? (
        <Alert
          tone="info"
          title={
            machines.length === 0 && !machinesQuery.isLoading
              ? 'core 上还没有机器'
              : '尚未选择机器'
          }
          hint={
            machines.length === 0 && !machinesQuery.isLoading
              ? '请到机器管理页添加 http/stdio/reverse-ws 机器，或使用边缘节点入网密钥让 agent 自助接入。'
              : '实时指标与资源统计需要目标机器；选择后本页请求会通过 /api/v1/machines/:id/proxy 发出。'
          }
          action={
            machines.length === 0 && !machinesQuery.isLoading ? (
              <div className="flex flex-wrap gap-2">
                <Link to="/machines">
                  <Button variant="secondary" size="sm">
                    机器管理
                  </Button>
                </Link>
                <Link to="/edge">
                  <Button variant="ghost" size="sm">
                    边缘节点
                  </Button>
                </Link>
              </div>
            ) : (
              <Button variant="secondary" size="sm" onClick={scrollToMachines}>
                选择机器
              </Button>
            )
          }
        >
          {machines.length === 0 && !machinesQuery.isLoading
            ? '接入第一台机器后，这里会显示实时指标、资源计数与机器卡片。'
            : 'core 连接本身不提供 agent 指标；下方机器卡片可直接切换当前机器。'}
        </Alert>
      ) : null}

      <MetricsSection query={metricsQuery} enabled={hasMachineContext} />

      <ResourceCards
        items={[
          {
            key: 'sites',
            label: '站点',
            icon: <Globe className="h-3.5 w-3.5" />,
            to: '/sites',
            loading: sitesQuery.isLoading,
            error: sitesQuery.error,
            enabled: hasMachineContext,
            data: sitesQuery.data,
            value: siteCount,
            hint: '站点总数（含草稿/禁用）',
            unavailableHint: '请确认 agent 的 Caddy 配置存储可读，并检查 MPANEL_HOME 权限。',
          },
          {
            key: 'certs',
            label: '30 天内到期证书',
            icon: <ShieldCheck className="h-3.5 w-3.5" />,
            to: '/certs',
            loading: certsQuery.isLoading,
            error: certsQuery.error,
            enabled: hasMachineContext,
            data: certsQuery.data,
            value: expiringWithin30,
            hint: `共 ${certItems.length} 张证书 · 不含已过期`,
            unavailableHint: '请确认 Caddy data 目录可读；证书页也只读展示。',
          },
          {
            key: 'databases',
            label: '数据库档案',
            icon: <Database className="h-3.5 w-3.5" />,
            to: '/databases',
            loading: profilesQuery.isLoading,
            error: profilesQuery.error,
            enabled: hasMachineContext,
            data: profilesQuery.data,
            value: profileCount,
            hint: 'PostgreSQL / Redis 档案总数',
            unavailableHint: '请确认 agent 上数据库档案存储可读；连接测试仍可能需要驱动与目标可达。',
          },
          {
            key: 'containers',
            label: '容器（运行中 / 总数）',
            icon: <Container className="h-3.5 w-3.5" />,
            to: '/containers',
            loading: containersQuery.isLoading,
            error: containersQuery.error,
            enabled: hasMachineContext,
            data: containersQuery.data,
            value: `${runningContainers} / ${containerTotal}`,
            hint: '运行中 / 总数（含已停止）',
            unavailableHint: 'Docker CLI 或 daemon 不可用；请确认 agent 上 Docker 已安装并运行。',
          },
          {
            key: 'tasks',
            label: '计划任务（启用 / 总数）',
            icon: <Clock className="h-3.5 w-3.5" />,
            to: '/tasks',
            loading: tasksQuery.isLoading,
            error: tasksQuery.error,
            enabled: hasMachineContext,
            data: tasksQuery.data,
            value: `${enabledTasks} / ${taskTotal}`,
            hint: '启用 / 总数',
            unavailableHint: 'agent 内置 croner 不可用；请检查 agent 日志与任务存储。',
          },
          {
            key: 'roots',
            label: '文件根',
            icon: <Files className="h-3.5 w-3.5" />,
            to: '/files',
            loading: rootsQuery.isLoading,
            error: rootsQuery.error,
            enabled: hasMachineContext,
            data: rootsQuery.data,
            value: rootCount,
            hint: 'agent 暴露的沙箱文件根数量',
            unavailableHint: '至少一个文件根需要通过 realpath 校验；请检查 agent 的文件根配置与权限。',
          },
        ]}
      />

      {isCore && machinesQuery.data?.available === false ? (
        <Alert
          tone="warning"
          title="机器存储不可用"
          hint="请检查 core 的 MPANEL_HOME 与文件权限后重试；机器卡片与当前机器选择依赖机器存储。"
        >
          {machinesQuery.data.reason ?? 'core 返回 available=false。'}
        </Alert>
      ) : null}

      {isCore ? (
        <MachineGrid
          machines={machines}
          loading={machinesQuery.isLoading}
          error={machinesQuery.isError ? machinesQuery.error : undefined}
          selectedMachineId={selectedMachineId}
          liveMetrics={metricsQuery.data}
          onSelect={selectTargetMachine}
          onRetry={() => void machinesQuery.refetch()}
        />
      ) : null}

      <QuickActions needsMachine={isCore && selectedMachineId === undefined} />

      {isCore ? (
        <p className="text-center text-[11px] text-app-muted">
          需要多机接入？前往{' '}
          <Link to="/edge" className="text-app-accent hover:underline">
            边缘节点
          </Link>{' '}
          创建入网密钥，让 NAT 后的 agent 主动连回 core。
        </p>
      ) : null}
    </div>
  );
}
