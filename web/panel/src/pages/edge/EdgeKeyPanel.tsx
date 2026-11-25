import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { KeyRound, Plus, RefreshCw, Ban } from 'lucide-react';
import type { EdgeKey } from '../../api/types';
import { edgeKeys, listEdgeKeys, revokeEdgeKey } from '../../api/edge';
import { useAppMutation } from '../../lib/mutations';
import { formatDate } from '../../lib/format';
import { Alert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { ErrorState } from '../../components/ui/ErrorState';
import { RelativeTime } from '../../components/ui/RelativeTime';
import { Spinner } from '../../components/ui/Spinner';
import { edgeKeyState } from './edge-utils';
import { usePageVisible } from './use-page-visible';

export interface EdgeKeyPanelProps {
  onCreate: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}

const STEPS = [
  {
    title: '创建入网密钥',
    description: '设置名称、可选分组、有效期与最大使用次数；密钥只显示一次。',
  },
  {
    title: '在目标机启动 agent',
    description:
      '设置 MPANEL_TRANSPORT=reverse-ws、MPANEL_CORE_URL 与 MPANEL_EDGE_KEY，然后运行 agent serve。',
  },
  {
    title: '节点自动出现',
    description: 'agent 主动拨号 /ws/worker 成功后，边缘节点会自动出现在本页。',
  },
] as const;

/** 入网密钥面板：列表、吊销与空态三步引导。 */
export function EdgeKeyPanel(props: EdgeKeyPanelProps): JSX.Element {
  const visible = usePageVisible();
  const [revokeTarget, setRevokeTarget] = useState<EdgeKey | null>(null);

  const keysQuery = useQuery({
    queryKey: edgeKeys.keys(),
    queryFn: listEdgeKeys,
    retry: 0,
    staleTime: 15_000,
    refetchInterval: visible ? 30_000 : false,
  });

  const keys = keysQuery.data?.items ?? [];

  const revokeMutation = useAppMutation<{ revoked: true }, EdgeKey>({
    mutationFn: (key) => revokeEdgeKey(key.id),
    successMessage: (_, key) => `已吊销密钥 ${key.name}`,
    successDescription: '已入网的节点不受影响；新节点无法再用该密钥注册。',
    invalidate: [edgeKeys.keysRoot()],
    onSuccess: () => setRevokeTarget(null),
  });

  const columns: Column<EdgeKey>[] = useMemo(
    () => [
      {
        key: 'name',
        header: '名称 / 分组',
        sortable: true,
        sortValue: (key) => key.name,
        render: (key) => (
          <div className="min-w-0">
            <p className="truncate font-medium text-app-text">{key.name}</p>
            <div className="flex flex-wrap items-center gap-1">
              <Badge tone="neutral" className="text-[10px]">
                {key.group ?? '未分组'}
              </Badge>
              <span className="truncate font-mono text-[10px] text-app-muted">{key.id}</span>
            </div>
          </div>
        ),
      },
      {
        key: 'uses',
        header: '使用次数 / 上限',
        sortable: true,
        sortValue: (key) => key.uses,
        render: (key) => (
          <div className="flex flex-col gap-0.5">
            <span className="text-sm tabular-nums text-app-text">
              {key.uses} / {key.maxUses === 0 ? '不限' : key.maxUses}
            </span>
            <span className="text-[10px] text-app-muted">
              {key.maxUses === 0 ? '不限次数密钥' : `剩余 ${Math.max(0, key.maxUses - key.uses)} 次`}
            </span>
          </div>
        ),
      },
      {
        key: 'lastUsedAt',
        header: '最后使用',
        sortable: true,
        sortValue: (key) => key.lastUsedAt ?? '',
        render: (key) => (
          <RelativeTime
            value={key.lastUsedAt}
            fallback="从未使用"
            className="text-xs text-app-muted"
          />
        ),
      },
      {
        key: 'expiresAt',
        header: '过期时间',
        sortable: true,
        sortValue: (key) => key.expiresAt ?? '',
        render: (key) => (
          <div className="flex flex-col gap-0.5 text-xs">
            <span className="text-app-text">
              {key.expiresAt === null ? '不过期' : formatDate(key.expiresAt)}
            </span>
            {key.expiresAt === null ? null : (
              <RelativeTime value={key.expiresAt} className="text-[10px] text-app-muted" />
            )}
          </div>
        ),
      },
      {
        key: 'status',
        header: '状态',
        sortable: true,
        sortValue: (key) => edgeKeyState(key).state,
        render: (key) => {
          const state = edgeKeyState(key);
          return (
            <Badge tone={state.tone} dot>
              {state.label}
            </Badge>
          );
        },
      },
      {
        key: 'actions',
        header: '操作',
        align: 'right',
        render: (key) => {
          const state = edgeKeyState(key);
          const revoking = revokeMutation.isPending && revokeMutation.variables?.id === key.id;
          return (
            <span
              className="flex items-center justify-end"
              onClick={(event) => event.stopPropagation()}
            >
              <Button
                variant="ghost"
                size="icon"
                className="text-app-danger"
                title={
                  state.state === 'active'
                    ? '吊销密钥'
                    : `密钥状态为${state.label}，不能再次吊销`
                }
                aria-label="吊销密钥"
                disabled={state.state !== 'active'}
                loading={revoking}
                onClick={() => setRevokeTarget(key)}
              >
                <Ban className="h-3.5 w-3.5" />
              </Button>
            </span>
          );
        },
      },
    ],
    [revokeMutation.isPending, revokeMutation.variables],
  );

  return (
    <Card>
      <CardHeader
        title="入网密钥"
        description="共享密钥让 NAT 后的 agent 自助注册；密钥只在创建时显示一次。"
        icon={<KeyRound className="h-4 w-4" />}
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              icon={<RefreshCw className={props.refreshing ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />}
              loading={props.refreshing}
              onClick={props.onRefresh}
            >
              刷新
            </Button>
            <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={props.onCreate}>
              新建密钥
            </Button>
          </>
        }
      />
      <CardBody className="p-3">
        {keysQuery.isError ? (
          <ErrorState error={keysQuery.error} onRetry={() => void keysQuery.refetch()} />
        ) : keysQuery.isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Spinner label="加载入网密钥…" />
          </div>
        ) : keysQuery.data?.available === false ? (
          <Alert
            tone="warning"
            title="密钥列表不可用"
            hint="边缘接口在 core 中恒可用；请检查 core 日志与机器存储后重试。"
          >
            {keysQuery.data.reason ?? 'core 返回 available=false。'}
          </Alert>
        ) : keys.length === 0 ? (
          <div className="rounded-xl border border-dashed border-app-border bg-app-surface/40 px-4 py-5">
            <div className="flex items-start gap-2">
              <span className="rounded-full bg-app-elevated p-2 text-app-muted">
                <KeyRound className="h-4 w-4" />
              </span>
              <div>
                <h3 className="text-sm font-semibold text-app-text">还没有入网密钥</h3>
                <p className="mt-0.5 text-xs text-app-muted">
                  按下面三步接入第一台边缘节点；节点入网后与普通 reverse-ws 机器完全同构。
                </p>
              </div>
            </div>
            <ol className="mt-4 grid gap-3 sm:grid-cols-3">
              {STEPS.map((step, index) => (
                <li key={step.title} className="rounded-lg border border-app-border bg-app-surface p-3">
                  <span className="grid h-6 w-6 place-items-center rounded-full bg-app-accent/15 text-xs font-semibold text-app-accent">
                    {index + 1}
                  </span>
                  <p className="mt-2 text-xs font-medium text-app-text">{step.title}</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-app-muted">
                    {step.description}
                  </p>
                </li>
              ))}
            </ol>
            <div className="mt-3 flex justify-end">
              <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={props.onCreate}>
                创建入网密钥
              </Button>
            </div>
          </div>
        ) : (
          <DataTable
            columns={columns}
            rows={keys}
            rowKey={(key) => key.id}
            loading={props.refreshing}
            empty="没有匹配的入网密钥。"
            dense
          />
        )}
      </CardBody>

      <ConfirmDialog
        open={revokeTarget !== null}
        title="吊销入网密钥"
        message={
          <span>
            确定吊销密钥 <strong className="text-app-text">{revokeTarget?.name}</strong>？
            已入网的节点不受影响；该密钥不能再用于新节点注册，且无法恢复。
          </span>
        }
        confirmLabel="吊销"
        loading={revokeMutation.isPending}
        onCancel={() => setRevokeTarget(null)}
        onConfirm={() => {
          if (revokeTarget !== null) revokeMutation.mutate(revokeTarget);
        }}
      />
    </Card>
  );
}
