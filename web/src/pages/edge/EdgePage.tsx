import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Network, Plus, RefreshCw, Server, Wifi } from 'lucide-react';
import { edgeKeys, listEdgeJobs } from '../../api/edge';
import { useActiveConnection } from '../../lib/connection-store';
import { useMachines } from '../../lib/use-machines';
import { useSession } from '../../lib/use-session';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { StatCard } from '../../components/ui/Card';
import { PageHeader } from '../../components/ui/PageHeader';
import { CreateEdgeJobDialog } from './CreateEdgeJobDialog';
import { CreateEdgeKeyDialog } from './CreateEdgeKeyDialog';
import { EdgeJobsPanel } from './EdgeJobsPanel';
import { EdgeKeyPanel } from './EdgeKeyPanel';
import { EdgeNodeTable } from './EdgeNodeTable';
import { usePageVisible } from './use-page-visible';

interface JobDialogState {
  open: boolean;
  machineId?: string;
}

/** 边缘节点页：入网密钥、节点表格与离线作业（仅 core）。 */
export default function EdgePage(): JSX.Element {
  const connection = useActiveConnection();
  const session = useSession();
  const queryClient = useQueryClient();
  const visible = usePageVisible();
  const [keyDialogOpen, setKeyDialogOpen] = useState(false);
  const [jobDialog, setJobDialog] = useState<JobDialogState>({ open: false });
  const [refreshing, setRefreshing] = useState(false);

  const authenticated = session.status === 'authenticated';
  const isCore = connection?.kind === 'core';

  const machinesQuery = useMachines(authenticated);

  const pendingQuery = useQuery({
    queryKey: edgeKeys.jobs({ status: 'pending', limit: 200 }),
    queryFn: () => listEdgeJobs({ status: 'pending', limit: 200 }),
    enabled: isCore && authenticated,
    retry: 0,
    refetchInterval: visible ? 5_000 : false,
  });

  const allMachines = machinesQuery.data?.items ?? [];
  const edgeNodes = allMachines.filter((machine) => machine.edge === true);
  const onlineCount = edgeNodes.filter((machine) => machine.status === 'online').length;
  const offlineCount = edgeNodes.filter((machine) => machine.status === 'offline').length;
  const degradedCount = edgeNodes.filter((machine) => machine.status === 'degraded').length;
  const errorCount = edgeNodes.filter((machine) => machine.status === 'error').length;
  const startingCount = edgeNodes.filter((machine) => machine.status === 'starting').length;
  const pendingCount = pendingQuery.data?.total ?? pendingQuery.data?.items.length ?? 0;

  const refreshAll = async (): Promise<void> => {
    setRefreshing(true);
    try {
      await Promise.all([
        machinesQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: edgeKeys.keysRoot() }),
        queryClient.invalidateQueries({ queryKey: edgeKeys.jobsRoot() }),
      ]);
    } catch {
      // 查询自身的错误态会展示失败原因；这里只负责收起刷新状态。
    } finally {
      setRefreshing(false);
    }
  };

  const openJobDialog = (machineId?: string): void => {
    setJobDialog({ open: true, machineId });
  };

  if (connection === undefined || connection.kind !== 'core') {
    return (
      <Alert tone="info" title="仅 core 支持边缘节点">
        边缘节点依赖 core 的入网密钥与作业调度；当前连接是 worker 直连。请在侧边栏切换到 core 连接。
      </Alert>
    );
  }

  const machinesUnavailable = machinesQuery.isError;
  const pendingUnavailable = pendingQuery.isError;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="边缘节点"
        description="NAT/防火墙后的 worker 使用共享入网密钥主动连回 core；节点与普通 reverse-ws 机器同构，支持分组、快照与离线异步作业。"
        meta={
          <>
            <Network className="h-4 w-4 text-app-accent" />
            <span className="text-xs text-app-muted">仅 core</span>
          </>
        }
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={
                <RefreshCw
                  className={refreshing ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'}
                />
              }
              loading={refreshing}
              onClick={() => {
                void refreshAll();
              }}
            >
              刷新
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<Plus className="h-3.5 w-3.5" />}
              onClick={() => setKeyDialogOpen(true)}
            >
              新建密钥
            </Button>
            <Button
              size="sm"
              icon={<Plus className="h-3.5 w-3.5" />}
              disabled={edgeNodes.length === 0}
              title={edgeNodes.length === 0 ? '先让至少一个边缘节点入网' : '为边缘节点创建作业'}
              onClick={() => openJobDialog()}
            >
              新建作业
            </Button>
          </>
        }
      />

      {machinesQuery.data?.available === false ? (
        <Alert
          tone="warning"
          title="机器存储不可用"
          hint="请检查 core 的 MPANEL_HOME 与文件权限后重试；边缘节点依赖机器存储保存入网来源与快照。"
        >
          {machinesQuery.data.reason ?? 'core 返回 available=false。'}
        </Alert>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="节点总数"
          value={machinesUnavailable ? '—' : edgeNodes.length}
          hint={`core 全部机器 ${allMachines.length} 台`}
          icon={<Network className="h-4 w-4" />}
          loading={machinesQuery.isLoading}
        />
        <StatCard
          label="在线"
          value={machinesUnavailable ? '—' : onlineCount}
          tone={onlineCount > 0 ? 'success' : 'neutral'}
          hint="心跳 ≤ 15s"
          icon={<Wifi className="h-4 w-4" />}
          loading={machinesQuery.isLoading}
        />
        <StatCard
          label="离线"
          value={machinesUnavailable ? '—' : offlineCount}
          tone={offlineCount > 0 ? 'danger' : 'neutral'}
          hint={`降级 ${degradedCount} · 错误 ${errorCount} · 启动中 ${startingCount}`}
          icon={<Server className="h-4 w-4" />}
          loading={machinesQuery.isLoading}
        />
        <StatCard
          label="待执行作业"
          value={pendingUnavailable ? '—' : pendingCount}
          tone={pendingCount > 0 ? 'warning' : 'neutral'}
          hint="节点离线时保持 pending，上线后串行执行"
          icon={<Clock className="h-4 w-4" />}
          loading={pendingQuery.isLoading}
        />
      </div>

      <EdgeNodeTable
        nodes={edgeNodes}
        loading={machinesQuery.isLoading || refreshing}
        error={machinesQuery.isError ? machinesQuery.error : undefined}
        onRetry={() => {
          void refreshAll();
        }}
        onCreateJob={openJobDialog}
        onCreateKey={() => setKeyDialogOpen(true)}
        allMachineCount={allMachines.length}
      />

      <EdgeKeyPanel
        onCreate={() => setKeyDialogOpen(true)}
        onRefresh={() => {
          void refreshAll();
        }}
        refreshing={refreshing}
      />

      <EdgeJobsPanel
        machines={allMachines}
        edgeMachineCount={edgeNodes.length}
        onCreate={() => openJobDialog()}
      />

      <CreateEdgeKeyDialog
        open={keyDialogOpen}
        onClose={() => setKeyDialogOpen(false)}
        coreUrl={connection.baseUrl}
      />

      <CreateEdgeJobDialog
        open={jobDialog.open}
        machines={edgeNodes}
        initialMachineId={jobDialog.machineId}
        onClose={() => setJobDialog({ open: false })}
        onCreated={() => setJobDialog({ open: false })}
      />
    </div>
  );
}
