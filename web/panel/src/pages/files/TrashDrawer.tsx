import { useEffect, useMemo, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { RotateCcw, Trash2 } from 'lucide-react';
import type { TrashEntry } from '../../api/types';
import { emptyTrash, filesKeys, listTrash, restoreTrash } from '../../api/files';
import { describeError, isAppError } from '../../api/errors';
import { useAppMutation } from '../../lib/mutations';
import { scopedKey } from '../../lib/query-keys';
import { formatBytes, formatDate } from '../../lib/format';
import { Alert, UnavailableAlert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { DataTable, type Column } from '../../components/ui/DataTable';
import { Drawer } from '../../components/ui/Drawer';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorState } from '../../components/ui/ErrorState';
import { FileIcon } from '../../components/ui/FileIcon';
import { Input } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { Pagination } from '../../components/ui/Pagination';
import { RelativeTime } from '../../components/ui/RelativeTime';

const TRASH_PAGE_SIZE = 100;

function trashTypeLabel(entry: TrashEntry): string {
  if (entry.type === 'directory') return '目录';
  if (entry.type === 'symlink') return '符号链接';
  if (entry.type === 'file') return '文件';
  return '其他';
}

export interface TrashDrawerProps {
  open: boolean;
  onClose(): void;
}

/** 回收站：分页列表、恢复到原路径、输入 DELETE 彻底删除、清空。 */
export function TrashDrawer(props: TrashDrawerProps): JSX.Element {
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [restoreTarget, setRestoreTarget] = useState<TrashEntry | null>(null);
  const [overwriteEntry, setOverwriteEntry] = useState<TrashEntry | null>(null);
  const [purgeEntry, setPurgeEntry] = useState<TrashEntry | null>(null);
  const [purgeConfirm, setPurgeConfirm] = useState('');
  const [emptyOpen, setEmptyOpen] = useState(false);

  useEffect(() => {
    if (!props.open) {
      setCursors([undefined]);
      setRestoreTarget(null);
      setOverwriteEntry(null);
      setPurgeEntry(null);
      setPurgeConfirm('');
      setEmptyOpen(false);
    }
  }, [props.open]);

  const pageQueries = useQueries({
    queries: cursors.map((cursor) => ({
      queryKey: filesKeys.trash({ limit: TRASH_PAGE_SIZE, cursor }),
      queryFn: () => listTrash({ limit: TRASH_PAGE_SIZE, cursor }),
      enabled: props.open,
    })),
  });

  const entries = useMemo(() => {
    const seen = new Set<string>();
    const list: TrashEntry[] = [];
    for (const query of pageQueries) {
      for (const entry of query.data?.items ?? []) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        list.push(entry);
      }
    }
    return list;
  }, [pageQueries]);

  const firstPage = pageQueries[0];
  const loading = firstPage?.isLoading === true;
  const error = pageQueries.find((query) => query.error !== null && query.error !== undefined)?.error;
  const nextCursor =
    pageQueries.length === 0
      ? null
      : (pageQueries[pageQueries.length - 1]?.data?.nextCursor ?? null);

  const restoreMutation = useAppMutation({
    mutationFn: (variables: { entry: TrashEntry; overwrite: boolean }) =>
      restoreTrash({ trashId: variables.entry.id, overwrite: variables.overwrite }),
    successMessage: (result) => `已恢复到 ${result.path}`,
    invalidate: [
      scopedKey('files', 'trash'),
      scopedKey('files', 'list'),
      scopedKey('files', 'roots'),
    ],
    onSuccess: () => {
      setRestoreTarget(null);
      setOverwriteEntry(null);
    },
    onError: (mutationError, variables) => {
      if (!variables.overwrite && isAppError(mutationError, 'CONFLICT')) {
        setOverwriteEntry(variables.entry);
      }
    },
  });

  const purgeMutation = useAppMutation({
    mutationFn: (entry: TrashEntry) => emptyTrash({ trashIds: [entry.id] }),
    successMessage: (result) => `已彻底删除 ${result.deleted} 项`,
    successDescription: '该操作不可恢复。',
    invalidate: [scopedKey('files', 'trash'), scopedKey('files', 'roots')],
    onSuccess: () => {
      setPurgeEntry(null);
      setPurgeConfirm('');
    },
  });

  const emptyMutation = useAppMutation({
    mutationFn: () => emptyTrash({ all: true }),
    successMessage: (result) => `已清空回收站（${result.deleted} 项）`,
    successDescription: '所有回收站文件已彻底删除，无法恢复。',
    invalidate: [scopedKey('files', 'trash'), scopedKey('files', 'roots')],
    onSuccess: () => setEmptyOpen(false),
  });

  const columns: Column<TrashEntry>[] = [
    {
      key: 'originalPath',
      header: '原路径',
      render: (entry) => (
        <div className="flex min-w-0 items-center gap-2">
          <FileIcon type={entry.type} name={entry.originalPath} />
          <div className="min-w-0">
            <p className="truncate font-mono text-xs text-app-text" title={entry.originalPath}>
              {entry.originalPath}
            </p>
            <p className="text-[10px] text-app-muted">根：{entry.root}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'type',
      header: '类型',
      width: 100,
      render: (entry) => <Badge tone="neutral">{trashTypeLabel(entry)}</Badge>,
    },
    {
      key: 'sizeBytes',
      header: '大小',
      width: 100,
      align: 'right',
      render: (entry) => (
        <span className="font-mono text-xs text-app-muted">{formatBytes(entry.sizeBytes)}</span>
      ),
    },
    {
      key: 'trashedAt',
      header: '删除时间',
      width: 140,
      render: (entry) => (
        <RelativeTime value={entry.trashedAt} className="text-xs text-app-muted" />
      ),
    },
    {
      key: 'actions',
      header: '',
      width: 160,
      render: (entry) => (
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="secondary"
            size="xs"
            icon={<RotateCcw className="h-3 w-3" />}
            onClick={() => setRestoreTarget(entry)}
          >
            恢复
          </Button>
          <Button
            variant="ghost"
            size="xs"
            icon={<Trash2 className="h-3 w-3" />}
            className="text-app-danger hover:bg-app-danger/10 hover:text-app-danger"
            onClick={() => {
              purgeMutation.reset();
              setPurgeEntry(entry);
              setPurgeConfirm('');
            }}
          >
            彻底删除
          </Button>
        </div>
      ),
    },
  ];

  const purgeReady = purgeEntry !== null && purgeConfirm.trim() === 'DELETE';

  return (
    <>
      <Drawer
        open={props.open}
        onClose={props.onClose}
        title="回收站"
        description="删除的文件会保留在 agent 的回收站目录，可恢复或彻底删除。"
        size="xl"
        footer={
          <>
            <span className="mr-auto text-xs text-app-muted">共 {entries.length} 项</span>
            <Button
              variant="ghost"
              size="sm"
              icon={<RotateCcw className="h-3.5 w-3.5" />}
              onClick={() => void Promise.all(pageQueries.map((query) => query.refetch()))}
              loading={pageQueries.some((query) => query.isFetching)}
            >
              刷新
            </Button>
            <Button
              variant="danger"
              size="sm"
              icon={<Trash2 className="h-3.5 w-3.5" />}
              onClick={() => setEmptyOpen(true)}
              disabled={entries.length === 0}
            >
              清空回收站
            </Button>
          </>
        }
      >
        {props.open ? (
          <div className="flex flex-col gap-3">
            <Alert tone="info" title="回收站说明">
              恢复会写回原路径；若原路径已存在同名文件，会提示是否覆盖。彻底删除与清空都无法恢复。
            </Alert>
            {error !== null && error !== undefined ? (
              <ErrorState
                error={error}
                title="回收站加载失败"
                onRetry={() => void Promise.all(pageQueries.map((query) => query.refetch()))}
              />
            ) : null}
            {firstPage?.data?.available === false ? (
              <UnavailableAlert
                available={false}
                reason={firstPage?.data?.reason ?? 'agent 报告回收站能力不可用。'}
                title="回收站不可用"
                hint="请检查 agent 的回收站目录权限（$MPANEL_HOME/trash）。"
              />
            ) : null}
            <DataTable
              columns={columns}
              rows={entries}
              rowKey={(entry) => entry.id}
              loading={loading}
              empty={
                <EmptyState
                  compact
                  title="回收站为空"
                  description="在文件列表中删除的项目会先移动到这里。"
                />
              }
              dense
            />
            <Pagination
              nextCursor={nextCursor}
              onNext={(cursor) => setCursors((prev) => [...prev, cursor])}
              onReset={() => setCursors([undefined])}
              loading={loading}
              loaded={entries.length}
            />
          </div>
        ) : null}
      </Drawer>

      <ConfirmDialog
        open={restoreTarget !== null}
        title="恢复到原路径"
        message={
          restoreTarget === null
            ? ''
            : `将 ${restoreTarget.originalPath} 恢复到文件根 “${restoreTarget.root}” 的原路径。若目标已存在，会再询问是否覆盖。`
        }
        confirmLabel="恢复"
        loading={restoreMutation.isPending}
        onConfirm={() => {
          if (restoreTarget === null) return;
          const target = restoreTarget;
          setRestoreTarget(null);
          restoreMutation.mutate({ entry: target, overwrite: false });
        }}
        onCancel={() => setRestoreTarget(null)}
      />

      <ConfirmDialog
        open={overwriteEntry !== null}
        title="原路径已存在同名文件"
        message={
          overwriteEntry === null
            ? ''
            : `恢复 ${overwriteEntry.originalPath} 时会覆盖目标位置已存在的同名项目。是否覆盖？`
        }
        confirmLabel="覆盖并恢复"
        danger
        loading={restoreMutation.isPending}
        onConfirm={() => {
          if (overwriteEntry === null) return;
          restoreMutation.mutate({ entry: overwriteEntry, overwrite: true });
        }}
        onCancel={() => setOverwriteEntry(null)}
      />

      <Modal
        open={purgeEntry !== null}
        onClose={() => {
          setPurgeEntry(null);
          setPurgeConfirm('');
        }}
        title="彻底删除"
        description="该操作不可恢复。"
        size="sm"
        footer={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setPurgeEntry(null);
                setPurgeConfirm('');
              }}
            >
              取消
            </Button>
            <Button
              variant="danger"
              size="sm"
              icon={<Trash2 className="h-3.5 w-3.5" />}
              disabled={!purgeReady}
              loading={purgeMutation.isPending}
              onClick={() => {
                if (purgeEntry !== null) purgeMutation.mutate(purgeEntry);
              }}
            >
              彻底删除
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Alert tone="danger" title="不可恢复的操作">
            将从 agent 磁盘上直接删除
            {purgeEntry === null ? '该项目' : ` ${purgeEntry.originalPath}`}，无法再恢复。
          </Alert>
          <label className="flex flex-col gap-1.5 text-xs text-app-text">
            请输入 <span className="font-mono font-semibold">DELETE</span> 确认：
            <Input
              value={purgeConfirm}
              onChange={(event) => setPurgeConfirm(event.target.value)}
              placeholder="DELETE"
              autoFocus
              className="font-mono"
            />
          </label>
          {purgeMutation.error !== null ? (
            <Alert tone="danger" title="彻底删除失败">
              {describeError(purgeMutation.error).description}
            </Alert>
          ) : null}
          {purgeEntry !== null ? (
            <p className="text-[11px] text-app-muted">
              删除时间：{formatDate(purgeEntry.trashedAt)}
            </p>
          ) : null}
        </div>
      </Modal>

      <ConfirmDialog
        open={emptyOpen}
        title="清空回收站"
        message={`将彻底删除回收站内的 ${entries.length} 个项目，无法恢复。`}
        confirmLabel="清空"
        danger
        loading={emptyMutation.isPending}
        onConfirm={() => emptyMutation.mutate(undefined)}
        onCancel={() => setEmptyOpen(false)}
      />
    </>
  );
}
