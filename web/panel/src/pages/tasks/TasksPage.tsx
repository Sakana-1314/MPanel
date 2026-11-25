import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarClock,
  History,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import type { Task } from '../../api/types';
import { deleteTask, listTasks, runTask, tasksKeys, updateTask } from '../../api/tasks';
import { describeError } from '../../api/errors';
import { useAppMutation } from '../../lib/mutations';
import { formatDate, formatDuration } from '../../lib/format';
import { useToast } from '../../components/ui/Toast';
import { Alert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { EmptyState } from '../../components/ui/EmptyState';
import { PageHeader } from '../../components/ui/PageHeader';
import { Pagination } from '../../components/ui/Pagination';
import { RelativeTime } from '../../components/ui/RelativeTime';
import { SearchInput } from '../../components/ui/SearchInput';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { Switch } from '../../components/ui/Switch';
import { Tabs, type TabItem } from '../../components/ui/Tabs';
import { Toolbar } from '../../components/ui/Toolbar';
import { RunHistoryDrawer } from './RunHistoryDrawer';
import { describeCron } from './NextRunsPreview';

type EnabledFilter = 'all' | 'enabled' | 'disabled';

const FILTER_TABS: readonly TabItem[] = [
  { id: 'all', label: '全部' },
  { id: 'enabled', label: '已启用' },
  { id: 'disabled', label: '已禁用' },
];

/** 计划任务列表：cron 描述、启用开关、上次/下次运行、立即运行与历史。 */
export default function TasksPage(): JSX.Element {
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [enabledFilter, setEnabledFilter] = useState<EnabledFilter>('all');
  const [cursor, setCursor] = useState<string | null>(null);
  const [historyTask, setHistoryTask] = useState<Task | null>(null);
  const [runTarget, setRunTarget] = useState<Task | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Task | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setCursor(null);
  }, [debouncedSearch, enabledFilter]);

  const queryParams = useMemo(
    () => ({
      limit: 50,
      ...(cursor === null ? {} : { cursor }),
      ...(debouncedSearch.length === 0 ? {} : { q: debouncedSearch }),
      ...(enabledFilter === 'all' ? {} : { enabled: enabledFilter === 'enabled' }),
    }),
    [cursor, debouncedSearch, enabledFilter],
  );

  const tasksQuery = useQuery({
    queryKey: tasksKeys.list(queryParams),
    queryFn: () => listTasks(queryParams),
    refetchInterval: 15_000,
    retry: 0,
  });

  const tasks = tasksQuery.data?.items ?? [];
  const unavailableReason = tasksQuery.data?.reason;

  const toggleMutation = useAppMutation({
    mutationFn: (input: { task: Task; enabled: boolean }) =>
      updateTask(input.task.id, { enabled: input.enabled }),
    successMessage: (task, input) => `已${input.enabled ? '启用' : '禁用'}任务 ${task.name}`,
    successDescription: (_task, input) =>
      input.enabled ? '调度已恢复，下次运行时间会在列表刷新后更新。' : '已停止调度；手动“立即运行”仍然可用。',
    invalidate: [tasksKeys.list()],
    onSuccess: (task) => {
      void queryClient.invalidateQueries({ queryKey: tasksKeys.detail(task.id) });
    },
  });

  const runMutation = useAppMutation({
    mutationFn: (task: Task) => runTask(task.id),
    silentSuccess: true,
    invalidate: [tasksKeys.list()],
    onSuccess: (result, task) => {
      setRunTarget(null);
      setHistoryTask(task);
      void queryClient.invalidateQueries({ queryKey: tasksKeys.history(task.id) });
      if (result.run.status === 'skipped') {
        toast.warning(
          '本次运行已跳过',
          '任务已有运行中的实例且并发策略为 skip；可在运行历史中查看 skipped 记录。',
        );
      } else {
        toast.success('已触发立即运行', '任务在后台异步执行，运行历史每 2 秒自动刷新状态。');
      }
    },
  });

  const deleteMutation = useAppMutation({
    mutationFn: (task: Task) => deleteTask(task.id),
    successMessage: (_result, task) => `已删除任务 ${task.name}`,
    successDescription: (result) =>
      result.killedRun === undefined
        ? '调度已停止；运行历史已保留。'
        : '调度已停止，正在运行的实例已被终止；运行历史已保留。',
    invalidate: [tasksKeys.list()],
    onSuccess: (_result, task) => {
      setDeleteTarget(null);
      setHistoryTask((current) => (current?.id === task.id ? null : current));
    },
  });

  const pendingToggleId = toggleMutation.isPending ? toggleMutation.variables?.task.id : undefined;
  const runningCount = tasks.filter((task) => task.lastRun?.status === 'running').length;
  const enabledCount = tasks.filter((task) => task.enabled).length;

  const columns: readonly Column<Task>[] = [
    {
      key: 'name',
      header: '任务',
      sortable: true,
      sortValue: (task) => task.name,
      render: (task) => (
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="max-w-[16rem] truncate font-medium text-app-text">{task.name}</span>
            <Badge tone={task.enabled ? 'success' : 'neutral'} className="px-1.5 py-0 text-[10px]">
              {task.enabled ? '已启用' : '已禁用'}
            </Badge>
            {task.lastRun?.status === 'running' ? (
              <Badge tone="info" dot className="px-1.5 py-0 text-[10px]">
                运行中
              </Badge>
            ) : null}
          </span>
          {task.description === null || task.description.length === 0 ? null : (
            <span className="max-w-[20rem] truncate text-[11px] text-app-muted" title={task.description}>
              {task.description}
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'schedule',
      header: 'Cron 计划',
      render: (task) => (
        <div className="flex min-w-0 flex-col gap-0.5">
          <code className="truncate font-mono text-xs text-app-text">{task.schedule}</code>
          <span className="max-w-[16rem] truncate text-[11px] text-app-muted" title={describeCron(task.schedule)}>
            {describeCron(task.schedule)}
          </span>
          {task.timezone === null ? null : (
            <span className="text-[10px] text-app-muted">时区 {task.timezone}</span>
          )}
        </div>
      ),
    },
    {
      key: 'command',
      header: '命令',
      render: (task) => (
        <code
          className="block max-w-[16rem] truncate font-mono text-[11px] text-app-muted"
          title={task.command}
        >
          {summarizeCommand(task.command)}
        </code>
      ),
    },
    {
      key: 'lastRun',
      header: '上次运行',
      sortable: true,
      sortValue: (task) => task.lastRun?.startedAt ?? null,
      render: (task) => {
        if (task.lastRun === null) {
          return <span className="text-xs text-app-muted">从未运行</span>;
        }
        const run = task.lastRun;
        return (
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5">
              <StatusBadge status={run.status} size="sm" />
              <RelativeTime value={run.startedAt} className="text-[11px] text-app-muted" />
            </div>
            <span className="text-[10px] text-app-muted">
              {run.exitCode === null || run.exitCode === undefined ? '' : `退出码 ${run.exitCode} · `}
              {run.durationMs === null || run.durationMs === undefined
                ? ''
                : formatDuration(run.durationMs)}
            </span>
          </div>
        );
      },
    },
    {
      key: 'nextRunAt',
      header: '下次运行',
      sortable: true,
      sortValue: (task) => (task.enabled ? task.nextRunAt : null),
      render: (task) => {
        if (!task.enabled) return <span className="text-xs text-app-muted">已停用</span>;
        if (task.nextRunAt === null || task.nextRunAt === undefined) {
          return <span className="text-xs text-app-muted">—</span>;
        }
        return (
          <div className="flex flex-col gap-0.5">
            <RelativeTime value={task.nextRunAt} className="text-xs text-app-text" />
            <span className="text-[10px] text-app-muted" title={formatDate(task.nextRunAt)}>
              {formatDate(task.nextRunAt)}
            </span>
          </div>
        );
      },
    },
    {
      key: 'enabled',
      header: '启用',
      align: 'center',
      render: (task) => (
        <div onClick={(event) => event.stopPropagation()}>
          <Switch
            checked={task.enabled}
            disabled={pendingToggleId === task.id}
            onChange={(enabled) => toggleMutation.mutate({ task, enabled })}
            label={<span className="sr-only">启用任务 {task.name}</span>}
          />
        </div>
      ),
    },
    {
      key: 'actions',
      header: '操作',
      align: 'right',
      render: (task) => (
        <div
          className="flex items-center justify-end gap-0.5"
          onClick={(event) => event.stopPropagation()}
        >
          <Button
            variant="ghost"
            size="icon"
            aria-label={`立即运行 ${task.name}`}
            title="立即运行（异步）"
            onClick={() => setRunTarget(task)}
          >
            <Play className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`查看 ${task.name} 的运行历史`}
            title="运行历史"
            onClick={() => setHistoryTask(task)}
          >
            <History className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`编辑 ${task.name}`}
            title="编辑任务"
            onClick={() => navigate(`/tasks/${task.id}`)}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`删除 ${task.name}`}
            title="删除任务"
            className="hover:text-app-danger"
            onClick={() => setDeleteTarget(task)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col">
      <PageHeader
        title="计划任务"
        description="用 cron 表达式在 agent 上定时执行 shell 命令；支持并发策略、超时、运行历史与手动触发。"
        meta={
          <Badge tone={runningCount > 0 ? 'info' : 'neutral'} dot={runningCount > 0}>
            本页 {tasks.length} 个任务 · {enabledCount} 个启用
          </Badge>
        }
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw className={tasksQuery.isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />}
              onClick={() => {
                void tasksQuery.refetch();
              }}
              disabled={tasksQuery.isFetching}
            >
              刷新
            </Button>
            <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => navigate('/tasks/new')}>
              新建任务
            </Button>
          </>
        }
      />

      {tasksQuery.data?.available === false ? (
        <Alert
          tone="warning"
          title="任务能力不可用"
          hint={unavailableReason ?? 'agent 未能加载 croner 调度器，请检查依赖与服务端日志。'}
          className="mb-3"
        >
          任务列表可能为空；新建或运行任务会返回 UNAVAILABLE。
        </Alert>
      ) : null}

      {tasksQuery.error !== null && tasksQuery.error !== undefined ? (
        <div className="mb-3">
          <Alert tone="danger" title="加载任务失败" hint={describeError(tasksQuery.error).hint}>
            {describeError(tasksQuery.error).description}
          </Alert>
        </div>
      ) : null}

      <Toolbar
        left={
          <>
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="搜索名称或命令…"
              className="w-full sm:w-64"
            />
            <Tabs
              compact
              tabs={FILTER_TABS}
              active={enabledFilter}
              onChange={(id) => setEnabledFilter(id === 'enabled' ? 'enabled' : id === 'disabled' ? 'disabled' : 'all')}
              className="border-b-0"
            />
          </>
        }
        right={
          <span className="text-xs text-app-muted">
            {tasksQuery.isFetching ? '刷新中…' : `共 ${tasks.length} 条`}
          </span>
        }
      />

      <DataTable
        columns={columns}
        rows={tasks}
        rowKey={(task) => task.id}
        loading={tasksQuery.isLoading || tasksQuery.isFetching}
        error={tasksQuery.error ?? undefined}
        onRetry={() => {
          void tasksQuery.refetch();
        }}
        onRowClick={(task) => navigate(`/tasks/${task.id}`)}
        initialSort={{ key: 'name', direction: 'asc' }}
        dense
        empty={
          <EmptyState
            compact
            icon={<CalendarClock className="h-5 w-5" />}
            title={debouncedSearch.length > 0 ? '没有匹配的任务' : '还没有计划任务'}
            description={
              debouncedSearch.length > 0
                ? '尝试清空搜索词或切换启用状态筛选。'
                : '创建任务后可按 cron 定时执行命令，也可以随时手动触发。'
            }
            action={
              debouncedSearch.length > 0 ? (
                <Button variant="secondary" size="sm" onClick={() => setSearch('')}>
                  清空搜索
                </Button>
              ) : (
                <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => navigate('/tasks/new')}>
                  新建任务
                </Button>
              )
            }
          />
        }
      />

      {cursor !== null || (tasksQuery.data?.nextCursor ?? null) !== null ? (
        <Pagination
          nextCursor={tasksQuery.data?.nextCursor}
          loading={tasksQuery.isFetching}
          loaded={tasks.length}
          onNext={(next) => setCursor(next)}
          onReset={() => setCursor(null)}
        />
      ) : null}

      <p className="mt-2 text-[11px] leading-relaxed text-app-muted">
        任务命令由 agent 的 shell 执行（POSIX sh -c / PowerShell -Command / cmd /c）；超时会终止进程树，
        运行时强制移除面板凭据。删除任务会停止调度并终止当前运行，但保留历史。
      </p>

      <RunHistoryDrawer
        taskId={historyTask?.id ?? ''}
        open={historyTask !== null}
        onClose={() => setHistoryTask(null)}
        taskName={historyTask?.name}
        overlap={historyTask?.overlap}
        taskEnabled={historyTask?.enabled}
      />

      <ConfirmDialog
        open={runTarget !== null}
        title="立即运行任务？"
        message={
          <div className="flex flex-col gap-1.5">
            <p>
              将在服务器上异步执行任务「{runTarget?.name ?? ''}」，不会等待执行结束。
            </p>
            <p>
              {runTarget?.overlap === 'allow'
                ? '并发策略为 allow：即使已有实例运行也会并行执行。'
                : '并发策略为 skip：若已有实例正在运行，本次会记为已跳过。'}
              {runTarget?.enabled === false ? '任务当前已禁用，手动运行仍然允许。' : ''}
            </p>
          </div>
        }
        confirmLabel="立即运行"
        danger={false}
        loading={runMutation.isPending}
        onConfirm={() => {
          if (runTarget === null) return;
          return runMutation.mutateAsync(runTarget).then(
            () => undefined,
            () => undefined,
          );
        }}
        onCancel={() => setRunTarget(null)}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除任务？"
        message={
          <div className="flex flex-col gap-1.5">
            <p>
              删除任务「{deleteTarget?.name ?? ''}」会停止调度，并终止正在运行的实例（进程树）。
            </p>
            <p>运行历史会保留；此操作不可撤销。</p>
          </div>
        }
        confirmLabel="删除任务"
        danger
        loading={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteTarget === null) return;
          return deleteMutation.mutateAsync(deleteTarget).then(
            () => undefined,
            () => undefined,
          );
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

function summarizeCommand(command: string, max = 64): string {
  const firstLine =
    command
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';
  if (firstLine.length === 0) return '（空命令）';
  return firstLine.length > max ? `${firstLine.slice(0, max)}…` : firstLine;
}
