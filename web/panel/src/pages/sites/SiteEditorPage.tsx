import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Rocket, Save, ShieldCheck } from 'lucide-react';
import type { SiteApplyResult, SiteConfig } from '../../api/types';
import {
  applySites,
  createSite,
  getSite,
  sitesKeys,
  updateSite,
} from '../../api/sites';
import type { SitePreviewRequest } from '../../api/sites';
import { certsKeys } from '../../api/certs';
import { getSystemInfo, systemKeys } from '../../api/system';
import { useAppMutation } from '../../lib/mutations';
import { formatDate } from '../../lib/format';
import { EMPTY_SITE_DRAFT, SiteForm, type SiteDraft } from './SiteForm';
import { SitePreviewDialog } from './SitePreviewDialog';
import { SiteStatusBadge } from './SiteStatusBadge';
import { Alert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { CodeBlock } from '../../components/ui/CodeBlock';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorState } from '../../components/ui/ErrorState';
import { Modal } from '../../components/ui/Modal';
import { PageHeader } from '../../components/ui/PageHeader';
import { RelativeTime } from '../../components/ui/RelativeTime';
import { Skeleton } from '../../components/ui/ErrorState';
import { Spinner } from '../../components/ui/Spinner';

export default function SiteEditorPage(): JSX.Element {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const isNew = id === undefined;
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [draft, setDraft] = useState<SiteDraft>(EMPTY_SITE_DRAFT);
  const [dirty, setDirty] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [applyConfirmOpen, setApplyConfirmOpen] = useState(false);
  const [applyResult, setApplyResult] = useState<SiteApplyResult | null>(null);

  const siteQuery = useQuery({
    queryKey: sitesKeys.detail(id ?? 'new'),
    queryFn: () => getSite(id ?? ''),
    enabled: !isNew,
    retry: 1,
  });

  const systemQuery = useQuery({
    queryKey: systemKeys.info(),
    queryFn: () => getSystemInfo(),
    staleTime: 30_000,
  });

  const caddy = systemQuery.data?.capabilities.caddy;
  const caddyAvailable = caddy === undefined ? true : caddy.available;

  const site = siteQuery.data;

  useEffect(() => {
    if (site === undefined) return;
    setDraft({ name: site.name, enabled: site.enabled, config: site.config });
    setDirty(false);
  }, [site?.id, site?.revision]);

  const applyConfig = async (config: SiteConfig): Promise<void> => {
    if (id === undefined) return;
    await updateSite(id, { config });
  };

  const saveMutation = useAppMutation({
    mutationFn: async (value: SiteDraft) => {
      if (isNew) {
        return createSite({ name: value.name.trim(), enabled: value.enabled, config: value.config });
      }
      return updateSite(id, { name: value.name.trim(), enabled: value.enabled, config: value.config });
    },
    successMessage: (saved) => (isNew ? `已创建站点 ${saved.name}` : '站点已保存'),
    successDescription: (saved) =>
      isNew
        ? '已进入编辑页；应用后才会写入 Caddy。'
        : `revision 已更新为 ${saved.revision}，应用后生效。`,
    invalidate: [sitesKeys.list()],
    onSuccess: (saved) => {
      queryClient.setQueryData(sitesKeys.detail(saved.id), saved);
      setDraft({ name: saved.name, enabled: saved.enabled, config: saved.config });
      setDirty(false);
      if (isNew) navigate(`/sites/${saved.id}`, { replace: true });
    },
  });

  const applyMutation = useAppMutation({
    mutationFn: async () => {
      if (site !== undefined && dirty) {
        // 先保存草稿，确保 apply 渲染的是当前表单内容。
        await applyConfig(draft.config);
      }
      return applySites({ siteIds: id === undefined ? undefined : [id] });
    },
    successMessage: (result) => `应用成功（apply #${result.revision}）`,
    successDescription: (result) =>
      result.rolledBack ? '已回滚到应用前的配置。' : undefined,
    invalidate: [sitesKeys.list(), sitesKeys.detail(id ?? 'new'), certsKeys.list()],
    onSuccess: (result) => {
      setApplyResult(result);
      setDirty(false);
    },
  });

  if (!isNew && siteQuery.isLoading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton lines={2} />
        <div className="flex items-center gap-2 text-xs text-app-muted">
          <Spinner size="sm" label="加载站点…" />
        </div>
      </div>
    );
  }

  if (!isNew && siteQuery.isError) {
    return <ErrorState error={siteQuery.error} onRetry={() => void siteQuery.refetch()} />;
  }

  if (!isNew && site === undefined) {
    return (
      <EmptyState
        title="站点不存在"
        description="可能已被删除，或当前连接的机器不是创建它的那台。"
        action={
          <Link to="/sites">
            <Button size="sm" variant="secondary">
              返回站点列表
            </Button>
          </Link>
        }
      />
    );
  }

  const previewRequest: SitePreviewRequest = site === undefined && !dirty
    ? { site: draft.config, validate: caddyAvailable }
    : dirty || isNew
      ? { site: draft.config, validate: caddyAvailable }
      : { siteId: id, validate: caddyAvailable };

  return (
    <div>
      <PageHeader
        breadcrumbs={
          <Link to="/sites" className="inline-flex items-center gap-1 text-app-muted hover:text-app-text">
            <ArrowLeft className="h-3 w-3" />
            站点列表
          </Link>
        }
        title={isNew ? '新建站点' : (draft.name.length === 0 ? '未命名站点' : draft.name)}
        description={
          isNew
            ? '填写结构化配置；保存后进入编辑页，可预览 Caddyfile 并单站应用。'
            : '保存只更新 JSON 草稿；应用才会校验并 reload Caddy。'
        }
        meta={
          <>
            {site === undefined ? null : <SiteStatusBadge status={site.status} />}
            {dirty ? <Badge tone="warning">未保存</Badge> : null}
          </>
        }
        actions={
          <>
            {isNew ? null : (
              <Button
                variant="secondary"
                size="sm"
                icon={<Rocket className="h-3.5 w-3.5" />}
                disabled={!caddyAvailable}
                title={caddyAvailable ? '应用此站点' : `caddy 不可用：${caddy?.reason ?? ''}`}
                loading={applyMutation.isPending}
                onClick={() => setApplyConfirmOpen(true)}
              >
                应用此站点
              </Button>
            )}
          </>
        }
      />

      {!caddyAvailable ? (
        <Alert
          tone="warning"
          title="Caddy 不可用：只能编辑与预览"
          hint="站点草稿仍可保存，预览可生成片段但不执行 validate；修复 Caddy 后再应用。"
          className="mb-3"
        >
          {caddy?.reason ?? 'capabilities.caddy.available=false'}
        </Alert>
      ) : null}

      {site !== undefined && site.lastApply !== null && !site.lastApply.ok ? (
        <Alert
          tone="danger"
          title="最近一次应用失败"
          hint="线上配置未改变；修正下方错误后重新应用。"
          className="mb-3"
        >
          {site.lastApply.error ?? '未知错误'}
        </Alert>
      ) : null}

      {applyMutation.error === null ? null : (
        <Alert
          tone="danger"
          title="应用失败"
          hint={applyMutation.error.message}
          className="mb-3"
          action={
            <Button variant="ghost" size="sm" onClick={() => applyMutation.reset()}>
              知道了
            </Button>
          }
        >
          <ApplyOutput error={applyMutation.error} />
        </Alert>
      )}

      <SiteForm
        value={draft}
        onChange={(next) => {
          setDraft(next);
          setDirty(true);
        }}
        onSubmit={() => saveMutation.mutate(draft)}
        submitting={saveMutation.isPending}
        submitLabel={isNew ? '创建站点' : '保存草稿'}
        onCancel={() => navigate('/sites')}
        onPreview={() => setPreviewOpen(true)}
        footerExtra={
          <>
            <span className="mr-auto inline-flex items-center gap-1 text-[11px] text-app-muted">
              <Save className="h-3 w-3" />
              {dirty ? '有未保存修改' : '已保存'}
            </span>
          </>
        }
        aside={
          <div className="flex flex-col gap-3">
            <Card>
              <CardHeader title="站点状态" />
              <CardBody className="flex flex-col gap-2 text-xs">
                <Row label="状态" value={site === undefined ? '未创建' : <SiteStatusBadge status={site.status} />} />
                <Row
                  label="revision"
                  value={site === undefined ? '—' : `${site.revision}`}
                />
                <Row
                  label="已应用"
                  value={site === undefined ? '—' : (site.appliedRevision ?? '—')}
                />
                <Row
                  label="最近应用"
                  value={
                    site?.lastApply === null || site?.lastApply === undefined ? (
                      '从未应用'
                    ) : (
                      <span className="flex flex-col gap-0.5">
                        <span className={site.lastApply.ok ? 'text-app-success' : 'text-app-danger'}>
                          {site.lastApply.ok ? '成功' : '失败'} · #{site.lastApply.revision}
                        </span>
                        <RelativeTime value={site.lastApply.at} className="text-[10px] text-app-muted" />
                      </span>
                    )
                  }
                />
                <Row
                  label="更新时间"
                  value={site === undefined ? '—' : formatDate(site.updatedAt)}
                />
                {site?.lastApply?.caddyfileHash === undefined ? null : (
                  <Row
                    label="配置哈希"
                    value={<span className="break-all font-mono text-[10px]">{site.lastApply.caddyfileHash}</span>}
                  />
                )}
              </CardBody>
            </Card>

            <Card>
              <CardHeader title="应用说明" />
              <CardBody className="flex flex-col gap-2 text-xs text-app-muted">
                <p className="flex items-start gap-1.5">
                  <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-app-success" />
                  应用会先保存草稿，再渲染片段、执行 caddy validate、备份并 reload；失败自动回滚。
                </p>
                <p>删除已应用站点需要到列表页执行全量“应用全部更改”才会从 Caddy 移除。</p>
                <p>证书在 Caddy 完成签发后出现在“证书”页；预览不会触发签发。</p>
              </CardBody>
            </Card>
          </div>
        }
      />

      <SitePreviewDialog
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        request={previewRequest}
      />

      <ConfirmDialog
        open={applyConfirmOpen}
        danger={false}
        title="应用此站点"
        message={
          <span>
            将保存当前草稿并只把该站点渲染进 staging，随后 validate + reload Caddy。
            未选中的站点保留现有配置。
          </span>
        }
        confirmLabel="应用"
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
        title="应用结果"
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
              <span className="text-xs text-app-muted">apply #{applyResult.revision}</span>
            </div>
            <p className="break-all font-mono text-xs text-app-muted">
              {applyResult.caddyfilePath}
            </p>
            {applyResult.rolledBack ? (
              <Alert tone="danger" title="已回滚">
                reload 失败，已恢复备份并重载。请查看下方 caddy 输出。
              </Alert>
            ) : null}
            {applyResult.warnings.length === 0 ? null : (
              <Alert tone="warning" title="警告">
                <ul className="list-disc pl-4">
                  {applyResult.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </Alert>
            )}
            <CodeBlock code={applyResult.caddyOutput} maxHeight={220} />
          </div>
        )}
      </Modal>
    </div>
  );
}

function Row(props: { label: string; value: ReactNode }): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-2">
      <span className="text-app-muted">{props.label}</span>
      <span className="text-right text-app-text">{props.value}</span>
    </div>
  );
}

function ApplyOutput(props: { error: unknown }): JSX.Element | null {
  if (typeof props.error !== 'object' || props.error === null) return null;
  const details = (props.error as { details?: unknown }).details;
  if (typeof details !== 'object' || details === null) return null;
  const output = (details as { output?: unknown }).output;
  if (typeof output !== 'string' || output.length === 0) return null;
  return <CodeBlock code={output} maxHeight={160} />;
}
