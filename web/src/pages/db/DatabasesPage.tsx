import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Database,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  ShieldAlert,
  Trash2,
  Zap,
} from 'lucide-react';
import type {
  DatabaseProfile,
  DatabaseTestResult,
  HandoffPayload,
  HandoffTicket,
} from '../../api/types';
import {
  createHandoff,
  databasesKeys,
  deleteProfile,
  listProfiles,
  testProfile,
} from '../../api/databases';
import { AppError, describeError, errorFromStatus } from '../../api/errors';
import type { AppErrorDetails } from '../../api/errors';
import { useAppMutation } from '../../lib/mutations';
import { formatDate } from '../../lib/format';
import { getRuntimeConfig } from '../../lib/runtime-config';
import { getBasePath } from '../../lib/connection-store';
import { resolveRedeemUrl } from '../../lib/paths';
import { useToast } from '../../components/ui/Toast';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  CopyButton,
  EmptyState,
  ErrorState,
  LoadingSkeleton,
  PageHeader,
  RelativeTime,
  SearchInput,
  SecretReveal,
  StatCard,
  StatusBadge,
  Tabs,
  Toolbar,
} from '../../components/ui';
import { BackupPanel } from './BackupPanel';
import { DatabaseStatsPanel } from './DatabaseStatsPanel';
import { DbxFrame } from './DbxFrame';
import { HandoffButton } from './HandoffButton';
import { ProfileFormDialog } from './ProfileFormDialog';
import {
  ENGINE_LABEL,
  ENGINE_TONE,
  ProfileList,
  profileConnectionState,
  profileNotes,
} from './ProfileList';

type FilterKind = 'all' | 'postgres' | 'redis';
type DetailTab = 'overview' | 'stats' | 'backups' | 'dbx';

const DETAIL_TABS = [
  { id: 'overview', label: '概览' },
  { id: 'stats', label: '统计' },
  { id: 'backups', label: '备份' },
  { id: 'dbx', label: 'dbx 查询' },
] as const;

export default function DatabasesPage(): JSX.Element {
  const toast = useToast();
  const params = useParams<{ id?: string; profileId?: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const urlId = searchParams.get('profile') ?? params.profileId ?? params.id ?? null;

  const [selectedId, setSelectedId] = useState<string | null>(urlId);
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState<FilterKind>('all');
  const [tab, setTab] = useState<DetailTab>('overview');
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<DatabaseProfile | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DatabaseProfile | null>(null);
  const [ticket, setTicket] = useState<HandoffTicket | null>(null);
  const [testResults, setTestResults] = useState<Record<string, DatabaseTestResult>>({});

  const dbxUrl = getRuntimeConfig().dbxUrl;
  const dbxConfigured = dbxUrl !== undefined && dbxUrl.trim().length > 0;

  const profilesQuery = useQuery({
    queryKey: databasesKeys.profiles({ limit: 200 }),
    queryFn: () => listProfiles({ limit: 200 }),
    staleTime: 15_000,
  });

  const profiles = profilesQuery.data?.items ?? [];

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return profiles.filter((profile) => {
      if (kindFilter !== 'all' && profile.kind !== kindFilter) return false;
      if (needle.length === 0) return true;
      return (
        profile.name.toLowerCase().includes(needle) ||
        profile.host.toLowerCase().includes(needle) ||
        (profile.database ?? '').toLowerCase().includes(needle)
      );
    });
  }, [profiles, search, kindFilter]);

  const selected = profiles.find((profile) => profile.id === selectedId) ?? null;

  // 支持 ?profile=<id> 深链；若集成层注册 /databases/:id 或 :profileId，useParams 也能读取。
  useEffect(() => {
    if (urlId !== null) setSelectedId(urlId);
  }, [urlId]);

  // 名单变化（删除/首次加载）时自动选中第一个可用档案。
  useEffect(() => {
    if (profilesQuery.isLoading) return;
    if (profiles.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    if (selectedId === null || !profiles.some((profile) => profile.id === selectedId)) {
      const first = filtered[0] ?? profiles[0];
      if (first !== undefined) setSelectedId(first.id);
    }
  }, [profiles, filtered, selectedId, profilesQuery.isLoading]);

  useEffect(() => {
    setTab('overview');
    setTicket(null);
  }, [selectedId]);

  const changeSelection = (id: string | null): void => {
    setSelectedId(id);
    setTicket(null);
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (id === null) next.delete('profile');
        else next.set('profile', id);
        return next;
      },
      { replace: true },
    );
  };

  const changeTab = (id: string): void => {
    if (id !== 'dbx') setTicket(null);
    if (id === 'overview' || id === 'stats' || id === 'backups' || id === 'dbx') setTab(id);
  };

  const testMutation = useAppMutation<DatabaseTestResult, DatabaseProfile>({
    mutationFn: (profile) => testProfile(profile.id),
    silentSuccess: true,
    invalidate: [databasesKeys.profiles()],
    onSuccess: (result, profile) => {
      setTestResults((current) => ({ ...current, [profile.id]: result }));
      if (result.ok) {
        toast.push({
          title: `${profile.name} 连接正常`,
          description: `${result.latencyMs} ms${result.serverVersion === undefined ? '' : ` · 版本 ${result.serverVersion}`}`,
          tone: 'success',
        });
      } else {
        toast.push({
          title: `${profile.name} 连接失败`,
          description: `${result.message ?? '目标不可达'}（${result.latencyMs} ms）`,
          tone: 'error',
        });
      }
    },
  });

  const deleteMutation = useAppMutation<{ deleted: true }, DatabaseProfile>({
    mutationFn: (profile) => deleteProfile(profile.id),
    successMessage: (_, profile) => `已删除数据库档案 ${profile.name}`,
    successDescription: '备份文件会保留；运行中的作业会阻止删除（409 CONFLICT）。',
    invalidate: [databasesKeys.profiles()],
    onSuccess: (_, profile) => {
      setDeleteTarget(null);
      setTestResults((current) => {
        const next = { ...current };
        delete next[profile.id];
        return next;
      });
      if (selectedId === profile.id) changeSelection(null);
    },
  });

  const openCreate = (): void => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (profile: DatabaseProfile): void => {
    setEditing(profile);
    setFormOpen(true);
  };

  const closeForm = (): void => {
    setFormOpen(false);
    setEditing(null);
  };

  const pgCount = profiles.filter((profile) => profile.kind === 'postgres').length;
  const redisCount = profiles.filter((profile) => profile.kind === 'redis').length;
  const testedCount = profiles.filter((profile) => profile.lastCheck !== null).length;
  const failedCount = profiles.filter(
    (profile) => profile.lastCheck !== null && !profile.lastCheck.ok,
  ).length;

  const testingId = testMutation.isPending ? (testMutation.variables?.id ?? null) : null;
  const selectedState = selected === null ? null : profileConnectionState(selected);

  return (
    <div>
      <PageHeader
        title="数据库"
        description="管理 PostgreSQL / Redis 档案：测试连通性、查看统计、执行备份与恢复；查询控制台通过一次性 handoff 票据嵌入 dbx。"
        meta={
          <Badge tone={dbxConfigured ? 'info' : 'neutral'} dot>
            {dbxConfigured ? 'dbx 已配置' : 'dbx 未配置'}
          </Badge>
        }
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw className="h-3.5 w-3.5" />}
              loading={profilesQuery.isFetching}
              onClick={() => void profilesQuery.refetch()}
            >
              刷新
            </Button>
            <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={openCreate}>
              新建档案
            </Button>
          </>
        }
      />

      <div className="mb-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="档案总数"
          value={profilesQuery.data?.total ?? profiles.length}
          hint={`已测试 ${testedCount} 个`}
          icon={<Database className="h-4 w-4" />}
          loading={profilesQuery.isLoading}
        />
        <StatCard
          label="PostgreSQL"
          value={pgCount}
          hint="默认端口 5432；备份依赖 pg_dump"
          tone="info"
          icon={<Server className="h-4 w-4" />}
          loading={profilesQuery.isLoading}
        />
        <StatCard
          label="Redis"
          value={redisCount}
          hint="默认端口 6379；logical 备份可在线恢复"
          tone="danger"
          icon={<Database className="h-4 w-4" />}
          loading={profilesQuery.isLoading}
        />
        <StatCard
          label="最近测试失败"
          value={failedCount}
          hint={failedCount === 0 ? '没有失败的连接测试' : '检查主机、端口、防火墙或凭据'}
          tone={failedCount > 0 ? 'danger' : 'success'}
          icon={<Zap className="h-4 w-4" />}
          loading={profilesQuery.isLoading}
        />
      </div>

      <Toolbar
        bordered
        left={
          <>
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="搜索名称、主机或数据库…"
            />
            <Tabs
              compact
              tabs={[
                { id: 'all', label: '全部', badge: profiles.length },
                { id: 'postgres', label: 'PostgreSQL', badge: pgCount },
                { id: 'redis', label: 'Redis', badge: redisCount },
              ]}
              active={kindFilter}
              onChange={(id) =>
                setKindFilter(id === 'postgres' ? 'postgres' : id === 'redis' ? 'redis' : 'all')
              }
            />
          </>
        }
        right={
          <span className="text-xs text-app-muted">
            显示 {filtered.length} / {profiles.length} 个档案
            {profilesQuery.isFetching ? ' · 刷新中…' : ''}
          </span>
        }
      />

      {profilesQuery.data?.available === false ? (
        <Alert
          tone="warning"
          title="档案存储不可用"
          hint="请检查 worker 的 MPANEL_HOME、JSON 存储文件与磁盘权限；修复后可继续创建/编辑档案。"
          className="mb-3"
        >
          {profilesQuery.data.reason ?? '后端返回 available=false。'}
        </Alert>
      ) : null}

      {profilesQuery.isError ? (
        <ErrorState
          error={profilesQuery.error}
          title={`读取数据库档案失败 · ${describeError(profilesQuery.error).code}`}
          onRetry={() => void profilesQuery.refetch()}
        />
      ) : profilesQuery.isLoading ? (
        <LoadingSkeleton rows={7} />
      ) : profiles.length === 0 ? (
        <EmptyState
          icon={<Database className="h-5 w-5" />}
          title="还没有数据库档案"
          description="创建第一个 PostgreSQL 或 Redis 档案，测试连通性后即可查看统计、备份并在 dbx 中查询。"
          action={
            <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={openCreate}>
              新建档案
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(17rem,20rem)_minmax(0,1fr)]">
          {filtered.length === 0 ? (
            <Card>
              <CardBody>
                <EmptyState
                  compact
                  icon={<Database className="h-5 w-5" />}
                  title="没有匹配的档案"
                  description="调整搜索关键词或引擎筛选后再试。"
                />
              </CardBody>
            </Card>
          ) : (
            <ProfileList
              profiles={filtered}
              selectedId={selectedId}
              testingId={testingId}
              onSelect={changeSelection}
              onEdit={openEdit}
              onDelete={setDeleteTarget}
              onTest={(profile) => testMutation.mutate(profile)}
            />
          )}

          <div>
            {selected === null || selectedState === null ? (
              <Card>
                <CardBody>
                  <EmptyState
                    compact
                    icon={<Database className="h-5 w-5" />}
                    title="选择一个数据库档案"
                    description="从左侧列表选择档案，查看统计、备份与 dbx 查询。"
                  />
                </CardBody>
              </Card>
            ) : (
              <Card>
                <CardHeader
                  title={
                    <span className="flex flex-wrap items-center gap-2">
                      {selected.name}
                      <Badge tone={ENGINE_TONE[selected.kind]}>
                        {ENGINE_LABEL[selected.kind]}
                      </Badge>
                      <StatusBadge
                        status={selectedState.status}
                        label={selectedState.label}
                        tone={selectedState.tone}
                        size="sm"
                      />
                    </span>
                  }
                  description={
                    <span className="font-mono text-xs">
                      {selected.host}:{selected.port} · {selected.username ?? '默认用户'} ·{' '}
                      {selected.kind === 'postgres'
                        ? (selected.database ?? '默认库')
                        : `db${selected.redisDb ?? 0}`}
                    </span>
                  }
                  actions={
                    <>
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={<Zap className="h-3.5 w-3.5" />}
                        loading={testingId === selected.id}
                        onClick={() => testMutation.mutate(selected)}
                      >
                        测试连接
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={<Pencil className="h-3.5 w-3.5" />}
                        onClick={() => openEdit(selected)}
                      >
                        编辑
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-app-danger"
                        icon={<Trash2 className="h-3.5 w-3.5" />}
                        onClick={() => setDeleteTarget(selected)}
                      >
                        删除
                      </Button>
                    </>
                  }
                />
                <CardBody>
                  <Tabs
                    tabs={[...DETAIL_TABS]}
                    active={tab}
                    onChange={changeTab}
                    className="mb-3"
                  />
                  {tab === 'overview' ? (
                    <OverviewTab
                      key={selected.id}
                      profile={selected}
                      lastTest={testResults[selected.id]}
                    />
                  ) : tab === 'stats' ? (
                    <DatabaseStatsPanel key={selected.id} profileId={selected.id} />
                  ) : tab === 'backups' ? (
                    <BackupPanel key={selected.id} profileId={selected.id} />
                  ) : (
                    <DbxTab
                      key={selected.id}
                      profile={selected}
                      dbxUrl={dbxUrl}
                      ticket={ticket}
                      onTicket={setTicket}
                      onClearTicket={() => setTicket(null)}
                    />
                  )}
                </CardBody>
              </Card>
            )}
          </div>
        </div>
      )}

      <ProfileFormDialog
        open={formOpen}
        onClose={closeForm}
        profile={editing ?? undefined}
        onSaved={(saved) => {
          setTestResults((current) => {
            const next = { ...current };
            delete next[saved.id];
            return next;
          });
          setSearch('');
          setKindFilter('all');
          changeSelection(saved.id);
        }}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除数据库档案"
        danger
        confirmLabel="删除"
        loading={deleteMutation.isPending}
        message={
          <span>
            确定删除档案{' '}
            <strong className="text-app-text">{deleteTarget?.name ?? ''}</strong>？档案删除后不可恢复；
            其备份文件会保留，运行中的备份/恢复作业会阻止删除（409 CONFLICT）。
          </span>
        }
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget !== null) deleteMutation.mutate(deleteTarget);
        }}
      />
    </div>
  );
}

function InfoItem(props: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-app-muted">{props.label}</dt>
      <dd className="break-all text-sm text-app-text">{props.children}</dd>
    </div>
  );
}

function OverviewTab(props: {
  profile: DatabaseProfile;
  lastTest?: DatabaseTestResult;
}): JSX.Element {
  const profile = props.profile;
  const check =
    props.lastTest ??
    (profile.lastCheck === null || profile.lastCheck === undefined
      ? null
      : {
          ok: profile.lastCheck.ok,
          latencyMs: profile.lastCheck.latencyMs,
          serverVersion: profile.lastCheck.serverVersion,
          message: profile.lastCheck.message,
        });
  const notes = profileNotes(profile);

  return (
    <div className="flex flex-col gap-4">
      {check === null ? (
        <Alert
          tone="neutral"
          title="尚未测试连接"
          hint="测试失败不会影响档案编辑；能力缺失会返回 UNAVAILABLE 并给出配置提示。"
        >
          点击右上角“测试连接”验证主机、端口、TLS 与凭据。
        </Alert>
      ) : check.ok ? (
        <Alert
          tone="success"
          title="连接正常"
          hint={`延迟 ${check.latencyMs} ms${check.serverVersion === undefined ? '' : ` · 版本 ${check.serverVersion}`}`}
        >
          {check.message ?? '后端成功完成一次数据库握手。'}
        </Alert>
      ) : (
        <Alert
          tone="danger"
          title="连接失败"
          hint="检查主机/端口、防火墙、数据库监听地址与凭据；驱动或工具缺失时会是 UNAVAILABLE。"
        >
          {check.message ?? `目标不可达（${check.latencyMs} ms）。`}
        </Alert>
      )}

      <dl className="grid gap-x-4 gap-y-3 sm:grid-cols-2 xl:grid-cols-3">
        <InfoItem label="引擎">
          <Badge tone={ENGINE_TONE[profile.kind]}>{ENGINE_LABEL[profile.kind]}</Badge>
        </InfoItem>
        <InfoItem label="主机端口">
          <span className="font-mono">
            {profile.host}:{profile.port}
          </span>
        </InfoItem>
        <InfoItem label="用户名">
          <span className="font-mono">{profile.username ?? '—'}</span>
        </InfoItem>
        <InfoItem label={profile.kind === 'postgres' ? '数据库' : 'Redis DB'}>
          <span className="font-mono">
            {profile.kind === 'postgres'
              ? (profile.database ?? '（默认库）')
              : (profile.redisDb ?? 0)}
          </span>
        </InfoItem>
        <InfoItem label="SSL / TLS">
          <Badge tone={profile.tls ? 'success' : 'neutral'}>
            {profile.tls ? '已启用' : '未启用'}
          </Badge>
        </InfoItem>
        <InfoItem label="密码">
          <Badge tone={profile.hasPassword ? 'success' : 'neutral'}>
            {profile.hasPassword ? '已保存（不可回显）' : '未设置'}
          </Badge>
        </InfoItem>
        <InfoItem label="最近测试">
          {profile.lastCheck === null || profile.lastCheck === undefined ? (
            '未测试'
          ) : (
            <span className="flex flex-wrap items-center gap-1 text-xs">
              <RelativeTime value={profile.lastCheck.at} />
              <span className="text-app-muted">· {profile.lastCheck.latencyMs} ms</span>
              {profile.lastCheck.serverVersion === undefined ? null : (
                <span className="font-mono text-app-muted">
                  v{profile.lastCheck.serverVersion}
                </span>
              )}
            </span>
          )}
        </InfoItem>
        <InfoItem label="创建时间">
          <span className="text-xs">{formatDate(profile.createdAt)}</span>
        </InfoItem>
        <InfoItem label="更新时间">
          <span className="text-xs">{formatDate(profile.updatedAt)}</span>
        </InfoItem>
      </dl>

      {notes.length === 0 ? null : (
        <div className="rounded-lg border border-app-border bg-app-elevated/40 px-3 py-2 text-xs">
          <span className="text-app-muted">备注：</span>
          <span className="whitespace-pre-wrap text-app-text">{notes}</span>
        </div>
      )}

      <ConnectionInfoPanel profile={profile} />
    </div>
  );
}

function DbxTab(props: {
  profile: DatabaseProfile;
  dbxUrl?: string;
  ticket: HandoffTicket | null;
  onTicket(ticket: HandoffTicket): void;
  onClearTicket(): void;
}): JSX.Element {
  const configured = props.dbxUrl !== undefined && props.dbxUrl.trim().length > 0;
  return (
    <div className="flex flex-col gap-4">
      <Alert
        tone="info"
        title="dbx 是外部查询控制台"
        hint="worker 不执行 SQL / Redis 查询；密码只在兑换 handoff 票据时返回，且只返回一次。"
      >
        点击“打开 dbx”会先申请一次性 handoff 票据（默认 60 秒、单次使用）。票据只通过
        iframe URL fragment 与 postMessage 传递，不进入服务器访问日志。
      </Alert>

      <div className="flex flex-wrap items-center gap-2">
        {configured ? (
          <HandoffButton
            profileId={props.profile.id}
            onTicket={props.onTicket}
            label={props.ticket === null ? '打开 dbx' : '重新生成票据'}
          />
        ) : (
          <Badge tone="neutral">dbx 未配置</Badge>
        )}
        {props.ticket === null ? null : (
          <Button size="sm" variant="ghost" onClick={props.onClearTicket}>
            关闭内嵌窗口
          </Button>
        )}
        <span className="text-xs text-app-muted">
          {configured
            ? props.ticket === null
              ? '生成票据后在此内嵌加载 dbx。'
              : '票据已生成；若 dbx 未自动兑换，可在下方状态栏重新发送，或用上方按钮重新生成。'
            : '仍可使用“复制连接信息”或“查看一次性密码”降级连接。'}
        </span>
      </div>

      <DbxFrame
        redeemUrl="/databases/handoff/redeem"
        dbxUrl={props.dbxUrl}
        ticket={props.ticket}
        profileName={props.profile.name}
        onClose={props.onClearTicket}
      />

      <ConnectionInfoPanel profile={props.profile} />
    </div>
  );
}

/* --------------------------- 连接信息与凭据 --------------------------- */
/* 文件布局只给数据库页分配固定文件；ConnectionInfoPanel 作为页面内部组件。 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function connectionInfoText(profile: DatabaseProfile): string {
  const lines = [
    'MPanel 数据库连接信息',
    `引擎: ${ENGINE_LABEL[profile.kind]}`,
    `名称: ${profile.name}`,
    `主机: ${profile.host}`,
    `端口: ${profile.port}`,
    `用户名: ${profile.username ?? '（未设置）'}`,
  ];
  if (profile.kind === 'postgres') lines.push(`数据库: ${profile.database ?? '（默认库）'}`);
  else lines.push(`Redis DB: ${profile.redisDb ?? 0}`);
  lines.push(`TLS: ${profile.tls ? '已启用' : '未启用'}`);
  lines.push(`密码: ${profile.hasPassword ? '已保存（API 不返回明文，需一次性兑换）' : '未设置'}`);
  lines.push(
    '',
    '查询控制台: 通过 dbx 的一次性 handoff 票据，或在本页点击“查看一次性密码”。',
  );
  return lines.join('\n');
}

function handoffPayloadText(payload: HandoffPayload): string {
  if (
    typeof payload.connectionString === 'string' &&
    payload.connectionString.length > 0
  ) {
    return `${payload.connectionString}\n\n# 元数据（不含密码）\n${JSON.stringify(
      {
        profileId: payload.profileId,
        name: payload.name,
        kind: payload.kind,
        database: payload.database,
        redisDb: payload.redisDb,
      },
      null,
      2,
    )}`;
  }
  return JSON.stringify(payload, null, 2);
}

function isHandoffPayload(value: unknown): value is HandoffPayload {
  return (
    isRecord(value) &&
    typeof value.profileId === 'string' &&
    (value.kind === 'postgres' || value.kind === 'redis') &&
    typeof value.host === 'string' &&
    typeof value.port === 'number'
  );
}

interface ParsedEnvelope {
  data?: unknown;
  error?: { message?: string; details?: AppErrorDetails };
}

function readEnvelope(body: unknown): ParsedEnvelope {
  if (!isRecord(body)) return {};
  if (body.ok === true) return { data: body.data };
  if (body.ok === false && isRecord(body.error)) {
    return {
      error: {
        message: typeof body.error.message === 'string' ? body.error.message : undefined,
        details: isRecord(body.error.details)
          ? (body.error.details as AppErrorDetails)
          : undefined,
      },
    };
  }
  return {};
}

/**
 * 档案连接信息 + 一次性凭据兑换。
 *
 * API 永不返回密码；唯一的明文出口是 handoff redeem。这里直接以自己的 Origin POST
 * redeemUrl（body 只放 ticket），成功后只在组件内短暂展示，关闭即丢弃，不写 store、
 * 不进 URL。跨域时 redeem 端点只允许 MPANEL_DBX_ORIGIN，失败会给出 AppError hint。
 */
function ConnectionInfoPanel(props: { profile: DatabaseProfile }): JSX.Element {
  const profile = props.profile;
  const [revealed, setRevealed] = useState<HandoffPayload | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setRevealed(null);
    setError(null);
    setBusy(false);
  }, [profile.id]);

  const redeemOnce = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const ticket = await createHandoff(profile.id);
      const endpoint = resolveRedeemUrl(ticket.redeemUrl, getBasePath());
      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ ticket: ticket.ticket }),
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
        });
      } catch (networkError) {
        throw new AppError(
          'NETWORK',
          networkError instanceof Error ? networkError.message : '无法连接 handoff 兑换端点',
          0,
          {
            hint: '兑换端点只允许 MPANEL_DBX_ORIGIN 跨域；若前端与 API 不同源，请改用“复制连接信息”，或在 dbx 中打开票据。',
          },
        );
      }
      const body: unknown = await response.json().catch(() => null);
      const envelope = readEnvelope(body);
      if (!response.ok) {
        const details = envelope.error?.details;
        const retryAfterSec =
          typeof details?.retryAfterSec === 'number' ? details.retryAfterSec : undefined;
        if (response.status === 404) {
          throw new AppError('NOT_FOUND', envelope.error?.message ?? '票据无效或已过期', 404, {
            ...(details ?? {}),
            hint: '票据一次性使用且默认 60 秒内有效；请重新点击“查看一次性密码”。',
          });
        }
        if (response.status === 401 && retryAfterSec !== undefined) {
          throw new AppError('UNAUTHORIZED', envelope.error?.message ?? '兑换端点限速', 401, {
            ...(details ?? {}),
            hint: `兑换端点限速（默认 10 次/分钟），请 ${retryAfterSec} 秒后重试。`,
          });
        }
        throw errorFromStatus(response.status, envelope.error?.message, details);
      }
      if (!isHandoffPayload(envelope.data)) {
        throw new AppError('INTERNAL', '兑换响应格式不符合契约', response.status, {
          hint: '请确认 worker 版本与前端一致；随后重新生成票据再试。',
        });
      }
      setRevealed(envelope.data);
    } catch (caught) {
      setError(
        caught instanceof AppError
          ? caught
          : new AppError(
              'INTERNAL',
              caught instanceof Error ? caught.message : '兑换一次性凭据失败',
              0,
              { hint: '请重试；若持续失败请查看浏览器控制台与服务端日志。' },
            ),
      );
    } finally {
      setBusy(false);
    }
  };

  const errorInfo = error === null ? null : describeError(error);

  return (
    <Card>
      <CardHeader
        title="连接信息与凭据"
        description="密码只写不读；API 不会回显。查看一次性密码（兑换 handoff 票据）是唯一的明文出口。"
        icon={<ShieldAlert className="h-4 w-4" />}
        actions={<Badge tone="neutral">{ENGINE_LABEL[profile.kind]}</Badge>}
      />
      <CardBody className="flex flex-col gap-3">
        {revealed === null ? (
          <>
            <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
              <div className="flex flex-col gap-0.5">
                <dt className="text-xs text-app-muted">主机端口</dt>
                <dd className="font-mono text-app-text">
                  {profile.host}:{profile.port}
                </dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="text-xs text-app-muted">用户名</dt>
                <dd className="font-mono text-app-text">{profile.username ?? '—'}</dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="text-xs text-app-muted">
                  {profile.kind === 'postgres' ? '数据库' : 'Redis DB'}
                </dt>
                <dd className="font-mono text-app-text">
                  {profile.kind === 'postgres'
                    ? (profile.database ?? '（默认库）')
                    : (profile.redisDb ?? 0)}
                </dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="text-xs text-app-muted">TLS</dt>
                <dd>
                  <Badge tone={profile.tls ? 'success' : 'neutral'}>
                    {profile.tls ? '已启用' : '未启用'}
                  </Badge>
                </dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="text-xs text-app-muted">密码</dt>
                <dd>
                  <Badge tone={profile.hasPassword ? 'success' : 'neutral'}>
                    {profile.hasPassword ? '已保存（不可回显）' : '未设置'}
                  </Badge>
                </dd>
              </div>
              <div className="flex flex-col gap-0.5">
                <dt className="text-xs text-app-muted">最近测试</dt>
                <dd className="text-app-text">
                  {profile.lastCheck === null || profile.lastCheck === undefined ? (
                    '未测试'
                  ) : (
                    <span className="flex flex-wrap items-center gap-1">
                      <RelativeTime value={profile.lastCheck.at} />
                      <Badge tone={profile.lastCheck.ok ? 'success' : 'danger'}>
                        {profile.lastCheck.ok ? `${profile.lastCheck.latencyMs} ms` : '失败'}
                      </Badge>
                      {profile.lastCheck.serverVersion === undefined ? null : (
                        <span className="font-mono text-[11px] text-app-muted">
                          v{profile.lastCheck.serverVersion}
                        </span>
                      )}
                    </span>
                  )}
                </dd>
              </div>
            </dl>

            <div className="flex flex-wrap items-center gap-2">
              <CopyButton
                value={connectionInfoText(profile)}
                label="复制连接信息"
                variant="secondary"
                size="sm"
              />
              <Button
                size="sm"
                variant="secondary"
                icon={<KeyRound className="h-3.5 w-3.5" />}
                loading={busy}
                title="通过 handoff redeem 一次性显示连接密码（会消耗票据）"
                onClick={() => void redeemOnce()}
              >
                查看一次性密码
              </Button>
              <span className="text-[11px] text-app-muted">
                会生成并立即消费一张新票据；若 dbx 已打开，请勿重复操作。
              </span>
            </div>

            {errorInfo === null ? null : (
              <Alert tone="danger" title={errorInfo.title} hint={errorInfo.hint}>
                {errorInfo.description}
              </Alert>
            )}
          </>
        ) : (
          <SecretReveal
            title={`${revealed.name} 的一次性连接凭据`}
            value={handoffPayloadText(revealed)}
            description="关闭后本页不再显示明文；如需再次获取，请重新兑换（会消耗新的 handoff 票据）。"
            onDone={() => setRevealed(null)}
          />
        )}
      </CardBody>
    </Card>
  );
}
