import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import type { CertificateInfo } from '../../api/types';
import { certsKeys, listCerts } from '../../api/certs';
import { getSystemInfo, systemKeys } from '../../api/system';
import { formatDate, formatDay, formatDaysRemaining } from '../../lib/format';
import { CertDetailDrawer } from './CertDetailDrawer';
import { Alert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { StatCard } from '../../components/ui/Card';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorState } from '../../components/ui/ErrorState';
import { PageHeader } from '../../components/ui/PageHeader';
import { SearchInput } from '../../components/ui/SearchInput';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { Tabs } from '../../components/ui/Tabs';
import { Toolbar } from '../../components/ui/Toolbar';

type WindowFilter = 'all' | '30' | '14' | '7' | 'expired';

export default function CertsPage(): JSX.Element {
  const [search, setSearch] = useState('');
  const [windowFilter, setWindowFilter] = useState<WindowFilter>('all');
  const [selected, setSelected] = useState<CertificateInfo | null>(null);

  const certsQuery = useQuery({
    queryKey: certsKeys.list({ limit: 200, includeExpired: true }),
    queryFn: () => listCerts({ limit: 200, includeExpired: true }),
    retry: 1,
  });

  const systemQuery = useQuery({
    queryKey: systemKeys.info(),
    queryFn: () => getSystemInfo(),
    staleTime: 60_000,
  });

  const certs = certsQuery.data?.items ?? [];
  const available = certsQuery.data?.available !== false;

  const counts = useMemo(() => {
    let valid = 0;
    let expiring30 = 0;
    let expiring14 = 0;
    let expiring7 = 0;
    let expired = 0;
    for (const cert of certs) {
      if (cert.daysRemaining < 0) expired += 1;
      else {
        valid += 1;
        if (cert.daysRemaining <= 30) expiring30 += 1;
        if (cert.daysRemaining <= 14) expiring14 += 1;
        if (cert.daysRemaining <= 7) expiring7 += 1;
      }
    }
    return { valid, expiring30, expiring14, expiring7, expired };
  }, [certs]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return certs.filter((cert) => {
      if (windowFilter === 'expired' && cert.daysRemaining >= 0) return false;
      if (windowFilter === '7' && (cert.daysRemaining < 0 || cert.daysRemaining > 7)) return false;
      if (windowFilter === '14' && (cert.daysRemaining < 0 || cert.daysRemaining > 14)) return false;
      if (windowFilter === '30' && (cert.daysRemaining < 0 || cert.daysRemaining > 30)) return false;
      if (needle.length === 0) return true;
      return (
        cert.domains.some((domain) => domain.toLowerCase().includes(needle)) ||
        (cert.commonName ?? '').toLowerCase().includes(needle) ||
        cert.issuer.toLowerCase().includes(needle)
      );
    });
  }, [certs, search, windowFilter]);

  const columns: Column<CertificateInfo>[] = [
    {
      key: 'domains',
      header: '域名',
      sortable: true,
      sortValue: (cert) => cert.domains[0] ?? cert.commonName ?? '',
      render: (cert) => {
        const domains = cert.domains.length === 0 ? (cert.commonName === null ? [] : [cert.commonName]) : cert.domains;
        return (
          <div className="min-w-0">
            <p className="truncate font-mono text-xs text-app-text">{domains[0] ?? '—'}</p>
            {domains.length > 1 ? (
              <Badge tone="neutral" title={domains.slice(1).join('\n')}>
                +{domains.length - 1} 个域名
              </Badge>
            ) : null}
          </div>
        );
      },
    },
    {
      key: 'issuer',
      header: '颁发者',
      sortable: true,
      sortValue: (cert) => cert.issuer,
      render: (cert) => (
        <span className="block max-w-[18rem] truncate text-xs text-app-muted" title={cert.issuer}>
          {cert.issuer}
        </span>
      ),
    },
    {
      key: 'notAfter',
      header: '到期时间',
      sortable: true,
      sortValue: (cert) => cert.notAfter,
      render: (cert) => (
        <div className="flex flex-col">
          <span className="text-xs text-app-text">{formatDay(cert.notAfter)}</span>
          <span className="text-[10px] text-app-muted" title={formatDate(cert.notAfter)}>
            {cert.source}
          </span>
        </div>
      ),
    },
    {
      key: 'daysRemaining',
      header: '剩余天数',
      sortable: true,
      sortValue: (cert) => cert.daysRemaining,
      render: (cert) => (
        <StatusBadge
          status={cert.daysRemaining < 0 ? 'expired' : cert.daysRemaining <= 14 ? 'expiring' : 'valid'}
          label={cert.daysRemaining < 0 ? `${cert.daysRemaining} 天` : `${cert.daysRemaining} 天`}
          tone={cert.daysRemaining < 0 ? 'danger' : cert.daysRemaining <= 7 ? 'danger' : cert.daysRemaining <= 30 ? 'warning' : 'success'}
        />
      ),
    },
    {
      key: 'status',
      header: '状态',
      sortable: true,
      sortValue: (cert) => cert.status,
      render: (cert) => <StatusBadge status={cert.status} />,
    },
    {
      key: 'path',
      header: '路径',
      render: (cert) => (
        <span className="block max-w-[22rem] truncate font-mono text-[10px] text-app-muted" title={cert.path}>
          {cert.path}
        </span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="证书"
        description="只读扫描 Caddy 数据目录下的证书（不读取私钥）。续期由 Caddy 负责。"
        actions={
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw className={`h-3.5 w-3.5 ${certsQuery.isFetching ? 'animate-spin' : ''}`} />}
            onClick={() => {
              void certsQuery.refetch();
            }}
          >
            刷新
          </Button>
        }
      />

      <div className="mb-3 grid gap-2 sm:grid-cols-4">
        <StatCard
          label="证书总数"
          value={certs.length}
          tone="info"
          icon={<ShieldCheck className="h-4 w-4" />}
          loading={certsQuery.isLoading}
        />
        <StatCard label="有效" value={counts.valid} tone="success" loading={certsQuery.isLoading} />
        <StatCard
          label="30 天内到期"
          value={counts.expiring30}
          hint={`14 天内 ${counts.expiring14} · 7 天内 ${counts.expiring7}`}
          tone={counts.expiring30 > 0 ? 'warning' : 'neutral'}
          loading={certsQuery.isLoading}
        />
        <StatCard
          label="已过期"
          value={counts.expired}
          tone={counts.expired > 0 ? 'danger' : 'neutral'}
          loading={certsQuery.isLoading}
        />
      </div>

      {!available ? (
        <Alert
          tone="warning"
          title="Caddy 数据目录不可用"
          hint="在 worker 上设置 MPANEL_CADDY_DATA_DIR 指向 Caddy 的 data 目录（通常 /var/lib/caddy/.local/share/caddy），然后刷新。"
          className="mb-3"
        >
          {certsQuery.data?.reason ?? '后端返回 available=false，无法扫描证书。'}
        </Alert>
      ) : null}

      {certsQuery.isError ? (
        <ErrorState error={certsQuery.error} onRetry={() => void certsQuery.refetch()} />
      ) : (
        <>
          <Toolbar
            bordered
            left={
              <>
                <SearchInput value={search} onChange={setSearch} placeholder="搜索域名或颁发者…" />
                <Tabs
                  compact
                  tabs={[
                    { id: 'all', label: '全部', badge: certs.length },
                    { id: '30', label: '30 天内', badge: counts.expiring30 },
                    { id: '14', label: '14 天内', badge: counts.expiring14 },
                    { id: '7', label: '7 天内', badge: counts.expiring7 },
                    { id: 'expired', label: '已过期', badge: counts.expired },
                  ]}
                  active={windowFilter}
                  onChange={(id) => setWindowFilter(id as WindowFilter)}
                />
              </>
            }
            right={
              <span className="text-xs text-app-muted">
                共 {filtered.length} 张
                {certsQuery.data?.nextCursor === undefined || certsQuery.data?.nextCursor === null
                  ? ''
                  : '（还有更多，当前仅显示前 200 张）'}
              </span>
            }
          />

          {certs.length === 0 && !certsQuery.isLoading && available ? (
            <EmptyState
              icon={<ShieldCheck className="h-5 w-5" />}
              title="还没有证书"
              description="Caddy 尚未签发证书：创建并应用一个 TLS 模式为 auto 的站点后，Caddy 会通过 ACME 自动申请。也可以检查 MPANEL_CADDY_DATA_DIR 是否指向正确的 data 目录。"
            />
          ) : (
            <DataTable
              columns={columns}
              rows={filtered}
              rowKey={(cert) => cert.id}
              loading={certsQuery.isLoading}
              onRowClick={setSelected}
              empty="没有匹配的证书。"
              stickyHeader
              dense
            />
          )}

          <p className="mt-2 text-[11px] text-app-muted">
            {systemQuery.data?.paths?.caddyData === undefined
              ? '提示：证书目录由 worker 的 MPANEL_CADDY_DATA_DIR 决定。'
              : `数据目录：${systemQuery.data.paths.caddyData}`}
          </p>
        </>
      )}

      <CertDetailDrawer cert={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
