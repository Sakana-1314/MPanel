import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Clock,
  Database,
  Gauge,
  HardDrive,
  KeyRound,
  MemoryStick,
  RefreshCw,
  Server,
} from 'lucide-react';
import type { ListResult, PostgresStats, RedisStats } from '../../api/types';
import { databasesKeys, getProfileStats } from '../../api/databases';
import { getClient } from '../../api/client';
import { getSystemInfo, systemKeys } from '../../api/system';
import { describeError, isAppError } from '../../api/errors';
import { scopedKey } from '../../lib/query-keys';
import type { StatusTone } from '../../components/ui/tones';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  DataTable,
  EmptyState,
  ErrorState,
  LoadingSkeleton,
  RelativeTime,
  StatCard,
  UnavailableAlert,
  type Column,
} from '../../components/ui';
import { formatBytes, formatDate, formatDuration, formatPercent, formatUptime } from '../../lib/format';
import {
  ENGINE_LABEL,
  ENGINE_TONE,
  REDIS_ROLE_LABEL,
  capabilityHint,
  formatMicros,
  isCapabilityPending,
  truncateText,
} from './ProfileList';

/**
 * worker 的数据库诊断端点（slow-queries / slowlog）已实现，但
 * web/src/api/databases.ts 的公共表面尚未导出对应函数；页面不修改 API 层，
 * 在本地按同一传输方式调用，查询键仍遵循 [connectionId, machineId, ...] 规范。
 */
interface PostgresSlowQuery {
  pid: number;
  username: string | null;
  database: string | null;
  state: string | null;
  durationSec: number;
  query: string;
  client: string | null;
}

interface RedisSlowlogEntry {
  id: number;
  /** Unix 秒。 */
  timestamp: number;
  durationUs: number;
  command: string[];
  client: string | null;
  clientName: string | null;
}

const dbExtraKeys = {
  slowQueries: (profileId: string, limit: number) =>
    scopedKey('databases', 'slow-queries', profileId, limit),
  slowlog: (profileId: string, limit: number) =>
    scopedKey('databases', 'slowlog', profileId, limit),
};

function profilePath(profileId: string): string {
  return `/databases/profiles/${encodeURIComponent(profileId)}`;
}

function listPostgresSlowQueries(
  profileId: string,
  limit = 10,
): Promise<ListResult<PostgresSlowQuery>> {
  return getClient().request<ListResult<PostgresSlowQuery>>(
    `${profilePath(profileId)}/slow-queries`,
    { query: { limit } },
  );
}

function listRedisSlowlog(
  profileId: string,
  limit = 20,
): Promise<ListResult<RedisSlowlogEntry>> {
  return getClient().request<ListResult<RedisSlowlogEntry>>(
    `${profilePath(profileId)}/slowlog`,
    { query: { limit } },
  );
}

const STATS_CONFIG_HINT =
  'UNAVAILABLE 通常表示 agent 缺少数据库驱动；UPSTREAM_ERROR 表示目标主机/端口/凭据不可用或查询失败。检查 agent 日志与数据库服务后重试。';

/**
 * 数据库统计面板：
 * - PostgreSQL：版本、数据库大小、连接数、活跃查询、缓存命中、最长事务、慢查询 Top 10；
 * - Redis：内存、命中率、连接数、QPS、key 数、角色、版本、slowlog。
 * stats 是契约类型；longestTransactionSec / hitRate / totalKeys 是 worker 的补充字段，
 * 通过可选读取展示，缺失时显示“—”，不会伪造数据。
 */
export function DatabaseStatsPanel(props: { profileId: string }): JSX.Element {
  const statsQuery = useQuery({
    queryKey: databasesKeys.stats(props.profileId),
    queryFn: () => getProfileStats(props.profileId),
    retry: 0,
  });
  const systemQuery = useQuery({
    queryKey: systemKeys.info(),
    queryFn: () => getSystemInfo(),
    staleTime: 30_000,
    retry: 0,
  });

  const stats = statsQuery.data;
  const kind = stats?.kind;
  const capability =
    kind === undefined
      ? undefined
      : kind === 'postgres'
        ? systemQuery.data?.capabilities.postgres
        : systemQuery.data?.capabilities.redis;

  if (statsQuery.isLoading) {
    return <LoadingSkeleton rows={6} />;
  }

  if (statsQuery.isError) {
    const info = describeError(statsQuery.error, '读取数据库统计失败');
    return (
      <div className="flex flex-col gap-3">
        <ErrorState
          error={statsQuery.error}
          onRetry={() => void statsQuery.refetch()}
          title={`读取数据库统计失败 · ${info.code}`}
        />
        <Alert tone="neutral" title="配置提示">
          {STATS_CONFIG_HINT}
        </Alert>
      </div>
    );
  }

  if (stats === undefined) {
    return (
      <EmptyState
        compact
        title="暂无统计数据"
        description="数据库统计按需读取；点击刷新重试，或先在后端测试连接。"
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={ENGINE_TONE[stats.kind]}>{ENGINE_LABEL[stats.kind]}</Badge>
          <span className="text-xs text-app-muted">
            {stats.version} · 已运行 {formatUptime(stats.uptimeSec)}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-app-muted">
            更新于{' '}
            <RelativeTime value={new Date(statsQuery.dataUpdatedAt).toISOString()} />
          </span>
          <Button
            size="xs"
            variant="secondary"
            icon={<RefreshCw className="h-3 w-3" />}
            loading={statsQuery.isFetching}
            onClick={() => void statsQuery.refetch()}
          >
            刷新统计
          </Button>
        </div>
      </div>

      {systemQuery.isError ? (
        <Alert
          tone="warning"
          title={describeError(systemQuery.error, '能力探测失败').title}
          hint={describeError(systemQuery.error, '能力探测失败').hint}
          action={
            <Button size="xs" variant="ghost" onClick={() => void systemQuery.refetch()}>
              重试
            </Button>
          }
        >
          {describeError(systemQuery.error, '能力探测失败').description}
        </Alert>
      ) : null}

      {capability !== undefined && !capability.available ? (
        isCapabilityPending(capability) ? (
          <Alert
            tone="info"
            title="数据库能力尚未探测"
            hint="点击“重新探测”刷新 /system/info 的能力缓存；这不影响已经读取到的统计。"
            action={
              <Button size="xs" variant="ghost" onClick={() => void systemQuery.refetch()}>
                重新探测
              </Button>
            }
          >
            agent 尚未完成首次能力探测，暂不能判断驱动/客户端工具是否齐全。
          </Alert>
        ) : (
          <UnavailableAlert
            available={false}
            title={`部分 ${ENGINE_LABEL[stats.kind]} 能力不可用`}
            reason={capability.reason}
            hint={
              capabilityHint(capability) ??
              '安装/修复缺失的驱动或客户端工具后重试；“重新探测”会刷新 /system/info 的能力缓存。'
            }
            action={
              <Button size="xs" variant="ghost" onClick={() => void systemQuery.refetch()}>
                重新探测
              </Button>
            }
          />
        )
      ) : null}

      {stats.kind === 'postgres' ? (
        <PostgresStatsView profileId={props.profileId} stats={stats} />
      ) : (
        <RedisStatsView profileId={props.profileId} stats={stats} />
      )}
    </div>
  );
}

/* ------------------------------- PostgreSQL ------------------------------ */

function hitTone(percent: number | null): StatusTone {
  if (percent === null) return 'neutral';
  if (percent >= 99) return 'success';
  if (percent >= 90) return 'warning';
  return 'danger';
}

function PostgresStatsView(props: {
  profileId: string;
  stats: PostgresStats;
}): JSX.Element {
  const stats = props.stats;
  // worker 在契约字段之外追加 longestTransactionSec（PostgresStatsDetail）。
  const detail = stats as PostgresStats & { longestTransactionSec?: number | null };
  const longest =
    typeof detail.longestTransactionSec === 'number' ? detail.longestTransactionSec : null;
  const hitPercent =
    stats.cacheHitRatio === null || stats.cacheHitRatio === undefined
      ? null
      : stats.cacheHitRatio * 100;
  const tps =
    typeof stats.transactionsPerSec === 'number' ? stats.transactionsPerSec.toFixed(2) : '—';

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="版本"
          value={stats.version}
          hint={`运行 ${formatUptime(stats.uptimeSec)}`}
          icon={<Database className="h-4 w-4" />}
          tone="info"
        />
        <StatCard
          label="数据库大小"
          value={formatBytes(stats.databaseSizeBytes)}
          hint="当前连接数据库（pg_database_size）"
          icon={<HardDrive className="h-4 w-4" />}
        />
        <StatCard
          label="连接数"
          value={stats.connections.total}
          hint={`活跃 ${stats.connections.active} · 空闲 ${stats.connections.idle} · 事务中空闲 ${stats.connections.idleInTransaction}`}
          icon={<Activity className="h-4 w-4" />}
        />
        <StatCard
          label="活跃查询"
          value={stats.connections.active}
          hint="pg_stat_activity.state = active"
          tone={stats.connections.active > 0 ? 'info' : 'neutral'}
          icon={<Gauge className="h-4 w-4" />}
        />
        <StatCard
          label="缓存命中"
          value={hitPercent === null ? '—' : formatPercent(hitPercent)}
          hint="blks_hit / (blks_hit + blks_read)"
          tone={hitTone(hitPercent)}
          icon={<MemoryStick className="h-4 w-4" />}
        />
        <StatCard
          label="最长事务"
          value={longest === null ? '—' : formatDuration(longest * 1000)}
          hint={
            longest === null
              ? 'agent 未返回该指标（longestTransactionSec）'
              : 'pg_stat_activity 中非本连接的最长 xact_start'
          }
          tone={longest !== null && longest > 300 ? 'warning' : 'neutral'}
          icon={<Clock className="h-4 w-4" />}
        />
        <StatCard
          label="事务 / 秒"
          value={tps}
          hint="自实例启动以来的平均值"
          icon={<Activity className="h-4 w-4" />}
        />
      </div>

      <SlowQueriesTable profileId={props.profileId} />
    </div>
  );
}

function SlowQueriesTable(props: { profileId: string }): JSX.Element {
  const query = useQuery({
    queryKey: dbExtraKeys.slowQueries(props.profileId, 10),
    queryFn: () => listPostgresSlowQueries(props.profileId, 10),
    retry: 0,
    staleTime: 10_000,
  });

  const columns: Column<PostgresSlowQuery>[] = [
    {
      key: 'durationSec',
      header: '已运行',
      sortable: true,
      sortValue: (row) => row.durationSec,
      render: (row) => (
        <Badge
          tone={
            row.durationSec >= 60 ? 'danger' : row.durationSec >= 5 ? 'warning' : 'neutral'
          }
        >
          {formatDuration(row.durationSec * 1000)}
        </Badge>
      ),
    },
    {
      key: 'pid',
      header: 'PID',
      align: 'right',
      render: (row) => <span className="font-mono text-[11px]">{row.pid}</span>,
    },
    {
      key: 'username',
      header: '用户',
      render: (row) => row.username ?? '—',
    },
    {
      key: 'database',
      header: '数据库',
      render: (row) => row.database ?? '—',
    },
    {
      key: 'state',
      header: '状态',
      render: (row) => <span className="text-xs text-app-muted">{row.state ?? '—'}</span>,
    },
    {
      key: 'query',
      header: 'SQL',
      render: (row) => (
        <span
          className="block max-w-[34rem] truncate font-mono text-[11px] text-app-text"
          title={row.query}
        >
          {truncateText(row.query, 140)}
        </span>
      ),
    },
    {
      key: 'client',
      header: '客户端',
      render: (row) => (
        <span className="font-mono text-[11px] text-app-muted">{row.client ?? '—'}</span>
      ),
    },
  ];

  return (
    <Card>
      <CardHeader
        title="慢查询 Top 10"
        description="pg_stat_activity 中非 idle 查询，按已运行时长排序"
        actions={
          <Button
            size="xs"
            variant="ghost"
            icon={<RefreshCw className="h-3 w-3" />}
            loading={query.isFetching}
            onClick={() => void query.refetch()}
          >
            刷新
          </Button>
        }
      />
      <div className="p-3">
        {query.isError ? (
          <DiagnosticError
            error={query.error}
            label="慢查询"
            endpoint="/slow-queries"
            onRetry={() => void query.refetch()}
          />
        ) : query.data?.available === false ? (
          <Alert tone="warning" title="慢查询不可用" hint="检查 PostgreSQL 驱动与权限。">
            {query.data.reason ?? '后端返回 available=false。'}
          </Alert>
        ) : (
          <DataTable
            columns={columns}
            rows={query.data?.items ?? []}
            rowKey={(row) => String(row.pid)}
            loading={query.isLoading}
            dense
            empty="当前没有非 idle 查询。"
          />
        )}
      </div>
    </Card>
  );
}

function DiagnosticError(props: {
  error: unknown;
  label: string;
  endpoint: string;
  onRetry(): void;
}): JSX.Element {
  const info = describeError(props.error, `读取${props.label}失败`);
  const oldWorker = isAppError(props.error, 'NOT_FOUND');
  return (
    <Alert
      tone="danger"
      title={info.title}
      hint={
        oldWorker
          ? `${info.hint} 旧版 agent 可能尚未提供 ${props.endpoint} 诊断端点。`
          : info.hint
      }
      action={
        <Button size="xs" variant="secondary" onClick={props.onRetry}>
          重试
        </Button>
      }
    >
      {info.description}
    </Alert>
  );
}

/* ---------------------------------- Redis -------------------------------- */

function RedisStatsView(props: { profileId: string; stats: RedisStats }): JSX.Element {
  const stats = props.stats;
  // worker 在契约字段之外追加 hitRate / totalKeys（RedisStatsDetail）。
  const detail = stats as RedisStats & { hitRate?: number | null; totalKeys?: number };
  const hitRate = typeof detail.hitRate === 'number' ? detail.hitRate : null;
  const hitPercent = hitRate === null ? null : hitRate * 100;
  const totalKeys =
    typeof detail.totalKeys === 'number'
      ? detail.totalKeys
      : stats.keyspace.reduce((sum, entry) => sum + entry.keys, 0);
  const memoryPercent =
    stats.maxMemoryBytes !== null && stats.maxMemoryBytes > 0
      ? (stats.usedMemoryBytes / stats.maxMemoryBytes) * 100
      : null;
  const roleLabel = REDIS_ROLE_LABEL[stats.role] ?? stats.role;
  const keyspaceColumns: Column<RedisStats['keyspace'][number]>[] = [
    {
      key: 'db',
      header: 'DB',
      render: (row) => <span className="font-mono">db{row.db}</span>,
    },
    {
      key: 'keys',
      header: 'Key 数',
      align: 'right',
      sortable: true,
      sortValue: (row) => row.keys,
      render: (row) => row.keys.toLocaleString('zh-CN'),
    },
    {
      key: 'expires',
      header: '设置过期',
      align: 'right',
      sortable: true,
      sortValue: (row) => row.expires,
      render: (row) => row.expires.toLocaleString('zh-CN'),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="版本"
          value={stats.version}
          hint={`运行 ${formatUptime(stats.uptimeSec)}`}
          tone="danger"
          icon={<Database className="h-4 w-4" />}
        />
        <StatCard
          label="已用内存"
          value={formatBytes(stats.usedMemoryBytes)}
          hint={
            stats.maxMemoryBytes === null
              ? '未设置 maxmemory'
              : `上限 ${formatBytes(stats.maxMemoryBytes)}${
                  memoryPercent === null ? '' : ` · ${formatPercent(memoryPercent)}`
                }`
          }
          tone={
            memoryPercent === null
              ? 'neutral'
              : memoryPercent >= 90
                ? 'danger'
                : memoryPercent >= 75
                  ? 'warning'
                  : 'success'
          }
          icon={<MemoryStick className="h-4 w-4" />}
        />
        <StatCard
          label="命中率"
          value={hitPercent === null ? '—' : formatPercent(hitPercent)}
          hint={
            hitRate === null
              ? 'agent 未返回 keyspace_hits/misses'
              : 'keyspace_hits / (keyspace_hits + keyspace_misses)'
          }
          tone={hitTone(hitPercent)}
          icon={<Gauge className="h-4 w-4" />}
        />
        <StatCard
          label="连接数"
          value={stats.connectedClients}
          hint="connected_clients"
          icon={<Server className="h-4 w-4" />}
        />
        <StatCard
          label="QPS"
          value={stats.opsPerSec === null ? '—' : stats.opsPerSec.toLocaleString('zh-CN')}
          hint="instantaneous_ops_per_sec"
          icon={<Activity className="h-4 w-4" />}
        />
        <StatCard
          label="Key 总数"
          value={totalKeys.toLocaleString('zh-CN')}
          hint={detail.totalKeys === undefined ? '由 keyspace 汇总' : 'INFO keyspace 汇总'}
          icon={<KeyRound className="h-4 w-4" />}
        />
        <StatCard
          label="角色"
          value={roleLabel}
          hint={stats.role === 'replica' ? '从节点：写操作会被拒绝' : '来自 INFO replication / ROLE'}
          tone={stats.role === 'replica' ? 'info' : 'neutral'}
          icon={<Server className="h-4 w-4" />}
        />
      </div>

      <Card>
        <CardHeader title="Keyspace" description="各逻辑数据库的 key 与过期数量" />
        <div className="p-3">
          {stats.keyspace.length === 0 ? (
            <EmptyState compact title="没有 keyspace 数据" description="可能为空库，或 Redis 未返回 keyspace 段。" />
          ) : (
            <DataTable
              columns={keyspaceColumns}
              rows={stats.keyspace}
              rowKey={(row) => `db${row.db}`}
              dense
            />
          )}
        </div>
      </Card>

      <RedisSlowlogTable profileId={props.profileId} />
    </div>
  );
}

function slowlogTone(durationUs: number): StatusTone {
  if (durationUs >= 100_000) return 'danger';
  if (durationUs >= 10_000) return 'warning';
  return 'neutral';
}

function RedisSlowlogTable(props: { profileId: string }): JSX.Element {
  const query = useQuery({
    queryKey: dbExtraKeys.slowlog(props.profileId, 20),
    queryFn: () => listRedisSlowlog(props.profileId, 20),
    retry: 0,
    staleTime: 10_000,
  });

  const columns: Column<RedisSlowlogEntry>[] = [
    {
      key: 'timestamp',
      header: '时间',
      sortable: true,
      sortValue: (row) => row.timestamp,
      render: (row) => (
        <span className="tabular-nums text-xs">
          {formatDate(new Date(row.timestamp * 1000).toISOString())}
        </span>
      ),
    },
    {
      key: 'durationUs',
      header: '耗时',
      sortable: true,
      sortValue: (row) => row.durationUs,
      render: (row) => <Badge tone={slowlogTone(row.durationUs)}>{formatMicros(row.durationUs)}</Badge>,
    },
    {
      key: 'command',
      header: '命令',
      render: (row) => {
        const text = row.command.join(' ');
        return (
          <span
            className="block max-w-[36rem] truncate font-mono text-[11px] text-app-text"
            title={text}
          >
            {truncateText(text, 160)}
          </span>
        );
      },
    },
    {
      key: 'client',
      header: '客户端',
      render: (row) => (
        <span className="font-mono text-[11px] text-app-muted">
          {row.clientName ?? row.client ?? '—'}
        </span>
      ),
    },
  ];

  return (
    <Card>
      <CardHeader
        title="Slowlog"
        description="slowlog-log-slower-than 阈值以上的最近命令（最多 20 条）"
        actions={
          <Button
            size="xs"
            variant="ghost"
            icon={<RefreshCw className="h-3 w-3" />}
            loading={query.isFetching}
            onClick={() => void query.refetch()}
          >
            刷新
          </Button>
        }
      />
      <div className="p-3">
        {query.isError ? (
          <DiagnosticError
            error={query.error}
            label="Slowlog"
            endpoint="/slowlog"
            onRetry={() => void query.refetch()}
          />
        ) : query.data?.available === false ? (
          <Alert tone="warning" title="Slowlog 不可用" hint="检查 Redis 驱动与 ACL 权限。">
            {query.data.reason ?? '后端返回 available=false。'}
          </Alert>
        ) : (
          <DataTable
            columns={columns}
            rows={query.data?.items ?? []}
            rowKey={(row) => String(row.id)}
            loading={query.isLoading}
            dense
            empty="slowlog 为空（没有命令超过 slowlog-log-slower-than）。"
          />
        )}
      </div>
    </Card>
  );
}
