import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Eye,
  Globe,
  Pencil,
  Plus,
  Rocket,
  ShieldCheck,
  Trash2,
  Upload,
} from 'lucide-react';
import type { CertificateInfo, Site, SiteApplyResult } from '../../api/types';
import {
  applySites,
  createSite,
  deleteSite,
  listSites,
  sitesKeys,
} from '../../api/sites';
import type { SitePreviewRequest } from '../../api/sites';
import { certsKeys, listCerts } from '../../api/certs';
import { getSystemInfo, systemKeys } from '../../api/system';
import { describeError } from '../../api/errors';
import { useAppMutation } from '../../lib/mutations';
import { formatDay } from '../../lib/format';
import {
  EMPTY_SITE_DRAFT,
  HANDLER_LABEL,
  SiteForm,
  type SiteDraft,
} from './SiteForm';
import { SitePreviewDialog } from './SitePreviewDialog';
import { SiteImportExportDialog } from './SiteImportExportDialog';
import { SiteStatusBadge } from './SiteStatusBadge';
import { Alert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { CodeBlock } from '../../components/ui/CodeBlock';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { Drawer } from '../../components/ui/Drawer';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorState } from '../../components/ui/ErrorState';
import { Modal } from '../../components/ui/Modal';
import { PageHeader } from '../../components/ui/PageHeader';
import { RelativeTime } from '../../components/ui/RelativeTime';
import { SearchInput } from '../../components/ui/SearchInput';
import { StatCard } from '../../components/ui/Card';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { Tabs } from '../../components/ui/Tabs';
import { Toolbar } from '../../components/ui/Toolbar';

type EnabledFilter = 'all' | 'enabled' | 'disabled';

export default function SitesPage(): JSX.Element {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [enabledFilter, setEnabledFilter] = useState<EnabledFilter>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState<SiteDraft>(EMPTY_SITE_DRAFT);
  const [previewRequest, setPreviewRequest] = useState<SitePreviewRequest | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Site | null>(null);
  const [applyConfirmOpen, setApplyConfirmOpen] = useState(false);
  const [applyResult, setApplyResult] = useState<SiteApplyResult | null>(null);

  const sitesQuery = useQuery({
    queryKey: sitesKeys.list({ limit: 200 }),
    queryFn: () => listSites({ limit: 200 }),
  });

  const certsQuery = useQuery({
    queryKey: certsKeys.list({ limit: 200, includeExpired: true }),
    queryFn: () => listCerts({ limit: 200, includeExpired: true }),
    retry: 0,
  });

  const systemQuery = useQuery({
    queryKey: systemKeys.info(),
    queryFn: () => getSystemInfo(),
    staleTime: 30_000,
  });

  const caddy = systemQuery.data?.capabilities.caddy;
  const caddyAvailable = caddy === undefined ? true : caddy.available;
  const caddyHint =
    caddy !== undefined && !caddy.available
      ? (caddy.reason ?? 'caddy 不可用')
      : undefined;

  const sites = sitesQuery.data?.items ?? [];
  const certs = certsQuery.data?.items ?? [];

  const createMutation = useAppMutation({
    mutationFn: (draft: SiteDraft) =>
      createSite({ name: draft.name.trim(), enabled: draft.enabled, config: draft.config }),
    successMessage: (site) => `已创建站点 ${site.name}`,
    invalidate: [sitesKeys.list()],
    onSuccess: (site) => {
      setCreateOpen(false);
      setCreateDraft(EMPTY_SITE_DRAFT);
      navigate(`/sites/${site.id}`);
    },
  });

  const deleteMutation = useAppMutation({
    mutationFn: (site: Site) => deleteSite(site.id),
    successMessage: (_, site) => `已删除站点 ${site.name}`,
    successDescription: (_, site) =>
      site.status === 'applied' || site.appliedRevision !== null
        ? '该站点已应用过；需要在列表页执行“应用全部更改”才会从 Caddy 中移除。'
        : undefined,
    invalidate: [sitesKeys.list()],
    onSuccess: () => setDeleteTarget(null),
  });

  const applyMutation = useAppMutation({
    mutationFn: () => applySites({}),
    successMessage: (result) =>
      `已应用 ${result.sites.length} 个站点（apply #${result.revision}）`,
    successDescription: (result) =>
      result.rolledBack
        ? '已回滚到应用前的配置。'
        : result.warnings.length > 0
          ? `有 ${result.warnings.length} 条警告。`
          : undefined,
    invalidate: [sitesKeys.list(), certsKeys.list(), systemKeys.info()],
    onSuccess: (result) => setApplyResult(result),
  });

  const applyError = applyMutation.error;

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return sites.filter((site) => {
      if (enabledFilter === 'enabled' && !site.enabled) return false;
      if (enabledFilter === 'disabled' && site.enabled) return false;
      if (needle.length === 0) return true;
      return (
        site.name.toLowerCase().includes(needle) ||
        site.config.domains.some((domain) => domain.toLowerCase().includes(needle))
      );
    });
  }, [sites, search, enabledFilter]);

  const earliestCertByDomain = useMemo(() => {
    const map = new Map<string, CertificateInfo>();
    for (const cert of certs) {
      for (const domain of cert.domains) {
        const key = domain.toLowerCase().replace(/^\*\./, '');
        const current = map.get(key);
        if (current === undefined || current.notAfter > cert.notAfter) map.set(key, cert);
      }
    }
    return map;
  }, [certs]);

  const certForSite = (site: Site): CertificateInfo | undefined => {
    let result: CertificateInfo | undefined;
    for (const domain of site.config.domains) {
      const normalized = domain.toLowerCase().replace(/^\*\./, '');
      const cert =
        earliestCertByDomain.get(normalized) ??
        (normalized.includes('.')
          ? earliestCertByDomain.get(normalized.split('.').slice(1).join('.'))
          : undefined);
      if (cert !== undefined && (result === undefined || cert.notAfter < result.notAfter)) {
        result = cert;
      }
    }
    return result;
  };

  const pendingCount = sites.filter(
    (site) => site.status === 'pending' || site.status === 'draft',
  ).length;
  const appliedCount = sites.filter((site) => site.status === 'applied').length;
  const failedSites = sites.filter((site) => site.lastApply !== null && site.lastApply.ok === false);

  const columns: Column<Site>[] = [
    {
      key: 'name',
      header: '站点',
      sortable: true,
      sortValue: (site) => site.name,
      render: (site) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-app-text">{site.name}</p>
          <p className="truncate font-mono text-[10px] text-app-muted">{site.id}</p>
        </div>
      ),
    },
    {
      key: 'domains',
      header: '域名',
      sortable: true,
      sortValue: (site) => site.config.domains[0] ?? '',
      render: (site) => {
        const domains = site.config.domains.filter((domain) => domain.trim().length > 0);
        if (domains.length === 0) return <span className="text-app-muted">—</span>;
        return (
          <span className="flex flex-wrap items-center gap-1">
            <span className="font-mono text-xs text-app-text">{domains[0]}</span>
            {domains.length > 1 ? (
              <Badge tone="neutral" title={domains.slice(1).join('\n')}>
                +{domains.length - 1}
              </Badge>
            ) : null}
          </span>
        );
      },
    },
    {
      key: 'handler',
      header: '类型',
      sortable: true,
      sortValue: (site) => site.config.handler.type,
      render: (site) => (
        <span className="text-xs text-app-muted">{HANDLER_LABEL[site.config.handler.type]}</span>
      ),
    },
    {
      key: 'tls',
      header: 'TLS',
      render: (site) => (
        <Badge tone={site.config.tls?.mode === 'off' ? 'neutral' : 'info'}>
          {site.config.tls?.mode ?? 'auto'}
        </Badge>
      ),
    },
    {
      key: 'status',
      header: '状态',
      sortable: true,
      sortValue: (site) => site.status,
      render: (site) => <SiteStatusBadge status={site.status} />,
    },
    {
      key: 'cert',
      header: '证书到期',
      sortable: true,
      sortValue: (site) => certForSite(site)?.daysRemaining ?? 9999,
      render: (site) => {
        const cert = certForSite(site);
        if (cert === undefined) {
          return <span className="text-xs text-app-muted">—</span>;
        }
        return (
          <div className="flex flex-col gap-0.5">
            <StatusBadge
              status={cert.status}
              size="sm"
              label={cert.daysRemaining < 0 ? '已过期' : `${cert.daysRemaining} 天`}
              tone={cert.daysRemaining < 0 ? 'danger' : cert.daysRemaining <= 14 ? 'warning' : 'success'}
            />
            <span className="text-[10px] text-app-muted">{formatDay(cert.notAfter)}</span>
          </div>
        );
      },
    },
    {
      key: 'updatedAt',
      header: '更新时间',
      sortable: true,
      sortValue: (site) => site.updatedAt,
      render: (site) => (
        <RelativeTime value={site.updatedAt} className="text-xs text-app-muted" />
      ),
    },
    {
      key: 'actions',
      header: '操作',
      align: 'right',
      render: (site) => (
        <span className="flex items-center justify-end gap-1" onClick={(event) => event.stopPropagation()}>
          <Button
            variant="ghost"
            size="icon"
            title="预览 Caddyfile"
            aria-label="预览 Caddyfile"
            onClick={() => setPreviewRequest({ siteId: site.id, validate: true })}
          >
            <Eye className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="编辑"
            aria-label="编辑"
            onClick={() => navigate(`/sites/${site.id}`)}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="text-app-danger"
            title="删除"
            aria-label="删除"
            onClick={() => setDeleteTarget(site)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="站点"
        description="结构化 Caddy 站点草稿：保存只改 JSON，应用才会校验、备份并 reload 线上 Caddy。"
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={<Upload className="h-3.5 w-3.5" />}
              onClick={() => setImportOpen(true)}
            >
              导入 / 导出
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<Rocket className="h-3.5 w-3.5" />}
              disabled={!caddyAvailable || applyMutation.isPending}
              title={
                caddyAvailable
                  ? '渲染全部启用站点并 caddy validate + reload'
                  : `caddy 不可用：${caddyHint ?? '无法应用'}`
              }
              loading={applyMutation.isPending}
              onClick={() => setApplyConfirmOpen(true)}
            >
              应用全部更改
            </Button>
            <Button
              size="sm"
              icon={<Plus className="h-3.5 w-3.5" />}
              onClick={() => {
                setCreateDraft(EMPTY_SITE_DRAFT);
                setCreateOpen(true);
              }}
            >
              新建站点
            </Button>
          </>
        }
      />

      <div className="mb-3 grid gap-2 sm:grid-cols-3">
        <StatCard
          label="站点总数"
          value={sitesQuery.data?.total ?? sites.length}
          hint={`已应用 ${appliedCount} 个`}
          icon={<Globe className="h-4 w-4" />}
          loading={sitesQuery.isLoading}
        />
        <StatCard
          label="待应用"
          value={pendingCount}
          hint={pendingCount === 0 ? '所有草稿均已应用' : '有修改尚未写入 Caddy'}
          tone={pendingCount > 0 ? 'warning' : 'success'}
          icon={<Rocket className="h-4 w-4" />}
          loading={sitesQuery.isLoading}
        />
        <StatCard
          label="证书"
          value={certs.length}
          hint={certs.length === 0 ? '尚无证书（Caddy 可能还未签发）' : '来自 Caddy 数据目录'}
          tone={certs.length === 0 ? 'neutral' : 'info'}
          icon={<ShieldCheck className="h-4 w-4" />}
          loading={certsQuery.isLoading}
        />
      </div>

      {!caddyAvailable ? (
        <Alert
          tone="warning"
          title="Caddy 不可用：只能编辑与预览"
          hint={
            caddy?.reason === undefined
              ? '安装 Caddy 或设置 MPANEL_CADDY_BIN 指向可执行文件后重试。'
              : '请修复 Caddy 后重试；期间草稿仍可编辑，预览可生成片段但不执行 validate。'
          }
          className="mb-3"
        >
          {caddyHint ?? '后端能力探测显示 caddy.available=false。应用按钮已禁用。'}
        </Alert>
      ) : null}

      {sitesQuery.data?.available === false ? (
        <Alert
          tone="danger"
          title="站点存储不可用"
          hint="请检查 worker 的 MPANEL_HOME 与权限；这不会影响预览（若 caddy 可用）。"
          className="mb-3"
        >
          {sitesQuery.data.reason ?? '后端返回 available=false。'}
        </Alert>
      ) : null}

      {failedSites.length > 0 ? (
        <Alert
          tone="danger"
          title={`${failedSites.length} 个站点最近一次应用失败`}
          hint="修复错误后再次应用；失败的 apply 不会改变线上配置。"
          className="mb-3"
        >
          {failedSites
            .slice(0, 3)
            .map((site) => `${site.name}：${site.lastApply?.error ?? '未知错误'}`)
            .join(' · ')}
        </Alert>
      ) : null}

      {applyError === null ? null : (
        <Alert
          tone="danger"
          title="应用失败"
          hint={describeError(applyError).hint}
          className="mb-3"
          action={
            <Button variant="ghost" size="sm" onClick={() => applyMutation.reset()}>
              知道了
            </Button>
          }
        >
          <div className="flex flex-col gap-2">
            <span>{describeError(applyError).description}</span>
            <ApplyErrorOutput error={applyError} />
          </div>
        </Alert>
      )}

      <Toolbar
        bordered
        left={
          <>
            <SearchInput value={search} onChange={setSearch} placeholder="搜索站点或域名…" />
            <Tabs
              compact
              tabs={[
                { id: 'all', label: '全部', badge: sites.length },
                { id: 'enabled', label: '启用' },
                { id: 'disabled', label: '禁用' },
              ]}
              active={enabledFilter}
              onChange={(id) =>
                setEnabledFilter(id === 'enabled' ? 'enabled' : id === 'disabled' ? 'disabled' : 'all')
              }
            />
          </>
        }
        right={
          <span className="text-xs text-app-muted">
            共 {filtered.length} 个站点
            {sitesQuery.isFetching ? ' · 刷新中…' : ''}
          </span>
        }
      />

      {sitesQuery.isError ? (
        <ErrorState error={sitesQuery.error} onRetry={() => void sitesQuery.refetch()} />
      ) : sites.length === 0 && !sitesQuery.isLoading ? (
        <EmptyState
          icon={<Globe className="h-5 w-5" />}
          title="还没有站点"
          description="创建第一个站点草稿，预览生成的 Caddyfile 后应用到 Caddy。"
          action={
            <Button
              size="sm"
              icon={<Plus className="h-3.5 w-3.5" />}
              onClick={() => {
                setCreateDraft(EMPTY_SITE_DRAFT);
                setCreateOpen(true);
              }}
            >
              新建站点
            </Button>
          }
        />
      ) : (
        <DataTable
          columns={columns}
          rows={filtered}
          rowKey={(site) => site.id}
          loading={sitesQuery.isLoading || sitesQuery.isFetching}
          onRowClick={(site) => navigate(`/sites/${site.id}`)}
          empty="没有匹配的站点。"
          stickyHeader
        />
      )}

      {/* 新建抽屉 */}
      <Drawer
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="新建站点"
        description="保存后进入编辑页，可继续预览与单站应用。"
        size="xl"
      >
        <SiteForm
          value={createDraft}
          onChange={setCreateDraft}
          onSubmit={() => createMutation.mutate(createDraft)}
          submitting={createMutation.isPending}
          submitLabel="创建站点"
          onCancel={() => setCreateOpen(false)}
          onPreview={() => setPreviewRequest({ site: createDraft.config, validate: true })}
        />
      </Drawer>

      <SitePreviewDialog
        open={previewRequest !== null}
        onClose={() => setPreviewRequest(null)}
        request={previewRequest ?? { site: EMPTY_SITE_DRAFT.config }}
      />

      <SiteImportExportDialog open={importOpen} onClose={() => setImportOpen(false)} />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除站点"
        message={
          <span>
            确定删除站点 <strong className="text-app-text">{deleteTarget?.name}</strong> 的草稿？
            删除已应用的站点后，需要执行“应用全部更改”才会从 Caddy 中移除对应片段。
          </span>
        }
        confirmLabel="删除"
        loading={deleteMutation.isPending}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget !== null) deleteMutation.mutate(deleteTarget);
        }}
      />

      <ConfirmDialog
        open={applyConfirmOpen}
        danger={false}
        title="应用全部站点"
        message={
          <span>
            将渲染所有启用站点到 staging，执行 <code className="font-mono">caddy validate</code> 后备份并
            reload 线上配置。失败会自动回滚，线上保持不变。
            {pendingCount > 0 ? ` 当前有 ${pendingCount} 个站点待应用。` : ''}
          </span>
        }
        confirmLabel="开始应用"
        loading={applyMutation.isPending}
        onCancel={() => setApplyConfirmOpen(false)}
        onConfirm={() => {
          setApplyConfirmOpen(false);
          applyMutation.mutate();
        }}
      />

      <Modal
        open={applyResult !== null}
        onClose={() => setApplyResult(null)}
        title="应用成功"
        description={applyResult === null ? undefined : `apply #${applyResult.revision} · ${applyResult.appliedAt}`}
        size="lg"
        footer={
          <Button size="sm" onClick={() => setApplyResult(null)}>
            关闭
          </Button>
        }
      >
        {applyResult === null ? null : (
          <div className="flex flex-col gap-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={applyResult.reloaded ? 'success' : 'warning'}>
                {applyResult.reloaded ? 'reload 成功' : '未 reload'}
              </Badge>
              <Badge tone={applyResult.rolledBack ? 'danger' : 'neutral'}>
                {applyResult.rolledBack ? '已回滚' : '未回滚'}
              </Badge>
              <span className="text-xs text-app-muted">本次渲染 {applyResult.sites.length} 个站点</span>
            </div>
            <dl className="grid grid-cols-[6rem_1fr] gap-y-1 text-xs">
              <dt className="text-app-muted">Caddyfile</dt>
              <dd className="break-all font-mono">{applyResult.caddyfilePath}</dd>
              <dt className="text-app-muted">备份</dt>
              <dd className="break-all font-mono">{applyResult.backupPath ?? '—'}</dd>
            </dl>
            {applyResult.sites.length === 0 ? null : (
              <div className="flex flex-wrap gap-1">
                {applyResult.sites.map((site) => (
                  <SiteStatusBadge key={site.id} status={site.status} />
                ))}
              </div>
            )}
            {applyResult.warnings.length === 0 ? null : (
              <Alert tone="warning" title="警告">
                <ul className="list-disc pl-4">
                  {applyResult.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </Alert>
            )}
            <div>
              <p className="mb-1 text-xs text-app-muted">caddy 输出</p>
              <CodeBlock code={applyResult.caddyOutput} maxHeight={200} />
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function ApplyErrorOutput(props: { error: unknown }): JSX.Element | null {
  if (typeof props.error !== 'object' || props.error === null) return null;
  const details = (props.error as { details?: unknown }).details;
  if (typeof details !== 'object' || details === null) return null;
  const output = (details as { output?: unknown }).output;
  if (typeof output !== 'string' || output.length === 0) return null;
  return <CodeBlock code={output} maxHeight={180} />;
}
