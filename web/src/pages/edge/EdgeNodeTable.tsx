import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Eye, Play, Plus, RefreshCw, Server, Target, Trash2 } from 'lucide-react';
import type { Machine, MachineStatus } from '../../api/types';
import { deleteMachine, machinesKeys } from '../../api/machines';
import { edgeKeys } from '../../api/edge';
import {
  useActiveConnection,
  useConnectionStore,
  useSelectedMachineId,
} from '../../lib/connection-store';
import { useAppMutation } from '../../lib/mutations';
import { formatPercent } from '../../lib/format';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorState } from '../../components/ui/ErrorState';
import { RelativeTime } from '../../components/ui/RelativeTime';
import { SearchInput } from '../../components/ui/SearchInput';
import { Select } from '../../components/ui/Select';
import { Spinner } from '../../components/ui/Spinner';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { Toolbar } from '../../components/ui/Toolbar';
import { useToast } from '../../components/ui/Toast';
import { Badge } from '../../components/ui/Badge';
import { EdgeNodeDrawer } from './EdgeNodeDrawer';
import { UsageMeter, percentOf } from './UsageMeter';

type StatusFilter = 'all' | MachineStatus;
type GroupFilter = 'all' | '__none__' | string;

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: '全部状态' },
  { value: 'online', label: '在线' },
  { value: 'offline', label: '离线' },
  { value: 'starting', label: '启动中' },
  { value: 'degraded', label: '降级' },
  { value: 'error', label: '错误' },
];

function versionOf(machine: Machine): string {
  return machine.worker?.version ?? machine.snapshot?.workerVersion ?? '—';
}

function platformOf(machine: Machine): string {
  const platform = machine.worker?.platform ?? machine.snapshot?.platform;
  const arch = machine.worker?.arch ?? machine.snapshot?.arch;
  return platform === undefined || arch === undefined ? '—' : `${platform}/${arch}`;
}

function SnapshotSummary(props: { machine: Machine }): JSX.Element {
  const snapshot = props.machine.snapshot ?? null;
  if (snapshot === null) {
    return <span className="text-[11px] text-app-muted">暂无快照</span>;
  }

  const memUsed = Math.max(0, snapshot.memTotalBytes - snapshot.memFreeBytes);
  const memPercent = percentOf(memUsed, snapshot.memTotalBytes);
  const diskPercent =
    snapshot.diskTotalBytes === null || snapshot.diskFreeBytes === null
      ? null
      : percentOf(
          Math.max(0, snapshot.diskTotalBytes - snapshot.diskFreeBytes),
          snapshot.diskTotalBytes,
        );

  return (
    <div className="flex w-44 flex-col gap-1">
      <span className="truncate text-[10px] text-app-muted" title={snapshot.hostname}>
        {snapshot.hostname}
      </span>
      <div className="flex items-center gap-1 text-[10px]">
        <span className="w-7 shrink-0 text-app-muted">内存</span>
        <UsageMeter percent={memPercent} size="sm" className="flex-1" />
        <span className="w-10 shrink-0 text-right tabular-nums text-app-muted">
          {memPercent === null ? '—' : formatPercent(memPercent)}
        </span>
      </div>
      <div className="flex items-center gap-1 text-[10px]">
        <span className="w-7 shrink-0 text-app-muted">磁盘</span>
        {diskPercent === null ? (
          <span className="flex-1 text-app-muted">—</span>
        ) : (
          <UsageMeter percent={diskPercent} size="sm" className="flex-1" />
        )}
        <span className="w-10 shrink-0 text-right tabular-nums text-app-muted">
          {diskPercent === null ? '' : formatPercent(diskPercent)}
        </span>
      </div>
    </div>
  );
}

export interface EdgeNodeTableProps {
  /** 仅 edge=true 的机器。 */
  nodes: Machine[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  onCreateJob: (machineId: string) => void;
  onCreateKey: () => void;
  /** core 上的全部机器数（用于普通机器说明）。 */
  allMachineCount: number;
}

/** 边缘节点表格：筛选、当前机器切换、详情、作业与删除。 */
export function EdgeNodeTable(props: EdgeNodeTableProps): JSX.Element {
  const connection = useActiveConnection();
  const selectedMachineId = useSelectedMachineId();
  const selectMachine = useConnectionStore((state) => state.selectMachine);
  const toast = useToast();

  const [search, setSearch] = useState('');
  const [groupFilter, setGroupFilter] = useState<GroupFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Machine | null>(null);

  const groups = useMemo(() => {
    const values = new Set<string>();
    for (const node of props.nodes) {
      if (node.group !== null && node.group.length > 0) values.add(node.group);
    }
    return [...values].sort((left, right) => left.localeCompare(right, 'zh-CN'));
  }, [props.nodes]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return props.nodes.filter((node) => {
      if (groupFilter === '__none__') {
        if (node.group !== null && node.group.length > 0) return false;
      } else if (groupFilter !== 'all' && node.group !== groupFilter) {
        return false;
      }
      if (statusFilter !== 'all' && node.status !== statusFilter) return false;
      if (needle.length === 0) return true;
      return (
        node.name.toLowerCase().includes(needle) ||
        node.id.toLowerCase().includes(needle) ||
        (node.group ?? '').toLowerCase().includes(needle) ||
        (node.snapshot?.hostname ?? '').toLowerCase().includes(needle)
      );
    });
  }, [props.nodes, search, groupFilter, statusFilter]);

  const detailNode = detailId === null ? null : (props.nodes.find((node) => node.id === detailId) ?? null);

  const deleteMutation = useAppMutation<{ deleted: true }, Machine>({
    mutationFn: (machine) => deleteMachine(machine.id),
    successMessage: (_, machine) => `已删除节点 ${machine.name}`,
    successDescription: 'core 上的机器配置与凭据已移除；目标机上的 worker 进程仍需手动停止。',
    invalidate: [machinesKeys.list({ limit: 200 }), edgeKeys.jobsRoot()],
    onSuccess: (_, machine) => {
      if (machine.id === selectedMachineId && connection !== undefined) {
        selectMachine(connection.id, undefined);
      }
      if (detailId === machine.id) setDetailId(null);
      setDeleteTarget(null);
    },
  });

  const selectCurrent = (machine: Machine): void => {
    if (connection === undefined) return;
    if (machine.id === selectedMachineId) {
      toast.info('已经是当前机器', machine.name);
      return;
    }
    selectMachine(connection.id, machine.id);
    toast.success(`已设为当前机器：${machine.name}`, '站点、证书、容器等请求会代理到该节点。');
  };

  const columns: Column<Machine>[] = [
    {
      key: 'name',
      header: '名称 / 分组',
      sortable: true,
      sortValue: (node) => node.name,
      render: (node) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-app-text">{node.name}</p>
          <div className="flex flex-wrap items-center gap-1">
            <Badge tone="neutral" className="text-[10px]">
              {node.group ?? '未分组'}
            </Badge>
            <span className="truncate font-mono text-[10px] text-app-muted">{node.id}</span>
          </div>
        </div>
      ),
    },
    {
      key: 'status',
      header: '状态',
      sortable: true,
      sortValue: (node) => node.status,
      render: (node) => (
        <div className="flex flex-col items-start gap-0.5">
          <StatusBadge status={node.status} size="sm" />
          <span className="text-[10px] text-app-muted">
            {node.enabled ? '已启用' : '已禁用'} ·{' '}
            {node.desiredState === 'running' ? '期望运行' : '期望停止'}
          </span>
        </div>
      ),
    },
    {
      key: 'version',
      header: '版本',
      sortable: true,
      sortValue: (node) => versionOf(node),
      render: (node) => (
        <div className="flex flex-col items-start gap-0.5">
          <span className="text-xs text-app-text">v{versionOf(node)}</span>
          <Badge tone={node.transport === 'reverse-ws' ? 'accent' : 'info'} className="text-[10px]">
            {node.transport}
          </Badge>
        </div>
      ),
    },
    {
      key: 'platform',
      header: '平台 / 架构',
      sortable: true,
      sortValue: (node) => platformOf(node),
      render: (node) => {
        const release = node.snapshot?.release;
        return (
          <div className="flex flex-col gap-0.5">
            <span className="text-xs text-app-text">{platformOf(node)}</span>
            {release === undefined ? null : (
              <span className="truncate text-[10px] text-app-muted" title={release}>
                {release}
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: 'lastSeenAt',
      header: '最后在线',
      sortable: true,
      sortValue: (node) => node.lastSeenAt ?? '',
      render: (node) => (
        <div className="flex flex-col gap-0.5">
          <RelativeTime value={node.lastSeenAt} fallback="从未在线" className="text-xs text-app-muted" />
          {node.lastError === null ? null : (
            <span className="max-w-[12rem] truncate text-[10px] text-app-danger" title={node.lastError}>
              {node.lastError}
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'snapshot',
      header: '快照摘要',
      render: (node) => <SnapshotSummary machine={node} />,
    },
    {
      key: 'actions',
      header: '操作',
      align: 'right',
      render: (node) => {
        const selected = node.id === selectedMachineId;
        const deleting = deleteMutation.isPending && deleteMutation.variables?.id === node.id;
        return (
          <span
            className="flex items-center justify-end gap-0.5"
            onClick={(event) => event.stopPropagation()}
          >
            <Button
              variant="ghost"
              size="icon"
              title="详情"
              aria-label="查看节点详情"
              onClick={() => setDetailId(node.id)}
            >
              <Eye className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className={selected ? 'text-app-accent' : ''}
              title={selected ? '已经是当前机器' : '设为当前机器'}
              aria-label="设为当前机器"
              disabled={selected}
              onClick={() => selectCurrent(node)}
            >
              <Target className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              title="新建作业"
              aria-label="新建作业"
              onClick={() => props.onCreateJob(node.id)}
            >
              <Play className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="text-app-danger"
              title="删除节点"
              aria-label="删除节点"
              loading={deleting}
              onClick={() => setDeleteTarget(node)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </span>
        );
      },
    },
  ];

  return (
    <Card>
      <CardHeader
        title="边缘节点"
        description="只有 edge=true（通过入网密钥自助注册）的机器会进入这张表；普通机器请在机器管理页维护。"
        icon={<Server className="h-4 w-4" />}
        actions={
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw className={props.loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />}
            loading={props.loading}
            onClick={props.onRetry}
          >
            刷新
          </Button>
        }
      />
      <CardBody className="p-3">
        {props.error !== undefined && props.error !== null ? (
          <ErrorState error={props.error} onRetry={props.onRetry} />
        ) : props.loading && props.nodes.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <Spinner label="加载边缘节点…" />
          </div>
        ) : props.nodes.length === 0 ? (
          <EmptyState
            icon={<Server className="h-5 w-5" />}
            title="还没有边缘节点"
            description={
              props.allMachineCount > 0
                ? `core 上现有 ${props.allMachineCount} 台机器，但都不是通过入网密钥注册的普通机器；普通机器不在本表展示。可以创建入网密钥让 NAT 后的 worker 自助接入，或到机器管理页维护现有机器。`
                : '先创建入网密钥，然后在目标机以 reverse-ws 传输启动 worker。worker 主动连回 core 后会自动出现在这里。'
            }
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button
                  size="sm"
                  icon={<Plus className="h-3.5 w-3.5" />}
                  onClick={props.onCreateKey}
                >
                  创建入网密钥
                </Button>
                <Link to="/machines">
                  <Button variant="secondary" size="sm">
                    机器管理
                  </Button>
                </Link>
              </div>
            }
          />
        ) : (
          <>
            <Toolbar
              bordered
              left={
                <>
                  <SearchInput
                    value={search}
                    onChange={setSearch}
                    placeholder="搜索节点名 / id / 分组 / 主机名…"
                  />
                  <div className="w-40">
                    <Select
                      value={groupFilter}
                      onChange={(event) => setGroupFilter(event.target.value)}
                      options={[
                        { value: 'all', label: '全部分组' },
                        { value: '__none__', label: '未分组' },
                        ...groups.map((group) => ({ value: group, label: group })),
                      ]}
                      aria-label="按分组筛选"
                    />
                  </div>
                  <div className="w-36">
                    <Select
                      value={statusFilter}
                      onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
                      options={STATUS_OPTIONS}
                      aria-label="按状态筛选"
                    />
                  </div>
                </>
              }
              right={
                <span className="text-xs text-app-muted">
                  共 {filtered.length} 台{props.loading ? ' · 刷新中…' : ''}
                </span>
              }
            />
            <DataTable
              columns={columns}
              rows={filtered}
              rowKey={(node) => node.id}
              loading={props.loading}
              onRowClick={(node) => setDetailId(node.id)}
              empty="没有匹配的边缘节点。"
              dense
            />
          </>
        )}
      </CardBody>

      <EdgeNodeDrawer
        machine={detailNode}
        selected={detailNode !== null && detailNode.id === selectedMachineId}
        onClose={() => setDetailId(null)}
        onCreateJob={props.onCreateJob}
        onSelectMachine={selectCurrent}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除边缘节点"
        message={
          <span>
            确定删除节点 <strong className="text-app-text">{deleteTarget?.name}</strong>？
            将移除 core 上的机器配置与凭据，所有经 core 代理到该节点的请求会立即失效；
            目标机上的 worker 进程不会自动停止。该节点需要新的入网密钥才能重新接入。
          </span>
        }
        confirmLabel="删除"
        loading={deleteMutation.isPending}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget !== null) deleteMutation.mutate(deleteTarget);
        }}
      />
    </Card>
  );
}
