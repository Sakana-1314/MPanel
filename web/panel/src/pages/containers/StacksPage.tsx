import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Container as ContainerIcon,
  Download,
  Layers,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  ScrollText,
  Square,
  Trash2,
} from 'lucide-react';
import type { StackSummary } from '../../api/types';
import { containersKeys, listStacks } from '../../api/containers';
import { describeError, isAppError } from '../../api/errors';
import { formatDate } from '../../lib/format';
import { Alert, UnavailableAlert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { ErrorState } from '../../components/ui/ErrorState';
import { PageHeader } from '../../components/ui/PageHeader';
import { RelativeTime } from '../../components/ui/RelativeTime';
import { SearchInput } from '../../components/ui/SearchInput';
import { StatCard } from '../../components/ui/Card';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { Toolbar } from '../../components/ui/Toolbar';
import { Tooltip } from '../../components/ui/Tooltip';
import { ContainerTabs } from './ContainerTabs';
import { StackLogsDrawer } from './StackLogsDrawer';
import {
  StackPullProgressBanner,
  useStackActions,
  type StackBusyState,
} from './useStackActions';
import {
  stackComposeFile,
  stackStatusLabel,
  stackStatusTone,
  stackWorkingDir,
} from './stack-utils';

type ConfirmState =
  | { kind: 'down'; stack: StackSummary }
  | { kind: 'remove'; stack: StackSummary };

export default function StacksPage(): JSX.Element {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [removeVolumes, setRemoveVolumes] = useState(false);
  const [removeImages, setRemoveImages] = useState(false);
  const [forceDelete, setForceDelete] = useState(false);
  const [logsName, setLogsName] = useState<string | null>(null);

  const actions = useStackActions();

  const stacksQuery = useQuery({
    queryKey: containersKeys.stacks(),
    queryFn: () => listStacks({ limit: 200 }),
    refetchInterval: 20_000,
    retry: 1,
  });

  const stacks = stacksQuery.data?.items ?? [];
  const unavailable =
    stacksQuery.data?.available === false || isAppError(stacksQuery.error, 'UNAVAILABLE');

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (needle.length === 0) return stacks;
    return stacks.filter((stack) =>
      [
        stack.name,
        stack.status,
        stackStatusLabel(stack.status),
        stackComposeFile(stack.configFiles),
        stackWorkingDir(stack.configFiles),
      ].some((value) =>
        value.toLowerCase().includes(needle),
      ),
    );
  }, [stacks, search]);

  const totals = useMemo(() => {
    let containers = 0;
    let running = 0;
    for (const stack of stacks) {
      containers += stack.containerCount;
      running += stack.runningCount;
    }
    return { containers, running, stopped: Math.max(containers - running, 0) };
  }, [stacks]);

  const openDetail = (name: string): void => {
    navigate(`/stacks/${encodeURIComponent(name)}`);
  };
  const openEditor = (name: string): void => {
    navigate(`/stacks/${encodeURIComponent(name)}/edit`);
  };

  const requestDown = (stack: StackSummary): void => {
    setRemoveVolumes(false);
    setRemoveImages(false);
    setConfirmState({ kind: 'down', stack });
  };

  const requestRemove = (stack: StackSummary): void => {
    setForceDelete(false);
    setConfirmState({ kind: 'remove', stack });
  };

  const handleConfirm = async (): Promise<void> => {
    if (confirmState === null) return;
    if (confirmState.kind === 'down') {
      await actions.runAction(confirmState.stack.name, 'down', { removeVolumes, removeImages });
      setConfirmState(null);
      return;
    }
    await actions.remove(confirmState.stack.name, forceDelete);
    setConfirmState(null);
  };

  const columns: Column<StackSummary>[] = [
    {
      key: 'name',
      header: '项目名',
      sortable: true,
      sortValue: (stack) => stack.name,
      render: (stack) => (
        <div className="min-w-0">
          <p className="max-w-[16rem] truncate font-mono text-xs font-medium text-app-text" title={stack.name}>
            {stack.name}
          </p>
          <p className="max-w-[16rem] truncate text-[10px] text-app-muted" title={stackComposeFile(stack.configFiles)}>
            {stackComposeFile(stack.configFiles)}
          </p>
        </div>
      ),
    },
    {
      key: 'status',
      header: '状态',
      sortable: true,
      sortValue: (stack) => stack.status,
      render: (stack) => (
        <StatusBadge
          status={stack.status}
          tone={stackStatusTone(stack.status)}
          label={stackStatusLabel(stack.status)}
          size="sm"
          title={stack.status}
        />
      ),
    },
    {
      key: 'containers',
      header: '容器数',
      align: 'center',
      sortable: true,
      sortValue: (stack) => stack.runningCount,
      render: (stack) => (
        <div className="flex flex-col items-center gap-0.5">
          <span className="tabular-nums text-xs text-app-text">
            {stack.runningCount} / {stack.containerCount}
          </span>
          <Badge tone={stack.runningCount === stack.containerCount && stack.containerCount > 0 ? 'success' : 'neutral'}>
            {stack.runningCount === stack.containerCount && stack.containerCount > 0 ? '全部运行' : '部分运行'}
          </Badge>
        </div>
      ),
    },
    {
      key: 'workingDir',
      header: '工作目录',
      render: (stack) => {
        const dir = stackWorkingDir(stack.configFiles);
        return (
          <span className="block max-w-[18rem] truncate font-mono text-[11px] text-app-muted" title={dir}>
            {dir}
          </span>
        );
      },
    },
    {
      key: 'updatedAt',
      header: '更新时间',
      sortable: true,
      sortValue: (stack) => stack.updatedAt ?? null,
      render: (stack) => (
        <span className="whitespace-nowrap text-xs text-app-muted" title={formatDate(stack.updatedAt)}>
          {stack.updatedAt === undefined || stack.updatedAt === null ? (
            '—'
          ) : (
            <RelativeTime value={stack.updatedAt} />
          )}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '操作',
      align: 'right',
      width: 248,
      render: (stack) => (
        <StackRowActions
          stack={stack}
          busy={actions.busy}
          onUp={() => {
            void actions.runAction(stack.name, 'up').catch(() => undefined);
          }}
          onDown={() => requestDown(stack)}
          onRestart={() => {
            void actions.runAction(stack.name, 'restart').catch(() => undefined);
          }}
          onPull={() => {
            void actions.pull(stack.name).catch(() => undefined);
          }}
          onLogs={() => setLogsName(stack.name)}
          onEdit={() => openEditor(stack.name)}
          onRemove={() => requestRemove(stack)}
        />
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="编排"
        description="管理 docker compose 项目：启动、停止、重启、拉取镜像与查看聚合日志。"
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw className="h-4 w-4" />}
              loading={stacksQuery.isFetching}
              onClick={() => {
                void stacksQuery.refetch();
              }}
            >
              刷新
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<Plus className="h-4 w-4" />}
              disabled={unavailable}
              onClick={() => navigate('/stacks/new/edit?create=1')}
            >
              新建编排
            </Button>
          </>
        }
      />
      <ContainerTabs />

      {unavailable ? (
        <UnavailableAlert
          available={stacksQuery.data?.available === false}
          error={stacksQuery.data === undefined ? stacksQuery.error : undefined}
          reason={stacksQuery.data?.reason}
          title="Docker 不可用"
          hint="编排依赖 docker compose v2；请确认目标机器已安装 docker CLI/compose 插件且 daemon 正在运行。"
          action={
            <Button
              variant="secondary"
              size="sm"
              loading={stacksQuery.isFetching}
              onClick={() => {
                void stacksQuery.refetch();
              }}
            >
              重新探测
            </Button>
          }
        />
      ) : stacksQuery.error !== null &&
        stacksQuery.error !== undefined &&
        stacksQuery.data === undefined ? (
        <ErrorState
          error={stacksQuery.error}
          onRetry={() => {
            void stacksQuery.refetch();
          }}
        />
      ) : (
        <>
          {stacksQuery.error !== null && stacksQuery.error !== undefined ? (
            <Alert tone="warning" title="编排列表刷新失败" className="mb-3">
              {describeError(stacksQuery.error).description}
            </Alert>
          ) : null}

          <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="编排项目"
              value={stacksQuery.data?.total ?? stacks.length}
              hint="存储于 $MPANEL_HOME/stacks"
              icon={<Layers className="h-4 w-4" />}
              loading={stacksQuery.isLoading}
            />
            <StatCard
              label="容器总数"
              value={totals.containers}
              hint="所有项目的容器合计"
              icon={<ContainerIcon className="h-4 w-4" />}
              tone="info"
              loading={stacksQuery.isLoading}
            />
            <StatCard
              label="运行中容器"
              value={totals.running}
              hint={`未运行 ${totals.stopped} 个`}
              icon={<Activity className="h-4 w-4" />}
              tone="success"
              loading={stacksQuery.isLoading}
            />
            <StatCard
              label="未运行容器"
              value={totals.stopped}
              hint="已停止或已退出"
              icon={<Square className="h-4 w-4" />}
              tone={totals.stopped > 0 ? 'warning' : 'neutral'}
              loading={stacksQuery.isLoading}
            />
          </div>

          {actions.busy?.operation === 'pull' && actions.pullProgress === null ? (
            <Alert tone="info" title={`正在拉取 ${actions.busy.name} 的编排镜像`} className="mb-3">
              优先执行 docker compose pull（同步，最长约 10 分钟）；agent 不支持时会改为逐个拉取 compose 中的静态镜像。
            </Alert>
          ) : (
            <StackPullProgressBanner progress={actions.pullProgress} />
          )}

          <Toolbar
            left={
              <SearchInput
                value={search}
                onChange={setSearch}
                placeholder="搜索项目名、状态或配置文件…"
                className="w-72"
              />
            }
            right={
              <span className="text-xs text-app-muted">
                显示 {filtered.length} 个编排
                {stacksQuery.data?.nextCursor !== null && stacksQuery.data?.nextCursor !== undefined
                  ? '（结果已截断）'
                  : ''}
              </span>
            }
          />

          <DataTable
            columns={columns}
            rows={filtered}
            rowKey={(stack) => stack.name}
            loading={stacksQuery.isLoading}
            onRowClick={(stack) => openDetail(stack.name)}
            dense
            empty={
              search.trim().length > 0
                ? '没有匹配的编排项目，请调整搜索关键词。'
                : '还没有编排项目。点击右上角「新建编排」编写 compose 文件。'
            }
          />
        </>
      )}

      <StackLogsDrawer
        open={logsName !== null}
        name={logsName}
        onClose={() => setLogsName(null)}
      />

      <ConfirmDialog
        open={confirmState !== null}
        title={confirmState?.kind === 'remove' ? '删除编排项目' : '停止编排项目'}
        message={
          confirmState === null ? null : (
            <div className="flex flex-col gap-2">
              <p>
                项目 <span className="font-mono text-app-text">{confirmState.stack.name}</span>
                {confirmState.kind === 'down'
                  ? ' 将执行 docker compose down，停止并移除项目容器与网络。'
                  : ' 只会删除 compose 文件，不会停止容器。'}
              </p>
              {confirmState.kind === 'down' ? (
                <div className="flex flex-col gap-2 rounded-md border border-app-border bg-app-elevated/60 p-2">
                  <Checkbox
                    label="删除数据卷（removeVolumes）"
                    description="docker compose down -v，会删除项目声明的卷，请确认数据可丢弃。"
                    checked={removeVolumes}
                    onChange={(event) => setRemoveVolumes(event.target.checked)}
                  />
                  <Checkbox
                    label="删除镜像（removeImages）"
                    description="docker compose down --rmi all，可能影响其他项目复用的镜像。"
                    checked={removeImages}
                    onChange={(event) => setRemoveImages(event.target.checked)}
                  />
                </div>
              ) : (
                <div className="flex flex-col gap-2 rounded-md border border-app-border bg-app-elevated/60 p-2">
                  <Checkbox
                    label="强制删除文件（force）"
                    description={
                      confirmState.stack.runningCount > 0
                        ? `项目仍有 ${confirmState.stack.runningCount} 个运行中容器；不勾选时后端会返回冲突。`
                        : '容器未运行时可直接删除。'
                    }
                    checked={forceDelete}
                    onChange={(event) => setForceDelete(event.target.checked)}
                  />
                  <p className="text-xs">
                    删除后编排配置不可恢复；请先在详情页确认 compose 文件内容。
                  </p>
                </div>
              )}
            </div>
          )
        }
        confirmLabel={confirmState?.kind === 'remove' ? '确认删除' : '确认停止'}
        danger
        loading={actions.busy !== null}
        onConfirm={handleConfirm}
        onCancel={() => setConfirmState(null)}
      />
    </div>
  );
}

function StackRowActions(props: {
  stack: StackSummary;
  busy: StackBusyState | null;
  onUp(): void;
  onDown(): void;
  onRestart(): void;
  onPull(): void;
  onLogs(): void;
  onEdit(): void;
  onRemove(): void;
}): JSX.Element {
  const rowBusy = props.busy?.name === props.stack.name ? props.busy.operation : null;
  const disabled = props.busy !== null;
  const empty = props.stack.containerCount === 0;
  return (
    <div className="flex items-center justify-end gap-0.5" onClick={(event) => event.stopPropagation()}>
      <Tooltip content="启动（compose up）">
        <Button
          aria-label="启动编排"
          variant="ghost"
          size="icon"
          disabled={disabled}
          loading={rowBusy === 'up'}
          onClick={props.onUp}
          icon={<Play className="h-3.5 w-3.5" />}
        />
      </Tooltip>
      <Tooltip content="停止（compose down）">
        <Button
          aria-label="停止编排"
          variant="ghost"
          size="icon"
          disabled={disabled || empty}
          loading={rowBusy === 'down'}
          onClick={props.onDown}
          icon={<Square className="h-3.5 w-3.5" />}
        />
      </Tooltip>
      <Tooltip content="重启（compose restart）">
        <Button
          aria-label="重启编排"
          variant="ghost"
          size="icon"
          disabled={disabled || empty}
          loading={rowBusy === 'restart'}
          onClick={props.onRestart}
          icon={<RotateCw className="h-3.5 w-3.5" />}
        />
      </Tooltip>
      <Tooltip content="拉取镜像">
        <Button
          aria-label="拉取镜像"
          variant="ghost"
          size="icon"
          disabled={disabled}
          loading={rowBusy === 'pull'}
          onClick={props.onPull}
          icon={<Download className="h-3.5 w-3.5" />}
        />
      </Tooltip>
      <Tooltip content="聚合日志">
        <Button
          aria-label="聚合日志"
          variant="ghost"
          size="icon"
          disabled={disabled || empty}
          onClick={props.onLogs}
          icon={<ScrollText className="h-3.5 w-3.5" />}
        />
      </Tooltip>
      <Tooltip content="编辑 compose">
        <Button
          aria-label="编辑 compose"
          variant="ghost"
          size="icon"
          disabled={disabled}
          onClick={props.onEdit}
          icon={<Pencil className="h-3.5 w-3.5" />}
        />
      </Tooltip>
      <Tooltip content="删除编排">
        <Button
          aria-label="删除编排"
          variant="ghost"
          size="icon"
          disabled={disabled}
          loading={rowBusy === 'remove'}
          onClick={props.onRemove}
          icon={<Trash2 className="h-3.5 w-3.5 text-app-danger" />}
        />
      </Tooltip>
    </div>
  );
}
