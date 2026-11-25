import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  KeyRound,
  Pencil,
  Play,
  RefreshCw,
  Square,
  Trash2,
  Wifi,
} from 'lucide-react';
import type {
  CapabilityStatus,
  Machine,
  MachineEnrollment,
  MachineTestResult,
} from '../../api/types';
import {
  connectMachine,
  deleteMachine,
  disconnectMachine,
  getMachine,
  getMachineHealth,
  machinesKeys,
  rotateMachineSecret,
  testMachine,
} from '../../api/machines';
import { isAppError } from '../../api/errors';
import { useAppMutation, toastError } from '../../lib/mutations';
import { formatDate, formatDuration } from '../../lib/format';
import { EnrollmentDialog } from './EnrollmentDialog';
import { MachineFormDialog } from './MachineFormDialog';
import { Alert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { CopyButton } from '../../components/ui/CopyButton';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorState, Skeleton } from '../../components/ui/ErrorState';
import { PageHeader } from '../../components/ui/PageHeader';
import { RelativeTime } from '../../components/ui/RelativeTime';
import { Spinner } from '../../components/ui/Spinner';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { useToast } from '../../components/ui/Toast';

const CAPABILITY_LABEL: Record<string, string> = {
  caddy: 'Caddy',
  docker: 'Docker',
  postgres: 'PostgreSQL',
  redis: 'Redis',
  pty: 'PTY',
};

const TRANSPORT_HINT: Record<Machine['transport'], string> = {
  http: 'core 直连 worker 的 HTTP API（Bearer token）。',
  stdio: 'core 拉起本地 worker 进程，通过 stdio 帧通信；需要 MPANEL_ALLOW_STDIO=1。',
  'reverse-ws': 'worker 用一次性 secret 主动连回 core；core 不主动拨号，connect 仅允许重连。',
};

export default function MachineDetailPage(): JSX.Element {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();

  const [formOpen, setFormOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [testResult, setTestResult] = useState<MachineTestResult | null>(null);
  const [rotateEnrollment, setRotateEnrollment] = useState<MachineEnrollment | null>(null);

  const detail = useQuery({
    queryKey: machinesKeys.detail(id ?? 'missing'),
    queryFn: () => getMachine(id ?? ''),
    enabled: id !== undefined,
    retry: 1,
    refetchInterval: 20_000,
  });

  const health = useQuery({
    queryKey: machinesKeys.health(id ?? 'missing'),
    queryFn: () => getMachineHealth(id ?? ''),
    enabled: id !== undefined,
    retry: 1,
    refetchInterval: 20_000,
  });

  const machine = detail.data;

  const refreshAll = (): void => {
    void detail.refetch();
    void health.refetch();
  };

  const connectMutation = useAppMutation<Machine, Machine>({
    mutationFn: (target) => connectMachine(target.id),
    successMessage: (updated) => `已请求连接 ${updated.name}`,
    successDescription: (updated) =>
      updated.transport === 'reverse-ws'
        ? '已允许该机器重连；等待 worker 拨号。'
        : 'core 正在建立连接，可查看健康状态。',
    invalidate: [
      machinesKeys.list({ limit: 200 }),
      machinesKeys.detail(id ?? 'missing'),
      machinesKeys.health(id ?? 'missing'),
    ],
  });

  const disconnectMutation = useAppMutation<Machine, Machine>({
    mutationFn: (target) => disconnectMachine(target.id),
    successMessage: (updated) => `已断开 ${updated.name}`,
    successDescription: 'desiredState=stopped；reverse-ws 需要重新 connect 才能连回。',
    invalidate: [
      machinesKeys.list({ limit: 200 }),
      machinesKeys.detail(id ?? 'missing'),
      machinesKeys.health(id ?? 'missing'),
    ],
  });

  const testMutation = useMutation({
    mutationFn: (target: Machine) => testMachine(target.id),
    onSuccess: (result, target) => {
      setTestResult(result);
      if (result.reachable) {
        toast.success(
          '连接测试成功',
          result.info === undefined || result.info === null
            ? `${result.latencyMs ?? '?'} ms`
            : `${result.info.name} v${result.info.version} · ${result.latencyMs ?? '?'} ms`,
        );
      } else {
        toast.error('连接测试失败', result.error ?? `无法连接 ${target.name}`);
      }
      void queryClient.invalidateQueries({ queryKey: machinesKeys.detail(target.id) });
      void queryClient.invalidateQueries({ queryKey: machinesKeys.health(target.id) });
      void queryClient.invalidateQueries({ queryKey: machinesKeys.list({ limit: 200 }) });
    },
    onError: (error) => toastError(toast, error),
  });

  const rotateMutation = useAppMutation<
    { secret: string; workerEnv: Record<string, string> },
    Machine
  >({
    mutationFn: (target) => rotateMachineSecret(target.id),
    successMessage: '机器密钥已轮换',
    successDescription: '旧 secret 立即失效，现有 reverse 连接已关闭；新 secret 只显示一次。',
    invalidate: [
      machinesKeys.list({ limit: 200 }),
      machinesKeys.detail(id ?? 'missing'),
      machinesKeys.health(id ?? 'missing'),
    ],
    onSuccess: (result, target) => {
      setRotateEnrollment({
        machineId: target.id,
        url: target.endpoint ?? '',
        secret: result.secret,
        workerEnv: result.workerEnv,
      });
    },
  });

  const deleteMutation = useAppMutation<{ deleted: true }, Machine>({
    mutationFn: (target) => deleteMachine(target.id),
    successMessage: (_, target) => `已删除机器 ${target.name}`,
    invalidate: [machinesKeys.list({ limit: 200 })],
    onSuccess: () => {
      setDeleteOpen(false);
      navigate('/machines');
    },
  });

  if (id === undefined) {
    return (
      <EmptyState
        title="缺少机器 ID"
        description="请从机器列表进入。"
        action={
          <Link to="/machines">
            <Button size="sm" variant="secondary">
              返回机器列表
            </Button>
          </Link>
        }
      />
    );
  }

  if (detail.isLoading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton lines={2} />
        <div className="flex items-center gap-2 text-xs text-app-muted">
          <Spinner size="sm" label="加载机器…" />
        </div>
      </div>
    );
  }

  if (detail.isError) {
    if (isAppError(detail.error, 'NOT_FOUND')) {
      return (
        <EmptyState
          title="机器不存在"
          description="可能已被删除，或当前 core 连接不是创建它的那台。"
          action={
            <Link to="/machines">
              <Button size="sm" variant="secondary">
                返回机器列表
              </Button>
            </Link>
          }
        />
      );
    }
    return <ErrorState error={detail.error} onRetry={refreshAll} />;
  }

  if (machine === undefined) {
    return (
      <EmptyState
        title="机器不存在"
        description="请返回机器列表重新选择。"
        action={
          <Link to="/machines">
            <Button size="sm" variant="secondary">
              返回机器列表
            </Button>
          </Link>
        }
      />
    );
  }

  const running = machine.desiredState === 'running';
  const capabilities = machine.capabilities;
  const healthData = health.data;

  return (
    <div>
      <PageHeader
        breadcrumbs={
          <Link to="/machines" className="inline-flex items-center gap-1 text-app-muted hover:text-app-text">
            <ArrowLeft className="h-3 w-3" />
            机器列表
          </Link>
        }
        title={machine.name}
        description={TRANSPORT_HINT[machine.transport]}
        meta={
          <>
            <StatusBadge status={machine.status} />
            <Badge tone={machine.transport === 'reverse-ws' ? 'accent' : 'info'}>
              {machine.transport}
            </Badge>
            <Badge tone={machine.enabled ? 'success' : 'neutral'}>
              {machine.enabled ? '已启用' : '已禁用'}
            </Badge>
          </>
        }
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw className="h-3.5 w-3.5" />}
              onClick={refreshAll}
              loading={detail.isFetching || health.isFetching}
            >
              刷新
            </Button>
            {running ? (
              <Button
                variant="secondary"
                size="sm"
                icon={<Square className="h-3.5 w-3.5" />}
                loading={disconnectMutation.isPending}
                onClick={() => disconnectMutation.mutate(machine)}
              >
                断开
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                icon={<Play className="h-3.5 w-3.5" />}
                disabled={!machine.enabled}
                title={machine.enabled ? '设置 desiredState=running' : '请先在编辑中启用机器'}
                loading={connectMutation.isPending}
                onClick={() => connectMutation.mutate(machine)}
              >
                连接
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              icon={<Wifi className="h-3.5 w-3.5" />}
              loading={testMutation.isPending}
              onClick={() => testMutation.mutate(machine)}
            >
              测试连接
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<Pencil className="h-3.5 w-3.5" />}
              onClick={() => setFormOpen(true)}
            >
              编辑
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-app-danger"
              icon={<Trash2 className="h-3.5 w-3.5" />}
              onClick={() => setDeleteOpen(true)}
            >
              删除
            </Button>
          </>
        }
      />

      {machine.lastError === null || machine.lastError.length === 0 ? null : (
        <Alert tone="danger" title="机器最近一次错误" hint="可在健康面板查看连续失败次数与检查时间。" className="mb-3">
          {machine.lastError}
        </Alert>
      )}

      {testResult === null ? null : (
        <div className="mb-3">
          <Alert
            tone={testResult.reachable ? 'success' : 'danger'}
            title={testResult.reachable ? '连接测试成功' : '连接测试失败'}
            hint={
              testResult.reachable
                ? undefined
                : '请检查 worker 是否运行、URL/token 是否正确、网络与反向代理是否放行。'
            }
          >
            <div className="flex flex-col gap-1">
              <span>
                耗时 {testResult.latencyMs === null || testResult.latencyMs === undefined
                  ? '—'
                  : `${testResult.latencyMs} ms`}
                {testResult.error === undefined || testResult.reachable ? '' : ` · ${testResult.error}`}
              </span>
              {testResult.info === null || testResult.info === undefined ? null : (
                <span className="font-mono text-[11px]">
                  {testResult.info.name} v{testResult.info.version} · node {testResult.info.nodeVersion} ·{' '}
                  {testResult.info.platform}/{testResult.info.arch}
                </span>
              )}
            </div>
          </Alert>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="概况" description="凭据、命令与环境变量不会回显。" />
          <CardBody className="grid grid-cols-[7.5rem_1fr] gap-y-2 text-sm">
            <Row label="机器 ID">
              <span className="flex items-center gap-1">
                <span className="break-all font-mono text-xs">{machine.id}</span>
                <CopyButton value={machine.id} title="复制机器 ID" />
              </span>
            </Row>
            <Row label="传输">
              <Badge tone={machine.transport === 'reverse-ws' ? 'accent' : 'info'}>
                {machine.transport}
              </Badge>
            </Row>
            <Row label="端点">
              <span className="flex items-center gap-1">
                <span className="break-all font-mono text-xs">
                  {machine.endpoint ?? '（stdio 本地进程）'}
                </span>
                {machine.endpoint === null ? null : (
                  <CopyButton value={machine.endpoint} title="复制端点" />
                )}
              </span>
            </Row>
            <Row label="desiredState">
              <Badge tone={running ? 'success' : 'neutral'}>
                {machine.desiredState}
              </Badge>
            </Row>
            <Row label="token">
              <Badge tone={machine.hasToken ? 'success' : 'warning'}>
                {machine.hasToken ? '已保存' : '未保存'}
              </Badge>
            </Row>
            <Row label="最近心跳">
              <RelativeTime value={machine.lastSeenAt} />
            </Row>
            <Row label="重连次数">{machine.reconnectAttempts ?? 0}</Row>
            <Row label="创建时间">{formatDate(machine.createdAt)}</Row>
            <Row label="更新时间">{formatDate(machine.updatedAt)}</Row>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="健康"
            description="GET /machines/:id/health 返回快照，不主动探测。"
            actions={
              <Button
                variant="ghost"
                size="sm"
                icon={<RefreshCw className="h-3.5 w-3.5" />}
                loading={health.isFetching}
                onClick={() => {
                  void health.refetch();
                }}
              >
                刷新
              </Button>
            }
          />
          <CardBody>
            {health.isLoading ? (
              <div className="flex items-center justify-center py-6">
                <Spinner label="读取健康快照…" />
              </div>
            ) : health.isError ? (
              <ErrorState
                error={health.error}
                onRetry={() => {
                  void health.refetch();
                }}
              />
            ) : healthData === undefined ? (
              <p className="text-xs text-app-muted">暂无健康数据。</p>
            ) : (
              <dl className="grid grid-cols-[7.5rem_1fr] gap-y-2 text-sm">
                <Row label="状态">
                  <StatusBadge status={healthData.status} />
                </Row>
                <Row label="延迟">
                  {healthData.latencyMs === null || healthData.latencyMs === undefined
                    ? '—'
                    : formatDuration(healthData.latencyMs)}
                </Row>
                <Row label="连续失败">{healthData.consecutiveFailures}</Row>
                <Row label="最近心跳">
                  <RelativeTime value={healthData.lastSeenAt} />
                </Row>
                <Row label="检查时间">
                  <RelativeTime value={healthData.checkedAt} />
                </Row>
                <Row label="错误">
                  <span className="break-words text-xs text-app-danger">
                    {healthData.lastError ?? '—'}
                  </span>
                </Row>
              </dl>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Worker" description="worker 在 hello/心跳中上报的元数据。" />
          <CardBody>
            {machine.worker === null ? (
              <p className="text-xs text-app-muted">
                尚未收到 worker 的 hello 或心跳；在线后可在此看到版本与平台。
              </p>
            ) : (
              <dl className="grid grid-cols-[7.5rem_1fr] gap-y-2 text-sm">
                <Row label="名称">{machine.worker.name}</Row>
                <Row label="版本">{machine.worker.version}</Row>
                <Row label="API / 协议">
                  v{machine.worker.apiVersion} / v{machine.worker.protocolVersion}
                </Row>
                <Row label="Node">{machine.worker.nodeVersion}</Row>
                <Row label="平台">
                  {machine.worker.platform}/{machine.worker.arch}
                </Row>
              </dl>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="能力" description="来自 worker 的能力探测结果。" />
          <CardBody>
            {capabilities === null ? (
              <p className="text-xs text-app-muted">尚未上报能力信息。</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {Object.entries(CAPABILITY_LABEL).map(([key, label]) => {
                  const status = (capabilities as unknown as Record<string, CapabilityStatus>)[key];
                  if (status === undefined) return null;
                  return (
                    <li key={key} className="flex items-start justify-between gap-3">
                      <span className="text-sm text-app-text">{label}</span>
                      <span className="flex max-w-[70%] flex-col items-end gap-0.5 text-right">
                        <StatusBadge
                          status={status.available ? 'available' : 'unavailable'}
                          label={status.available ? '可用' : '不可用'}
                          tone={status.available ? 'success' : 'neutral'}
                        />
                        <span className="break-words text-[10px] text-app-muted">
                          {status.available ? (status.version ?? '—') : (status.reason ?? '—')}
                        </span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader
            title="机器密钥"
            description="POST /machines/:id/secret/rotate；仅 reverse-ws 支持。"
          />
          <CardBody className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-app-muted">
              {machine.transport === 'reverse-ws'
                ? '轮换会关闭现有 reverse 连接并让旧 secret 立即失效；新 secret 只显示一次。'
                : '当前传输不是 reverse-ws，密钥轮换返回 BAD_REQUEST；http/stdio 请直接更新 token。'}
            </div>
            <Button
              variant="secondary"
              size="sm"
              icon={<KeyRound className="h-3.5 w-3.5" />}
              disabled={machine.transport !== 'reverse-ws'}
              title={
                machine.transport === 'reverse-ws'
                  ? '轮换 machine secret'
                  : '仅 reverse-ws 支持密钥轮换'
              }
              loading={rotateMutation.isPending}
              onClick={() => rotateMutation.mutate(machine)}
            >
              轮换密钥
            </Button>
          </CardBody>
        </Card>
      </div>

      <MachineFormDialog
        open={formOpen}
        machine={machine}
        onClose={() => setFormOpen(false)}
        onSaved={() => {
          void detail.refetch();
          void health.refetch();
        }}
      />

      {rotateEnrollment === null ? null : (
        <EnrollmentDialog
          enrollment={rotateEnrollment}
          title="机器密钥已轮换"
          description="旧 secret 已失效；把新的 MPANEL_MACHINE_SECRET 写入 worker 后重启它。"
          onClose={() => setRotateEnrollment(null)}
        />
      )}

      <ConfirmDialog
        open={deleteOpen}
        title="删除机器"
        message={
          <span>
            确定删除机器 <strong className="text-app-text">{machine.name}</strong>？
            将移除配置与凭据；所有经 core 代理到该机器的特性请求会立即失效。
          </span>
        }
        confirmLabel="删除"
        loading={deleteMutation.isPending}
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => deleteMutation.mutate(machine)}
      />
    </div>
  );
}

function Row(props: { label: string; children: ReactNode }): JSX.Element {
  return (
    <>
      <dt className="text-xs text-app-muted">{props.label}</dt>
      <dd className="min-w-0 text-sm text-app-text">{props.children}</dd>
    </>
  );
}
