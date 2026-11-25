import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Boxes, Download, HardDrive, RefreshCw, Trash2, TriangleAlert } from 'lucide-react';
import type { ImageSummary } from '../../api/types';
import { containersKeys, listImages, removeImage } from '../../api/containers';
import { describeError, isAppError } from '../../api/errors';
import { scopedKey } from '../../lib/query-keys';
import { useAppMutation } from '../../lib/mutations';
import { formatBytes, formatDate } from '../../lib/format';
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
import { Toolbar } from '../../components/ui/Toolbar';
import { Tooltip } from '../../components/ui/Tooltip';
import { ContainerTabs } from './ContainerTabs';
import { ImagePullDialog } from './ImagePullDialog';

export default function ImagesPage(): JSX.Element {
  const [search, setSearch] = useState('');
  const [pullOpen, setPullOpen] = useState(false);
  const [confirm, setConfirm] = useState<ImageSummary | null>(null);
  const [force, setForce] = useState(false);

  const imagesQuery = useQuery({
    queryKey: containersKeys.images({ all: true }),
    queryFn: () => listImages({ all: true, limit: 200 }),
    refetchInterval: 30_000,
    retry: 1,
  });

  const images = imagesQuery.data?.items ?? [];
  const unavailable =
    imagesQuery.data?.available === false || isAppError(imagesQuery.error, 'UNAVAILABLE');

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (needle.length === 0) return images;
    return images.filter((image) => {
      const tags = image.repoTags.length === 0 ? ['<none>'] : image.repoTags;
      return [...tags, ...image.repoDigests, image.id].some((value) =>
        value.toLowerCase().includes(needle),
      );
    });
  }, [images, search]);

  const totals = useMemo(() => {
    let sizeBytes = 0;
    let dangling = 0;
    for (const image of images) {
      sizeBytes += image.sizeBytes;
      if (image.dangling) dangling += 1;
    }
    return { sizeBytes, dangling };
  }, [images]);

  const imagesRoot = scopedKey('images', 'list');
  const removeMutation = useAppMutation<
    { deleted: true; id: string },
    { id: string; force: boolean }
  >({
    mutationFn: ({ id, force: withForce }) => removeImage(id, withForce),
    successMessage: '镜像已删除',
    errorMessage: '删除镜像失败',
    invalidate: [imagesRoot],
    onSuccess: () => setConfirm(null),
    onError: () => undefined,
  });

  const columns: Column<ImageSummary>[] = [
    {
      key: 'repoTags',
      header: '仓库标签',
      sortable: true,
      sortValue: (image) => image.repoTags[0] ?? image.id,
      render: (image) => {
        if (image.repoTags.length === 0) {
          return (
            <div className="flex items-center gap-1.5">
              <Badge tone={image.dangling ? 'warning' : 'neutral'}>
                {image.dangling ? '悬空镜像' : '<none>'}
              </Badge>
              <span className="font-mono text-[10px] text-app-muted">{shortId(image.id)}</span>
            </div>
          );
        }
        const first = image.repoTags[0] ?? '';
        return (
          <div className="min-w-0">
            <p className="max-w-[24rem] truncate font-mono text-xs text-app-text" title={image.repoTags.join('\n')}>
              {first}
            </p>
            <div className="flex flex-wrap items-center gap-1">
              {image.repoTags.length > 1 ? (
                <Badge tone="neutral" title={image.repoTags.slice(1).join('\n')}>
                  +{image.repoTags.length - 1} 个标签
                </Badge>
              ) : null}
              {image.dangling ? <Badge tone="warning">悬空</Badge> : null}
            </div>
          </div>
        );
      },
    },
    {
      key: 'id',
      header: '镜像 ID',
      sortable: true,
      sortValue: (image) => image.id,
      render: (image) => (
        <span className="font-mono text-[11px] text-app-muted" title={image.id}>
          {shortId(image.id)}
        </span>
      ),
    },
    {
      key: 'sizeBytes',
      header: '大小',
      align: 'right',
      sortable: true,
      sortValue: (image) => image.sizeBytes,
      render: (image) => (
        <span className="tabular-nums text-xs text-app-text">{formatBytes(image.sizeBytes)}</span>
      ),
    },
    {
      key: 'createdAt',
      header: '创建时间',
      sortable: true,
      sortValue: (image) => image.createdAt,
      render: (image) => (
        <span className="whitespace-nowrap text-xs text-app-muted" title={formatDate(image.createdAt)}>
          <RelativeTime value={image.createdAt} />
        </span>
      ),
    },
    {
      key: 'actions',
      header: '操作',
      align: 'right',
      width: 72,
      render: (image) => (
        <div className="flex justify-end" onClick={(event) => event.stopPropagation()}>
          <Tooltip content="删除镜像">
            <Button
              aria-label="删除镜像"
              variant="ghost"
              size="icon"
              onClick={() => {
                setForce(false);
                setConfirm(image);
              }}
              icon={<Trash2 className="h-3.5 w-3.5 text-app-danger" />}
            />
          </Tooltip>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="镜像"
        description="查看本机 Docker 镜像，拉取或删除镜像。"
        actions={
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw className="h-4 w-4" />}
              loading={imagesQuery.isFetching}
              onClick={() => {
                void imagesQuery.refetch();
              }}
            >
              刷新
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<Download className="h-4 w-4" />}
              disabled={unavailable}
              onClick={() => setPullOpen(true)}
            >
              拉取镜像
            </Button>
          </>
        }
      />
      <ContainerTabs />

      {unavailable ? (
        <UnavailableAlert
          available={imagesQuery.data?.available === false}
          error={imagesQuery.data === undefined ? imagesQuery.error : undefined}
          reason={imagesQuery.data?.reason}
          title="Docker 不可用"
          hint="请确认目标机器已安装 docker CLI、daemon 正在运行，且 agent 进程有权限访问 Docker socket。"
          action={
            <Button
              variant="secondary"
              size="sm"
              loading={imagesQuery.isFetching}
              onClick={() => {
                void imagesQuery.refetch();
              }}
            >
              重新探测
            </Button>
          }
        />
      ) : imagesQuery.error !== null && imagesQuery.error !== undefined && imagesQuery.data === undefined ? (
        <ErrorState
          error={imagesQuery.error}
          onRetry={() => {
            void imagesQuery.refetch();
          }}
        />
      ) : (
        <>
          {imagesQuery.error !== null && imagesQuery.error !== undefined ? (
            <Alert tone="warning" title="镜像列表刷新失败" className="mb-3">
              {describeError(imagesQuery.error).description}
            </Alert>
          ) : null}

          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            <StatCard
              label="镜像总数"
              value={imagesQuery.data?.total ?? images.length}
              hint="包含悬空镜像"
              icon={<Boxes className="h-4 w-4" />}
              loading={imagesQuery.isLoading}
            />
            <StatCard
              label="占用空间"
              value={formatBytes(totals.sizeBytes)}
              hint="按镜像大小合计，未去重共享层"
              icon={<HardDrive className="h-4 w-4" />}
              tone="info"
              loading={imagesQuery.isLoading}
            />
            <StatCard
              label="悬空镜像"
              value={totals.dangling}
              hint="无标签且未被引用的镜像"
              icon={<TriangleAlert className="h-4 w-4" />}
              tone={totals.dangling > 0 ? 'warning' : 'neutral'}
              loading={imagesQuery.isLoading}
            />
          </div>

          <Toolbar
            left={
              <SearchInput
                value={search}
                onChange={setSearch}
                placeholder="搜索仓库标签或镜像 ID…"
                className="w-72"
              />
            }
            right={
              <span className="text-xs text-app-muted">
                显示 {filtered.length} 个镜像
                {imagesQuery.data?.nextCursor !== null && imagesQuery.data?.nextCursor !== undefined
                  ? '（结果已截断）'
                  : ''}
              </span>
            }
          />

          <DataTable
            columns={columns}
            rows={filtered}
            rowKey={(image) => image.id}
            loading={imagesQuery.isLoading}
            dense
            empty={
              search.trim().length > 0
                ? '没有匹配的镜像，请调整搜索关键词。'
                : '本机还没有镜像。点击右上角「拉取镜像」从仓库下载。'
            }
          />
        </>
      )}

      <ImagePullDialog open={pullOpen} onClose={() => setPullOpen(false)} />

      <ConfirmDialog
        open={confirm !== null}
        title="删除镜像"
        message={
          confirm === null ? null : (
            <div className="flex flex-col gap-2">
              <p>
                确认删除镜像{' '}
                <span className="font-mono text-app-text">
                  {confirm.repoTags[0] ?? shortId(confirm.id)}
                </span>
                ？
              </p>
              <p className="font-mono text-[11px] text-app-muted">{confirm.id}</p>
              <div className="rounded-md border border-app-border bg-app-elevated/60 p-2">
                <Checkbox
                  label="强制删除（force）"
                  description="即使镜像被容器引用也尝试删除；正在运行的容器仍会阻止删除。"
                  checked={force}
                  onChange={(event) => setForce(event.target.checked)}
                />
              </div>
              <p className="text-xs">删除镜像不会删除使用它的容器，但可能导致容器无法重新创建。</p>
            </div>
          )
        }
        confirmLabel="确认删除"
        danger
        loading={removeMutation.isPending}
        onConfirm={async () => {
          if (confirm === null) return;
          await removeMutation.mutateAsync({ id: confirm.id, force });
        }}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}

function shortId(id: string): string {
  return id.replace(/^sha256:/, '').slice(0, 12);
}
