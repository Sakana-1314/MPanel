import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Eye, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { EdgeJob, EdgeJobStatus, Machine } from '../../api/types';
import { deleteEdgeJob, edgeKeys, listEdgeJobs } from '../../api/edge';
import { useAppMutation } from '../../lib/mutations';
import { cn } from '../../lib/cn';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorState } from '../../components/ui/ErrorState';
import { RelativeTime } from '../../components/ui/RelativeTime';
import { Select } from '../../components/ui/Select';
import { Spinner } from '../../components/ui/Spinner';
import { Toolbar } from '../../components/ui/Toolbar';
import {
  EDGE_JOB_KIND_LABEL,
  EDGE_JOB_STATUS_LABEL,
  EDGE_JOB_STATUS_TONE,
  edgeJobDurationText,
  machineName,
} from './edge-utils';
import { EdgeJobResultDrawer } from './EdgeJobResultDrawer';
import { usePageVisible } from './use-page-visible';

type MachineFilter = 'all' | string;
type StatusFilter = 'all' | EdgeJobStatus;

const STATUS_FILTER_OPTIONS = [
  { value: 'all', label: '全部状态' },
  ...(Object.keys(EDGE_JOB_STATUS_LABEL) as EdgeJobStatus[]).map((status) => ({
    value: status,
    label: EDGE_JOB_STATUS_LABEL[status],
  })),
];

export interface EdgeJobsPanelProps {
  machines: readonly Machine[];
  /** 边缘节点数量；为 0 时禁用新建（作业目标必须是边缘节点）。 */
  edgeMachineCount: number;
  onCreate: () => void;
}

/** 边缘作业面板：筛选、列表、结果抽屉与 pending 删除。 */
export function EdgeJobsPanel(props: EdgeJobsPanelProps): JSX.Element {
  const visible = usePageVisible();
  const [machineFilter, setMachineFilter] = useState<MachineFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<EdgeJob | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const params = useMemo(
    () => ({
      limit: 200,
      ...(machineFilter === 'all' ? {} : { machineId: machineFilter }),
      ...(statusFilter === 'all' ? {} : { status: statusFilter }),
    }),
    [machineFilter, statusFilter],
  );

  const jobsQuery = useQuery({
    queryKey: edgeKeys.jobs(params),
    queryFn: () => listEdgeJobs(params),
    retry: 0,
    refetchInterval: (query) => {
      if (!visible) return false;
      const items = query.state.data?.items ?? [];
      if (items.some((job) => job.status === 'running')) return 2_000;
      if (items.some((job) => job.status === 'pending')) return 5_000;
      return false;
    },
  });

  const jobs = jobsQuery.data?.items ?? [];
  const pendingCount = jobs.filter((job) => job.status === 'pending').length;
  const runningCount = jobs.filter((job) => job.status === 'running').length;

  const refreshJobs = async (): Promise<void> => {
    setRefreshing(true);
    try {
      await jobsQuery.refetch();
    } catch {
      // 查询错误会在表格上方显示。
    } finally {
      setRefreshing(false);
    }
  };

  const deleteMutation = useAppMutation<{ deleted: true }, EdgeJob>({
    mutationFn: (job) => deleteEdgeJob(job.id),
    successMessage: '已删除待执行作业',
    successDescription: '只有 pending 作业可以删除；已开始的作业不可撤回。',
    invalidate: [edgeKeys.jobsRoot()],
    onSuccess: () => setDeleteTarget(null),
  });

  const columns: Column<EdgeJob>[] = useMemo(
    () => [
      {
        key: 'kind',
        header: '类型',
        sortable: true,
        sortValue: (job) => job.kind,
        render: (job) => {
          const id =
            job.kind === 'run-task'
              ? typeof job.payload.taskId === 'string'
                ? job.payload.taskId
                : ''
              : job.kind === 'apply-site' && typeof job.payload.siteId === 'string'
                ? job.payload.siteId
                : '';
          return (
            <div className="flex flex-col gap-0.5">
              <Badge tone="neutral">{EDGE_JOB_KIND_LABEL[job.kind]}</Badge>
              {id.length === 0 ? null : (
                <span className="max-w-[12rem] truncate font-mono text-[10px] text-app-muted">
                  {id}
                </span>
              )}
            </div>
          );
        },
      },
      {
        key: 'machine',
        header: '机器',
        sortable: true,
        sortValue: (job) => machineName(props.machines, job.machineId),
        render: (job) => (
          <div className="min-w-0">
            <p className="truncate text-xs text-app-text">
              {machineName(props.machines, job.machineId)}
            </p>
            <p className="truncate font-mono text-[10px] text-app-muted">{job.machineId}</p>
          </div>
        ),
      },
      {
        key: 'status',
        header: '状态',
        sortable: true,
        sortValue: (job) => job.status,
        render: (job) => (
          <div className="flex flex-col items-start gap-0.5">
            <Badge tone={EDGE_JOB_STATUS_TONE[job.status]} dot>
              {EDGE_JOB_STATUS_LABEL[job.status]}
            </Badge>
            <span className="text-[10px] text-app-muted">HTTP {job.httpStatus ?? '—'}</span>
            {job.error === null ? null : (
              <span
                className="max-w-[14rem] truncate text-[10px] text-app-danger"
                title={job.error}
              >
                {job.error}
              </span>
            )}
          </div>
        ),
      },
      {
        key: 'duration',
        header: '耗时',
        sortable: true,
        sortValue: (job) => job.startedAt ?? '',
        render: (job) => (
          <span className={cn('text-xs tabular-nums', job.status === 'running' ? 'text-app-info' : 'text-app-text')}>
            {edgeJobDurationText(job)}
          </span>
        ),
      },
      {
        key: 'createdAt',
        header: '创建时间',
        sortable: true,
        sortValue: (job) => job.createdAt,
        render: (job) => (
          <RelativeTime value={job.createdAt} className="text-xs text-app-muted" />
        ),
      },
      {
        key: 'actions',
        header: '操作',
        align: 'right',
        render: (job) => {
          const deleting = deleteMutation.isPending && deleteMutation.variables?.id === job.id;
          return (
            <span
              className="flex items-center justify-end gap-0.5"
              onClick={(event) => event.stopPropagation()}
            >
              <Button
                variant="ghost"
                size="icon"
                title="查看结果 JSON"
                aria-label="查看作业结果"
                onClick={() => setSelectedJobId(job.id)}
              >
                <Eye className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="text-app-danger"
                title={job.status === 'pending' ? '删除待执行作业' : '只有 pending 作业可删除'}
                aria-label="删除作业"
                disabled={job.status !== 'pending'}
                loading={deleting}
                onClick={() => setDeleteTarget(job)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </span>
          );
        },
      },
    ],
    [deleteMutation.isPending, deleteMutation.variables, props.machines],
  );

  const machineOptions = [
    { value: 'all', label: '全部机器' },
    ...props.machines.map((machine) => ({
      value: machine.id,
      label: `${machine.name}${machine.edge === true ? '' : '（普通）'}`,
    })),
  ];

  return (
    <Card>
      <CardHeader
        title="作业"
        description="快照 / 运行任务 / 应用站点作业由 core 在节点在线时串行执行；待执行作业 5 秒刷新，执行中时 2 秒。"
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              icon={<RefreshCw className={refreshing ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />}
              loading={refreshing}
              onClick={() => {
                void refreshJobs();
              }}
            >
              刷新
            </Button>
            <Button
              size="sm"
              icon={<Plus className="h-3.5 w-3.5" />}
              disabled={props.edgeMachineCount === 0}
              title={
                props.edgeMachineCount === 0
                  ? '先让至少一个边缘节点入网'
                  : '为边缘节点创建作业'
              }
              onClick={props.onCreate}
            >
              新建作业
            </Button>
          </>
        }
      />
      <CardBody className="p-3">
        {jobsQuery.isError ? (
          <ErrorState error={jobsQuery.error} onRetry={() => void jobsQuery.refetch()} />
        ) : jobsQuery.isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Spinner label="加载作业…" />
          </div>
        ) : (
          <>
            <Toolbar
              bordered
              left={
                <>
                  <div className="w-48">
                    <Select
                      value={machineFilter}
                      onChange={(event) => setMachineFilter(event.target.value)}
                      options={machineOptions}
                      aria-label="按机器筛选作业"
                    />
                  </div>
                  <div className="w-36">
                    <Select
                      value={statusFilter}
                      onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
                      options={STATUS_FILTER_OPTIONS}
                      aria-label="按状态筛选作业"
                    />
                  </div>
                </>
              }
              right={
                <span className="text-xs text-app-muted">
                  共 {jobs.length} 条 · 待执行 {pendingCount} · 执行中 {runningCount}
                  {visible ? '' : ' · 页面隐藏，轮询已暂停'}
                </span>
              }
            />

            {jobs.length === 0 ? (
              <EmptyState
                icon={<Plus className="h-5 w-5" />}
                title="没有匹配的作业"
                description={
                  props.edgeMachineCount === 0
                    ? '先创建入网密钥并让 worker 接入，节点出现后即可下发快照、运行任务或应用站点作业。'
                    : '调整机器/状态筛选，或为边缘节点新建快照、运行任务、应用站点作业。'
                }
                action={
                  <Button
                    size="sm"
                    icon={<Plus className="h-3.5 w-3.5" />}
                    disabled={props.edgeMachineCount === 0}
                    onClick={props.onCreate}
                  >
                    新建作业
                  </Button>
                }
              />
            ) : (
              <DataTable
                columns={columns}
                rows={jobs}
                rowKey={(job) => job.id}
                loading={refreshing}
                onRowClick={(job) => setSelectedJobId(job.id)}
                empty="没有匹配的作业。"
                dense
              />
            )}
          </>
        )}
      </CardBody>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除待执行作业"
        message={
          <span>
            确定删除作业 <strong className="text-app-text">{deleteTarget?.id}</strong>？
            只有 pending 作业可以删除；节点上线后不会再执行它。
          </span>
        }
        confirmLabel="删除"
        loading={deleteMutation.isPending}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget !== null) deleteMutation.mutate(deleteTarget);
        }}
      />

      <EdgeJobResultDrawer
        jobId={selectedJobId}
        machines={props.machines}
        onClose={() => setSelectedJobId(null)}
      />
    </Card>
  );
}
