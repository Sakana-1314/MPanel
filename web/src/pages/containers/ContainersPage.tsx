import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Boxes,
  Cpu,
  MemoryStick,
  Play,
  RefreshCw,
  RotateCw,
  Square,
  Trash2,
} from 'lucide-react';
import type { SelectOption } from '../../components/ui/Select';
import {
  containerAction,
  containersKeys,
  listContainers,
  removeContainer,
  type ContainerAction,
} from '../../api/containers';
import { describeError, isAppError } from '../../api/errors';
import { scopedKey } from '../../lib/query-keys';
import { useAppMutation } from '../../lib/mutations';
import { formatBytes, formatPercent } from '../../lib/format';
import { Alert, UnavailableAlert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { ErrorState } from '../../components/ui/ErrorState';
import { PageHeader } from '../../components/ui/PageHeader';
import { SearchInput } from '../../components/ui/SearchInput';
import { Select } from '../../components/ui/Select';
import { Spinner } from '../../components/ui/Spinner';
import { StatCard } from '../../components/ui/Card';
import { Toolbar } from '../../components/ui/Toolbar';
import { ContainerTabs } from './ContainerTabs';
import { ContainerTable } from './ContainerTable';
import { ContainerDetailDrawer, type ContainerDetailTab } from './ContainerDetailDrawer';
import { containerName, containerShortId, CONTAINER_ACTION_LABEL } from './container-utils';
import { useContainerStats } from './useContainerStats';

type StatusFilter = 'all' | 'running' | 'exited' | 'paused' | 'created' | 'restarting' | 'dead';

const STATUS_OPTIONS: readonly SelectOption[] = [
  { value: 'all', label: '全部状态' },
  { value: 'running', label: '运行中' },
  { value: 'exited', label: '已退出' },
  { value: 'paused', label: '已暂停' },
  { value: 'created', label: '已创建' },
  { value: 'restarting', label: '重启中' },
  { value: 'dead', label: '异常' },
];

/** 行内 stats 轮询上限，避免一次打开几百个容器时打爆 worker。 */
const MAX_POLLED_CONTAINERS = 50;

interface BatchOutcome {
  succeeded: string[];
  failed: { id: string; error: unknown }[];
}

type ConfirmTarget =
  | { action: ContainerAction; ids: string[] }
  | { action: 'remove'; ids: string[] };

export default function ContainersPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [confirm, setConfirm] = useState<ConfirmTarget | null>(null);
  const [forceRemove, setForceRemove] = useState(false);
  const [removeVolumes, setRemoveVolumes] = useState(false);
  const [detailTab, setDetailTab] = useState<ContainerDetailTab>('overview');

  const listQuery = useQuery({
    queryKey: containersKeys.list({ all: true }),
    queryFn: () => listContainers({ all: true, limit: 200 }),
    refetchInterval: 15_000,
    retry: 1,
  });

  const containers = listQuery.data?.items ?? [];
  const available = listQuery.data?.available !== false;
  const unavailable =
    listQuery.data?.available === false || isAppError(listQuery.error, 'UNAVAILABLE');

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return containers.filter((container) => {
      if (statusFilter !== 'all' && container.state !== statusFilter) return false;
      if (needle.length === 0) return true;
      const haystack = [
        containerName(container),
        container.image,
        container.id,
        container.composeProject ?? '',
        container.composeService ?? '',
      ];
      return haystack.some((value) => value.toLowerCase().includes(needle));
    });
  }, [containers, search, statusFilter]);

  const runningCount = containers.filter((container) => container.state === 'running').length;
  const runningIds = useMemo(
    () =>
      containers
        .filter((container) => container.state === 'running')
        .map((container) => container.id)
        .slice(0, MAX_POLLED_CONTAINERS),
    [containers],
  );
  const stats = useContainerStats(runningIds, { enabled: available });

  const totals = useMemo(() => {
    let cpuPercent = 0;
    let memoryBytes = 0;
    let memoryLimitBytes = 0;
    let sampled = 0;
    stats.statsById.forEach((sample) => {
      cpuPercent += sample.cpuPercent;
      memoryBytes += sample.memoryUsageBytes;
      memoryLimitBytes += sample.memoryLimitBytes;
      sampled += 1;
    });
    return { cpuPercent, memoryBytes, memoryLimitBytes, sampled };
  }, [stats.statsById]);

  // 列表刷新后剔除已不存在的选中项。
  useEffect(() => {
    setSelectedIds((previous) => {
      const alive = new Set(containers.map((container) => container.id));
      const next = new Set(Array.from(previous).filter((containerId) => alive.has(containerId)));
      return next.size === previous.size ? previous : next;
    });
  }, [containers]);

  const listRoot = scopedKey('containers', 'list');
  const detailRoot = scopedKey('containers', 'detail');
  const statsRoot = scopedKey('containers', 'stats');
  const stacksRoot = scopedKey('stacks', 'list');
  const stackDetailRoot = scopedKey('stacks', 'detail');

  const actionMutation = useAppMutation<BatchOutcome, { ids: string[]; action: ContainerAction }>({
    mutationFn: ({ ids, action }) => runBatch(ids, (containerId) => containerAction(containerId, action)),
    successMessage: (outcome, variables) =>
      `${CONTAINER_ACTION_LABEL[variables.action]}完成：成功 ${outcome.succeeded.length} 个容器`,
    successDescription: (outcome) => failureSummary(outcome),
    errorMessage: '容器操作失败',
    invalidate: [listRoot, detailRoot, statsRoot, stacksRoot, stackDetailRoot],
  });

  const removeMutation = useAppMutation<
    BatchOutcome,
    { ids: string[]; force: boolean; removeVolumes: boolean }
  >({
    mutationFn: ({ ids, force, removeVolumes: withVolumes }) =>
      runBatch(ids, (containerId) =>
        removeContainer(containerId, { force, removeVolumes: withVolumes }),
      ),
    successMessage: (outcome) => `已删除 ${outcome.succeeded.length} 个容器`,
    successDescription: (outcome) => failureSummary(outcome),
    errorMessage: '删除容器失败',
    invalidate: [listRoot, detailRoot, statsRoot, stacksRoot, stackDetailRoot],
  });

  const actionBusy =
    actionMutation.isPending &&
    actionMutation.variables !== undefined &&
    actionMutation.variables.ids.length === 1
      ? { id: actionMutation.variables.ids[0] ?? '', action: actionMutation.variables.action }
      : null;
  const actionsDisabled = actionMutation.isPending || removeMutation.isPending;

  const openDetail = (containerId: string): void => {
    setDetailTab('overview');
    navigate(`/containers/${encodeURIComponent(containerId)}`);
  };

  const openLogs = (containerId: string): void => {
    setDetailTab('logs');
    navigate(`/containers/${encodeURIComponent(containerId)}`);
  };

  const restartDetail = (): void => {
    if (id === undefined) return;
    void actionMutation
      .mutateAsync({ ids: [id], action: 'restart' })
      .then(() => {
        setDetailTab('overview');
      })
      .catch(() => undefined);
  };

  const handleRowAction = (containerId: string, action: ContainerAction): void => {
    void actionMutation.mutateAsync({ ids: [containerId], action }).catch(() => undefined);
  };

  const requestRemove = (ids: string[]): void => {
    setForceRemove(false);
    setRemoveVolumes(false);
    setConfirm({ action: 'remove', ids });
  };

  const openBatchConfirm = (action: ContainerAction): void => {
    if (selectedIds.size === 0) return;
    setConfirm({ action, ids: Array.from(selectedIds) });
  };

  const toggleSelect = (containerId: string, checked: boolean): void => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      if (checked) next.add(containerId);
      else next.delete(containerId);
      return next;
    });
  };

  const toggleAll = (checked: boolean): void => {
    setSelectedIds((previous) => {
      const next = new Set(previous);
      for (const container of filtered) {
        if (checked) next.add(container.id);
        else next.delete(container.id);
      }
      return next;
    });
  };

  const handleConfirm = async (): Promise<void> => {
    if (confirm === null) return;
    if (confirm.action === 'remove') {
      const outcome = await removeMutation.mutateAsync({
        ids: confirm.ids,
        force: forceRemove,
        removeVolumes,
      });
      setSelectedIds((previous) => {
        const next = new Set(previous);
        for (const containerId of outcome.succeeded) next.delete(containerId);
        return next;
      });
      setConfirm(null);
      return;
    }
    await actionMutation.mutateAsync({ ids: confirm.ids, action: confirm.action });
    setConfirm(null);
  };

  const confirmNames = (confirm?.ids ?? []).slice(0, 6).map((containerId) => {
    const found = containers.find((container) => container.id === containerId);
    return found === undefined ? containerShortId(containerId) : containerName(found);
  });
  const confirmRest = (confirm?.ids.length ?? 0) - confirmNames.length;

  return (
    <div>
      <PageHeader
        title="容器"
        description="查看 Docker 容器状态、资源占用，执行启停、日志与统计操作。"
        actions={
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw className="h-4 w-4" />}
            loading={listQuery.isFetching}
            onClick={() => {
              void listQuery.refetch();
            }}
          >
            刷新
          </Button>
        }
      />
      <ContainerTabs />

      {unavailable ? (
        <UnavailableAlert
          available={listQuery.data?.available === false}
          error={listQuery.data === undefined ? listQuery.error : undefined}
          reason={listQuery.data?.reason}
          title="Docker 不可用"
          hint="请确认目标机器已安装 docker CLI、daemon 正在运行，且 worker 进程有权限访问 /var/run/docker.sock。"
          action={
            <Button
              variant="secondary"
              size="sm"
              loading={listQuery.isFetching}
              onClick={() => {
                void listQuery.refetch();
              }}
            >
              重新探测
            </Button>
          }
        />
      ) : listQuery.error !== null && listQuery.error !== undefined && listQuery.data === undefined ? (
        <ErrorState
          error={listQuery.error}
          onRetry={() => {
            void listQuery.refetch();
          }}
        />
      ) : (
        <>
          {listQuery.error !== null && listQuery.error !== undefined ? (
            <Alert tone="warning" title="容器列表刷新失败" className="mb-3">
              {describeError(listQuery.error).description}
            </Alert>
          ) : null}

          <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="容器总数"
              value={listQuery.data?.total ?? containers.length}
              hint={
                listQuery.data?.nextCursor === null || listQuery.data?.nextCursor === undefined
                  ? '当前连接中的全部容器'
                  : `已加载 ${containers.length} 个，可继续筛选`
              }
              icon={<Boxes className="h-4 w-4" />}
              loading={listQuery.isLoading}
            />
            <StatCard
              label="运行中"
              value={runningCount}
              hint={`已停止 ${containers.length - runningCount} 个`}
              icon={<Activity className="h-4 w-4" />}
              tone="success"
              loading={listQuery.isLoading}
            />
            <StatCard
              label="CPU 总占用"
              value={totals.sampled > 0 ? formatPercent(totals.cpuPercent) : '—'}
              hint={
                runningIds.length >= MAX_POLLED_CONTAINERS
                  ? `仅统计前 ${MAX_POLLED_CONTAINERS} 个运行中容器，每 5 秒刷新`
                  : `已采样 ${totals.sampled} 个运行中容器，每 5 秒刷新`
              }
              icon={<Cpu className="h-4 w-4" />}
              tone="info"
              loading={runningIds.length > 0 && totals.sampled === 0}
            />
            <StatCard
              label="内存总占用"
              value={totals.sampled > 0 ? formatBytes(totals.memoryBytes) : '—'}
              hint={
                totals.memoryLimitBytes > 0
                  ? `容器内存上限合计 ${formatBytes(totals.memoryLimitBytes)}`
                  : '尚无运行中容器的内存采样'
              }
              icon={<MemoryStick className="h-4 w-4" />}
              tone="warning"
              loading={runningIds.length > 0 && totals.sampled === 0}
            />
          </div>

          <Toolbar
            left={
              <>
                <SearchInput
                  value={search}
                  onChange={setSearch}
                  placeholder="搜索名称、镜像或 compose 项目…"
                  className="w-64"
                />
                <Select
                  aria-label="状态筛选"
                  className="w-32"
                  options={STATUS_OPTIONS}
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
                />
                {selectedIds.size > 0 ? (
                  <span className="text-xs text-app-muted">已选择 {selectedIds.size} 个</span>
                ) : null}
                {actionMutation.isPending ? <Spinner size="xs" label="操作执行中" /> : null}
              </>
            }
            right={
              <>
                <Button
                  variant="secondary"
                  size="xs"
                  icon={<Play className="h-3.5 w-3.5" />}
                  disabled={selectedIds.size === 0 || actionsDisabled}
                  onClick={() => openBatchConfirm('start')}
                >
                  批量启动
                </Button>
                <Button
                  variant="secondary"
                  size="xs"
                  icon={<Square className="h-3.5 w-3.5" />}
                  disabled={selectedIds.size === 0 || actionsDisabled}
                  onClick={() => openBatchConfirm('stop')}
                >
                  批量停止
                </Button>
                <Button
                  variant="secondary"
                  size="xs"
                  icon={<RotateCw className="h-3.5 w-3.5" />}
                  disabled={selectedIds.size === 0 || actionsDisabled}
                  onClick={() => openBatchConfirm('restart')}
                >
                  批量重启
                </Button>
                <Button
                  variant="danger"
                  size="xs"
                  icon={<Trash2 className="h-3.5 w-3.5" />}
                  disabled={selectedIds.size === 0 || actionsDisabled}
                  onClick={() => requestRemove(Array.from(selectedIds))}
                >
                  批量删除
                </Button>
              </>
            }
          />

          <ContainerTable
            items={filtered}
            loading={listQuery.isLoading}
            onOpen={openDetail}
            onAction={handleRowAction}
            onRemove={(containerId) => requestRemove([containerId])}
            onOpenLogs={openLogs}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
            onToggleAll={toggleAll}
            statsById={stats.statsById}
            historyById={stats.historyById}
            actionBusy={actionBusy}
            actionsDisabled={actionsDisabled}
            footer={
              <span>
                显示 {filtered.length} / {containers.length} 个容器
                {listQuery.data?.nextCursor !== null && listQuery.data?.nextCursor !== undefined
                  ? '；结果已截断，请用搜索或状态筛选缩小范围'
                  : ''}
              </span>
            }
            empty={
              search.trim().length > 0
                ? '没有匹配的容器，请调整搜索关键词。'
                : statusFilter === 'all'
                  ? 'Docker 中没有容器。可前往「编排」启动 compose 项目，或用镜像创建容器。'
                  : `当前没有「${STATUS_OPTIONS.find((option) => option.value === statusFilter)?.label ?? statusFilter}」状态的容器。`
            }
          />
        </>
      )}

      {id === undefined ? null : (
        <ContainerDetailDrawer
          id={id}
          initialTab={detailTab}
          onClose={() => navigate('/containers')}
          onRestart={restartDetail}
          restarting={actionMutation.isPending}
        />
      )}

      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm === null
            ? ''
            : confirm.action === 'remove'
              ? confirm.ids.length > 1
                ? `删除 ${confirm.ids.length} 个容器`
                : '删除容器'
              : `${confirm.ids.length > 1 ? '批量' : ''}${CONTAINER_ACTION_LABEL[confirm.action]}容器`
        }
        message={
          confirm === null ? null : (
            <div className="flex flex-col gap-2">
              <p>
                {confirm.ids.length > 1
                  ? `确认对以下 ${confirm.ids.length} 个容器执行${confirm.action === 'remove' ? '删除' : CONTAINER_ACTION_LABEL[confirm.action]}操作？`
                  : `确认${confirm.action === 'remove' ? '删除' : CONTAINER_ACTION_LABEL[confirm.action]}容器 ${confirmNames[0] ?? ''}？`}
              </p>
              <p className="break-all rounded-md border border-app-border bg-app-elevated px-2 py-1 font-mono text-[11px]">
                {confirmNames.join('、')}
                {confirmRest > 0 ? ` 等 ${confirmRest} 个` : ''}
              </p>
              {confirm.action === 'remove' ? (
                <div className="flex flex-col gap-2 rounded-md border border-app-border bg-app-elevated/60 p-2">
                  <Checkbox
                    label="强制删除（force）"
                    description="运行中的容器会被强制终止后删除。"
                    checked={forceRemove}
                    onChange={(event) => setForceRemove(event.target.checked)}
                  />
                  <Checkbox
                    label="同时删除匿名卷（removeVolumes）"
                    description="请确认数据不需要保留。"
                    checked={removeVolumes}
                    onChange={(event) => setRemoveVolumes(event.target.checked)}
                  />
                </div>
              ) : (
                <p className="text-xs">
                  操作会依次调用 Docker API；若个别容器失败，其余仍会继续执行。
                </p>
              )}
            </div>
          )
        }
        confirmLabel={confirm?.action === 'remove' ? '确认删除' : '确认执行'}
        danger={confirm?.action === 'remove' || confirm?.action === 'stop'}
        loading={actionMutation.isPending || removeMutation.isPending}
        onConfirm={handleConfirm}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}

async function runBatch(
  ids: readonly string[],
  run: (id: string) => Promise<unknown>,
): Promise<BatchOutcome> {
  const results = await Promise.allSettled(ids.map((id) => run(id)));
  const succeeded: string[] = [];
  const failed: { id: string; error: unknown }[] = [];
  results.forEach((result, index) => {
    const containerId = ids[index] ?? '';
    if (result.status === 'fulfilled') succeeded.push(containerId);
    else failed.push({ id: containerId, error: result.reason });
  });
  if (succeeded.length === 0 && failed.length > 0) {
    throw failed[0]?.error ?? new Error('批量操作全部失败');
  }
  return { succeeded, failed };
}

function failureSummary(outcome: BatchOutcome): string | undefined {
  if (outcome.failed.length === 0) return undefined;
  const ids = outcome.failed.slice(0, 4).map((item) => containerShortId(item.id)).join('、');
  return `失败 ${outcome.failed.length} 个：${ids}${outcome.failed.length > 4 ? '…' : ''}`;
}
