import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Container as ContainerIcon,
  Download,
  Layers,
  Pencil,
  Play,
  RefreshCw,
  RotateCw,
  Square,
  Trash2,
} from 'lucide-react';
import type { ContainerSummary, StackDetail } from '../../api/types';
import { containersKeys, getStack } from '../../api/containers';
import { isAppError } from '../../api/errors';
import { formatDate, formatRelativeTime } from '../../lib/format';
import { Alert, UnavailableAlert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardHeader, StatCard } from '../../components/ui/Card';
import { Checkbox } from '../../components/ui/Checkbox';
import { CodeEditor } from '../../components/ui/CodeEditor';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { CopyButton } from '../../components/ui/CopyButton';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { ErrorState, LoadingSkeleton } from '../../components/ui/ErrorState';
import { PageHeader } from '../../components/ui/PageHeader';
import { RelativeTime } from '../../components/ui/RelativeTime';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { Tabs } from '../../components/ui/Tabs';
import { Toolbar } from '../../components/ui/Toolbar';
import { formatPorts, containerName, containerShortId, containerStateLabel } from './container-utils';
import { StackLogsPanel } from './StackLogsPanel';
import {
  StackPullProgressBanner,
  useStackActions,
} from './useStackActions';
import {
  stackComposeFile,
  stackStatusLabel,
  stackStatusTone,
  stackWorkingDir,
} from './stack-utils';

type DetailTab = 'containers' | 'compose' | 'logs';

const TABS = [
  { id: 'containers', label: '容器' },
  { id: 'compose', label: 'compose 文件' },
  { id: 'logs', label: '聚合日志' },
] as const;

export default function StackDetailPage(): JSX.Element {
  const params = useParams<{ name: string }>();
  const navigate = useNavigate();
  const name = params.name ?? '';
  const [tab, setTab] = useState<DetailTab>('containers');
  const [confirm, setConfirm] = useState<'down' | 'remove' | null>(null);
  const [removeVolumes, setRemoveVolumes] = useState(false);
  const [removeImages, setRemoveImages] = useState(false);
  const [forceDelete, setForceDelete] = useState(false);

  const actions = useStackActions({
    onRemoved: () => navigate('/stacks'),
  });

  const stackQuery = useQuery({
    queryKey: containersKeys.stack(name),
    queryFn: () => getStack(name),
    enabled: name.length > 0,
    refetchInterval: 20_000,
    retry: 1,
  });

  const stack = stackQuery.data;

  const openContainer = (containerId: string): void => {
    navigate(`/containers/${encodeURIComponent(containerId)}`);
  };

  const handleConfirm = async (): Promise<void> => {
    if (confirm === null) return;
    if (confirm === 'down') {
      await actions.runAction(name, 'down', { removeVolumes, removeImages });
      setConfirm(null);
      return;
    }
    await actions.remove(name, forceDelete);
    setConfirm(null);
  };

  const columns: Column<ContainerSummary>[] = [
    {
      key: 'name',
      header: '名称',
      sortable: true,
      sortValue: (container) => containerName(container),
      render: (container) => (
        <div className="min-w-0">
          <p className="max-w-[16rem] truncate font-medium text-app-text" title={containerName(container)}>
            {containerName(container)}
          </p>
          <span className="font-mono text-[10px] text-app-muted">{containerShortId(container.id)}</span>
        </div>
      ),
    },
    {
      key: 'service',
      header: '服务',
      render: (container) => (
        <span className="font-mono text-[11px] text-app-muted">{container.composeService ?? '—'}</span>
      ),
    },
    {
      key: 'image',
      header: '镜像',
      sortable: true,
      sortValue: (container) => container.image,
      render: (container) => (
        <span className="block max-w-[18rem] truncate font-mono text-[11px] text-app-muted" title={container.image}>
          {container.image}
        </span>
      ),
    },
    {
      key: 'state',
      header: '状态',
      sortable: true,
      sortValue: (container) => container.state,
      render: (container) => (
        <StatusBadge
          status={container.state}
          label={containerStateLabel(container.state)}
          size="sm"
          title={container.status}
        />
      ),
    },
    {
      key: 'ports',
      header: '端口',
      render: (container) => (
        <span
          className="block max-w-[16rem] truncate font-mono text-[10.5px] text-app-muted"
          title={formatPorts(container.ports)}
        >
          {formatPorts(container.ports)}
        </span>
      ),
    },
    {
      key: 'created',
      header: '创建时间',
      sortable: true,
      sortValue: (container) => container.created,
      render: (container) => (
        <span className="whitespace-nowrap text-xs text-app-muted" title={formatDate(container.created)}>
          <RelativeTime value={container.created} />
        </span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title={name.length === 0 ? '编排详情' : name}
        description="查看项目容器、compose 文件与聚合日志。"
        breadcrumbs={
          <>
            <Link to="/stacks" className="hover:text-app-text">
              编排
            </Link>
            <span className="mx-1">/</span>
            <span className="font-mono">{name}</span>
          </>
        }
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw className="h-4 w-4" />}
              loading={stackQuery.isFetching}
              onClick={() => {
                void stackQuery.refetch();
              }}
            >
              刷新
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<Pencil className="h-4 w-4" />}
              disabled={stack === undefined}
              onClick={() => navigate(`/stacks/${encodeURIComponent(name)}/edit`)}
            >
              编辑
            </Button>
            <Button
              variant="danger"
              size="sm"
              icon={<Trash2 className="h-4 w-4" />}
              disabled={stack === undefined || actions.busy !== null}
              onClick={() => {
                setForceDelete(false);
                setConfirm('remove');
              }}
            >
              删除
            </Button>
          </>
        }
      />

      {isAppError(stackQuery.error, 'UNAVAILABLE') ? (
        <UnavailableAlert
          error={stackQuery.error}
          title="Docker 不可用"
          hint="请确认目标机器的 Docker daemon 与 compose 插件可用后重试。"
        />
      ) : stackQuery.error !== null && stackQuery.error !== undefined ? (
        <ErrorState
          error={stackQuery.error}
          onRetry={() => {
            void stackQuery.refetch();
          }}
        />
      ) : stackQuery.isLoading || stack === undefined ? (
        <LoadingSkeleton rows={6} />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge
              status={stack.status}
              tone={stackStatusTone(stack.status)}
              label={stackStatusLabel(stack.status)}
              title={stack.status}
            />
            <Badge tone="neutral" title={stack.status}>
              docker compose：{stack.status}
            </Badge>
            <span className="text-xs text-app-muted" title={stackComposeFile(stack.configFiles, stack.composePath)}>
              配置文件 {stackComposeFile(stack.configFiles, stack.composePath)}
            </span>
            <span className="text-xs text-app-muted">
              工作目录 <span className="font-mono">{stackWorkingDir(stack.configFiles, stack.composePath)}</span>
            </span>
            {stack.updatedAt === undefined || stack.updatedAt === null ? null : (
              <span className="text-xs text-app-muted">
                更新于 {formatRelativeTime(stack.updatedAt)}
              </span>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="容器总数"
              value={stack.containerCount}
              icon={<ContainerIcon className="h-4 w-4" />}
              tone="info"
            />
            <StatCard
              label="运行中"
              value={stack.runningCount}
              hint={`未运行 ${Math.max(stack.containerCount - stack.runningCount, 0)} 个`}
              icon={<Activity className="h-4 w-4" />}
              tone="success"
            />
            <StatCard label="编排状态" value={stackStatusLabel(stack.status)} icon={<Layers className="h-4 w-4" />} />
            <StatCard
              label="更新时间"
              value={stack.updatedAt === undefined || stack.updatedAt === null ? '—' : <RelativeTime value={stack.updatedAt} />}
              hint={formatDate(stack.updatedAt)}
              icon={<RefreshCw className="h-4 w-4" />}
            />
          </div>

          <Toolbar
            left={
              <Tabs
                tabs={TABS.map((item) => ({ id: item.id, label: item.label }))}
                active={tab}
                onChange={(next) => setTab(next as DetailTab)}
                compact
                className="border-b-0 pb-0"
              />
            }
            right={
              <>
                <Button
                  variant="secondary"
                  size="xs"
                  icon={<Play className="h-3.5 w-3.5" />}
                  loading={actions.busy?.name === name && actions.busy.operation === 'up'}
                  disabled={actions.busy !== null}
                  onClick={() => {
                    void actions.runAction(name, 'up').catch(() => undefined);
                  }}
                >
                  启动
                </Button>
                <Button
                  variant="secondary"
                  size="xs"
                  icon={<Square className="h-3.5 w-3.5" />}
                  loading={actions.busy?.name === name && actions.busy.operation === 'down'}
                  disabled={
                    stack.containerCount === 0 ||
                    actions.busy !== null
                  }
                  onClick={() => {
                    setRemoveVolumes(false);
                    setRemoveImages(false);
                    setConfirm('down');
                  }}
                >
                  停止
                </Button>
                <Button
                  variant="secondary"
                  size="xs"
                  icon={<RotateCw className="h-3.5 w-3.5" />}
                  loading={actions.busy?.name === name && actions.busy.operation === 'restart'}
                  disabled={
                    stack.containerCount === 0 ||
                    actions.busy !== null
                  }
                  onClick={() => {
                    void actions.runAction(name, 'restart').catch(() => undefined);
                  }}
                >
                  重启
                </Button>
                <Button
                  variant="secondary"
                  size="xs"
                  icon={<Download className="h-3.5 w-3.5" />}
                  loading={actions.busy?.name === name && actions.busy.operation === 'pull'}
                  disabled={actions.busy !== null}
                  onClick={() => {
                    void actions.pull(name).catch(() => undefined);
                  }}
                >
                  拉取镜像
                </Button>
              </>
            }
          />

          {actions.busy?.operation === 'pull' && actions.pullProgress === null ? (
            <Alert tone="info" title="正在拉取编排镜像">
              优先执行 docker compose pull（同步，最长约 10 分钟）；worker 不支持时会改为逐个拉取 compose 中的静态镜像。
            </Alert>
          ) : (
            <StackPullProgressBanner progress={actions.pullProgress} />
          )}

          {tab === 'containers' ? (
            <DataTable
              columns={columns}
              rows={stack.containers}
              rowKey={(container) => container.id}
              onRowClick={(container) => openContainer(container.id)}
              dense
              empty={
                <div className="flex flex-col items-center gap-1">
                  <span className="text-sm text-app-text">项目还没有容器</span>
                  <span className="text-xs text-app-muted">点击「启动」执行 compose up 创建容器。</span>
                </div>
              }
              footer={<span>共 {stack.containers.length} 个容器，点击行打开容器详情与日志。</span>}
            />
          ) : null}

          {tab === 'compose' ? (
            <Card>
              <CardHeader
                title="compose 文件"
                description={stack.composePath}
                actions={
                  <CopyButton value={stack.composeYaml} label="复制 YAML" size="xs" variant="ghost" />
                }
              />
              <CardBody>
                <CodeEditor
                  value={stack.composeYaml}
                  readOnly
                  language="text"
                  height="56vh"
                  ariaLabel="compose YAML 内容"
                />
                <p className="mt-2 text-[10px] text-app-muted">
                  Compose YAML 属于可信属主功能，可挂载宿主目录或使用 privileged；请谨慎编辑。
                </p>
              </CardBody>
            </Card>
          ) : null}

          {tab === 'logs' ? <StackLogsPanel key={stack.name} stack={stack} height="52vh" /> : null}
        </div>
      )}

      <ConfirmDialog
        open={confirm !== null}
        title={confirm === 'remove' ? '删除编排项目' : '停止编排项目'}
        message={
          confirm === null ? null : (
            <div className="flex flex-col gap-2">
              <p>
                项目 <span className="font-mono text-app-text">{name}</span>
                {confirm === 'down'
                  ? ' 将执行 docker compose down，停止并移除项目容器与网络。'
                  : ' 只会删除 compose 文件，不会停止容器。'}
              </p>
              {confirm === 'down' ? (
                <div className="flex flex-col gap-2 rounded-md border border-app-border bg-app-elevated/60 p-2">
                  <Checkbox
                    label="删除数据卷（removeVolumes）"
                    description="会删除项目声明的卷，请确认数据可丢弃。"
                    checked={removeVolumes}
                    onChange={(event) => setRemoveVolumes(event.target.checked)}
                  />
                  <Checkbox
                    label="删除镜像（removeImages）"
                    description="可能影响其他项目复用的镜像。"
                    checked={removeImages}
                    onChange={(event) => setRemoveImages(event.target.checked)}
                  />
                </div>
              ) : (
                <div className="flex flex-col gap-2 rounded-md border border-app-border bg-app-elevated/60 p-2">
                  <Checkbox
                    label="强制删除文件（force）"
                    description={
                      stack !== undefined && stack.runningCount > 0
                        ? `项目仍有 ${stack.runningCount} 个运行中容器；不勾选时后端会返回冲突。`
                        : '容器未运行时可直接删除。'
                    }
                    checked={forceDelete}
                    onChange={(event) => setForceDelete(event.target.checked)}
                  />
                </div>
              )}
            </div>
          )
        }
        confirmLabel={confirm === 'remove' ? '确认删除' : '确认停止'}
        danger
        loading={actions.busy !== null}
        onConfirm={handleConfirm}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
