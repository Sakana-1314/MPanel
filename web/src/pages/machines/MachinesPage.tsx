import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Eye,
  Pencil,
  Play,
  Plus,
  Power,
  RefreshCw,
  Square,
  Trash2,
  Wifi,
} from 'lucide-react';
import type {
  Machine,
  MachineEnrollment,
  MachineStatus,
  MachineTestResult,
  MachineTransport,
} from '../../api/types';
import {
  connectMachine,
  deleteMachine,
  disconnectMachine,
  machinesKeys,
  testMachine,
} from '../../api/machines';
import { useMachines } from '../../lib/use-machines';
import { useAppMutation, toastError } from '../../lib/mutations';
import { RelativeTime } from '../../components/ui/RelativeTime';
import { EnrollmentDialog } from './EnrollmentDialog';
import { MachineFormDialog } from './MachineFormDialog';
import { Alert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorState } from '../../components/ui/ErrorState';
import { PageHeader } from '../../components/ui/PageHeader';
import { SearchInput } from '../../components/ui/SearchInput';
import { Select } from '../../components/ui/Select';
import { StatCard } from '../../components/ui/Card';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { Toolbar } from '../../components/ui/Toolbar';
import { useToast } from '../../components/ui/Toast';

type StatusFilter = 'all' | MachineStatus;
type TransportFilter = 'all' | MachineTransport;

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: '全部状态' },
  { value: 'online', label: '在线' },
  { value: 'offline', label: '离线' },
  { value: 'starting', label: '启动中' },
  { value: 'degraded', label: '降级' },
  { value: 'error', label: '错误' },
];

const TRANSPORT_OPTIONS: { value: TransportFilter; label: string }[] = [
  { value: 'all', label: '全部传输' },
  { value: 'http', label: 'http' },
  { value: 'stdio', label: 'stdio' },
  { value: 'reverse-ws', label: 'reverse-ws' },
];

function desiredStateLabel(machine: Machine): string {
  return machine.desiredState === 'running' ? '期望运行' : '期望停止';
}

export default function MachinesPage(): JSX.Element {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const machines = useMachines();

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [transportFilter, setTransportFilter] = useState<TransportFilter>('all');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Machine | undefined>(undefined);
  const [deleteTarget, setDeleteTarget] = useState<Machine | null>(null);
  const [enrollment, setEnrollment] = useState<MachineEnrollment | null>(null);
  const [testResults, setTestResults] = useState<Record<string, MachineTestResult>>({});

  const items = machines.data?.items ?? [];

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return items.filter((machine) => {
      if (statusFilter !== 'all' && machine.status !== statusFilter) return false;
      if (transportFilter !== 'all' && machine.transport !== transportFilter) return false;
      if (needle.length === 0) return true;
      return (
        machine.name.toLowerCase().includes(needle) ||
        machine.id.toLowerCase().includes(needle) ||
        (machine.endpoint ?? '').toLowerCase().includes(needle)
      );
    });
  }, [items, search, statusFilter, transportFilter]);

  const counts = useMemo(() => {
    let online = 0;
    let issues = 0;
    let remote = 0;
    for (const machine of items) {
      if (machine.status === 'online') online += 1;
      if (
        machine.status === 'offline' ||
        machine.status === 'error' ||
        machine.status === 'degraded'
      ) {
        issues += 1;
      }
      if (machine.transport === 'reverse-ws') remote += 1;
    }
    return { total: items.length, online, issues, remote };
  }, [items]);

  const connectMutation = useAppMutation<Machine, Machine>({
    mutationFn: (machine) => connectMachine(machine.id),
    successMessage: (machine) => `已请求连接 ${machine.name}`,
    successDescription: (machine) =>
      machine.transport === 'reverse-ws'
        ? 'reverse-ws 不主动拨号；已允许该机器重连，等待 worker 连回。'
        : 'core 正在建立到 worker 的连接。',
    invalidate: [machinesKeys.list({ limit: 200 })],
    onSuccess: (machine) => {
      void queryClient.invalidateQueries({ queryKey: machinesKeys.health(machine.id) });
    },
  });

  const disconnectMutation = useAppMutation<Machine, Machine>({
    mutationFn: (machine) => disconnectMachine(machine.id),
    successMessage: (machine) => `已断开 ${machine.name}`,
    successDescription: 'desiredState 已设为 stopped；reverse-ws 需要重新 connect 才允许连回。',
    invalidate: [machinesKeys.list({ limit: 200 })],
    onSuccess: (machine) => {
      void queryClient.invalidateQueries({ queryKey: machinesKeys.health(machine.id) });
    },
  });

  const testMutation = useMutation({
    mutationFn: (machine: Machine) => testMachine(machine.id),
    onSuccess: (result, machine) => {
      setTestResults((current) => ({ ...current, [machine.id]: result }));
      if (result.reachable) {
        toast.success(
          `测试成功 · ${machine.name}`,
          result.info === undefined || result.info === null
            ? `${result.latencyMs ?? '?'} ms`
            : `${result.info.name} v${result.info.version} · ${result.latencyMs ?? '?'} ms`,
        );
      } else {
        toast.error(`测试失败 · ${machine.name}`, result.error ?? '无法连接 worker');
      }
      void queryClient.invalidateQueries({ queryKey: machinesKeys.list({ limit: 200 }) });
    },
    onError: (error) => toastError(toast, error),
  });

  const deleteMutation = useAppMutation<{ deleted: true }, Machine>({
    mutationFn: (machine) => deleteMachine(machine.id),
    successMessage: (_, machine) => `已删除机器 ${machine.name}`,
    successDescription: '机器凭据与配置已移除；worker 进程本身不受影响。',
    invalidate: [machinesKeys.list({ limit: 200 })],
    onSuccess: () => setDeleteTarget(null),
  });

  const columns: Column<Machine>[] = [
    {
      key: 'name',
      header: '机器',
      sortable: true,
      sortValue: (machine) => machine.name,
      render: (machine) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-app-text">{machine.name}</p>
          <p className="truncate font-mono text-[10px] text-app-muted">{machine.id}</p>
        </div>
      ),
    },
    {
      key: 'status',
      header: '状态',
      sortable: true,
      sortValue: (machine) => machine.status,
      render: (machine) => (
        <div className="flex flex-col items-start gap-1">
          <StatusBadge status={machine.status} />
          <span className="text-[10px] text-app-muted">{desiredStateLabel(machine)}</span>
        </div>
      ),
    },
    {
      key: 'transport',
      header: '传输 / 端点',
      sortable: true,
      sortValue: (machine) => machine.transport,
      render: (machine) => (
        <div className="flex min-w-0 flex-col gap-0.5">
          <Badge tone={machine.transport === 'reverse-ws' ? 'accent' : 'info'}>
            {machine.transport}
          </Badge>
          <span
            className="max-w-[18rem] truncate font-mono text-[10px] text-app-muted"
            title={machine.endpoint ?? 'stdio 由 core 拉起本地进程'}
          >
            {machine.endpoint ?? '（stdio 本地进程）'}
          </span>
        </div>
      ),
    },
    {
      key: 'enabled',
      header: '启用',
      sortable: true,
      sortValue: (machine) => (machine.enabled ? 1 : 0),
      render: (machine) => (
        <div className="flex flex-col items-start gap-1">
          <Badge tone={machine.enabled ? 'success' : 'neutral'}>
            {machine.enabled ? '已启用' : '已禁用'}
          </Badge>
          {machine.lastError === null ? null : (
            <span
              className="max-w-[14rem] truncate text-[10px] text-app-danger"
              title={machine.lastError}
            >
              {machine.lastError}
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'test',
      header: '连通性测试',
      render: (machine) => {
        const result = testResults[machine.id];
        if (result === undefined) return <span className="text-xs text-app-muted">—</span>;
        return (
          <div className="flex flex-col items-start gap-0.5">
            <Badge tone={result.reachable ? 'success' : 'danger'}>
              {result.reachable ? '可达' : '不可达'}
            </Badge>
            <span className="text-[10px] text-app-muted">
              {result.latencyMs === null || result.latencyMs === undefined
                ? ''
                : `${result.latencyMs} ms`}
              {result.reachable || result.error === undefined ? '' : ` · ${result.error}`}
            </span>
          </div>
        );
      },
    },
    {
      key: 'lastSeenAt',
      header: '最近心跳',
      sortable: true,
      sortValue: (machine) => machine.lastSeenAt ?? '',
      render: (machine) => (
        <div className="flex flex-col gap-0.5">
          <RelativeTime value={machine.lastSeenAt} className="text-xs text-app-muted" />
          <span className="text-[10px] text-app-muted">
            {machine.worker === null
              ? 'worker 未上报'
              : `${machine.worker.name} v${machine.worker.version} · ${machine.worker.platform}/${machine.worker.arch}`}
          </span>
        </div>
      ),
    },
    {
      key: 'actions',
      header: '操作',
      align: 'right',
      render: (machine) => {
        const connecting =
          connectMutation.isPending && connectMutation.variables?.id === machine.id;
        const disconnecting =
          disconnectMutation.isPending && disconnectMutation.variables?.id === machine.id;
        const testing = testMutation.isPending && testMutation.variables?.id === machine.id;
        const running = machine.desiredState === 'running';
        return (
          <span
            className="flex items-center justify-end gap-0.5"
            onClick={(event) => event.stopPropagation()}
          >
            {running ? (
              <Button
                variant="ghost"
                size="icon"
                title="断开机器（desiredState=stopped）"
                aria-label="断开机器"
                icon={<Square className="h-3.5 w-3.5" />}
                loading={disconnecting}
                onClick={() => disconnectMutation.mutate(machine)}
              />
            ) : (
              <Button
                variant="ghost"
                size="icon"
                title={
                  machine.enabled
                    ? '连接机器（desiredState=running）'
                    : '机器已禁用，请先在编辑中启用'
                }
                aria-label="连接机器"
                disabled={!machine.enabled}
                icon={<Play className="h-3.5 w-3.5" />}
                loading={connecting}
                onClick={() => connectMutation.mutate(machine)}
              />
            )}
            <Button
              variant="ghost"
              size="icon"
              title="测试连接（POST /machines/:id/test）"
              aria-label="测试连接"
              icon={<Wifi className="h-3.5 w-3.5" />}
              loading={testing}
              onClick={() => testMutation.mutate(machine)}
            />
            <Button
              variant="ghost"
              size="icon"
              title="详情与健康"
              aria-label="查看详情"
              onClick={() => navigate(`/machines/${machine.id}`)}
            >
              <Eye className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              title="编辑机器"
              aria-label="编辑机器"
              onClick={() => {
                setEditing(machine);
                setFormOpen(true);
              }}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="text-app-danger"
              title="删除机器"
              aria-label="删除机器"
              onClick={() => setDeleteTarget(machine)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </span>
        );
      },
    },
  ];

  return (
    <div>
      <PageHeader
        title="机器"
        description="core 通过 http / stdio / reverse-ws 管理 worker；所有站点、证书等特性请求都经机器代理。"
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={
                <RefreshCw
                  className={`h-3.5 w-3.5 ${machines.isFetching ? 'animate-spin' : ''}`}
                />
              }
              onClick={() => {
                void machines.refetch();
              }}
            >
              刷新
            </Button>
            <Button
              size="sm"
              icon={<Plus className="h-3.5 w-3.5" />}
              onClick={() => {
                setEditing(undefined);
                setFormOpen(true);
              }}
            >
              新增机器
            </Button>
          </>
        }
      />

      <div className="mb-3 grid gap-2 sm:grid-cols-3">
        <StatCard
          label="机器总数"
          value={counts.total}
          hint={`reverse-ws ${counts.remote} 台`}
          icon={<Power className="h-4 w-4" />}
          loading={machines.isLoading}
        />
        <StatCard
          label="在线"
          value={counts.online}
          tone={counts.online > 0 ? 'success' : 'neutral'}
          hint="心跳 ≤ 15s"
          loading={machines.isLoading}
        />
        <StatCard
          label="异常"
          value={counts.issues}
          tone={counts.issues > 0 ? 'danger' : 'neutral'}
          hint="离线 / 降级 / error"
          loading={machines.isLoading}
        />
      </div>

      {machines.data?.available === false ? (
        <Alert
          tone="danger"
          title="机器存储不可用"
          hint="请检查 core 的 MPANEL_HOME 与文件权限后重试。"
          className="mb-3"
        >
          {machines.data.reason ?? 'core 返回 available=false。'}
        </Alert>
      ) : null}

      <Toolbar
        bordered
        left={
          <>
            <SearchInput value={search} onChange={setSearch} placeholder="搜索机器名 / id / 端点…" />
            <div className="w-40">
              <Select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
                options={STATUS_OPTIONS}
                aria-label="按状态筛选"
              />
            </div>
            <div className="w-40">
              <Select
                value={transportFilter}
                onChange={(event) => setTransportFilter(event.target.value as TransportFilter)}
                options={TRANSPORT_OPTIONS}
                aria-label="按传输筛选"
              />
            </div>
          </>
        }
        right={
          <span className="text-xs text-app-muted">
            共 {filtered.length} 台{machines.isFetching ? ' · 刷新中…' : ''}
          </span>
        }
      />

      {machines.isError ? (
        <ErrorState error={machines.error} onRetry={() => void machines.refetch()} />
      ) : items.length === 0 && !machines.isLoading ? (
        <EmptyState
          icon={<Power className="h-5 w-5" />}
          title="还没有机器"
          description="新增一台机器后，core 才能代理站点、证书、容器、文件等特性请求。支持 http（直连 token）、stdio（core 拉起本地进程，需要 MPANEL_ALLOW_STDIO=1）与 reverse-ws（worker 主动连回，创建后显示一次性注册信息）。"
          action={
            <Button
              size="sm"
              icon={<Plus className="h-3.5 w-3.5" />}
              onClick={() => {
                setEditing(undefined);
                setFormOpen(true);
              }}
            >
              新增机器
            </Button>
          }
        />
      ) : (
        <DataTable
          columns={columns}
          rows={filtered}
          rowKey={(machine) => machine.id}
          loading={machines.isLoading}
          onRowClick={(machine) => navigate(`/machines/${machine.id}`)}
          empty="没有匹配的机器。"
          stickyHeader
        />
      )}

      <MachineFormDialog
        open={formOpen}
        machine={editing}
        onClose={() => {
          setFormOpen(false);
          setEditing(undefined);
        }}
        onSaved={(result) => {
          if (result.enrollment !== undefined) setEnrollment(result.enrollment);
        }}
      />

      {enrollment === null ? null : (
        <EnrollmentDialog enrollment={enrollment} onClose={() => setEnrollment(null)} />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除机器"
        message={
          <span>
            确定删除机器 <strong className="text-app-text">{deleteTarget?.name}</strong>？
            将移除机器配置与凭据（worker 进程本身不受影响）；所有经 core 代理的请求会立即失效。
          </span>
        }
        confirmLabel="删除"
        loading={deleteMutation.isPending}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget !== null) deleteMutation.mutate(deleteTarget);
        }}
      />
    </div>
  );
}
