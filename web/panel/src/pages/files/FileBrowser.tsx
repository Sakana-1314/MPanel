import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Folder, FolderOpen, HardDrive, RefreshCw, ShieldAlert } from 'lucide-react';
import type { FileItem, FileRoot } from '../../api/types';
import {
  chmod,
  copy,
  deleteFile,
  downloadFile,
  filesKeys,
  listFiles,
  listRoots,
  mkdir,
  rename,
  statFile,
  writeFile,
} from '../../api/files';
import { AppError, describeError, isAppError } from '../../api/errors';
import { toastError, useAppMutation } from '../../lib/mutations';
import { scopedKey } from '../../lib/query-keys';
import { useActiveConnection, useSelectedMachineId } from '../../lib/connection-store';
import { cn } from '../../lib/cn';
import { formatBytes } from '../../lib/format';
import { Alert, UnavailableAlert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardHeader } from '../../components/ui/Card';
import { Checkbox } from '../../components/ui/Checkbox';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { EmptyState } from '../../components/ui/EmptyState';
import { ErrorState, LoadingSkeleton } from '../../components/ui/ErrorState';
import { FormField } from '../../components/ui/FormField';
import { Input } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { Pagination } from '../../components/ui/Pagination';
import { useToast } from '../../components/ui/Toast';
import { ArchiveDialog, ExtractDialog } from './ArchiveDialog';
import { Breadcrumbs, parentVirtualPath, joinVirtualPath, normalizeVirtualPath, validateEntryName, validateVirtualPath } from './Breadcrumbs';
import { FileEditorDrawer } from './FileEditorDrawer';
import { FileSearchPanel } from './FileSearchPanel';
import { FileTable } from './FileTable';
import { FileToolbar } from './FileToolbar';
import { TrashDrawer } from './TrashDrawer';
import { UploadDialog } from './UploadDialog';

const PAGE_SIZE = 200;
const RECENT_STORAGE_KEY = 'mpanel.files.recent.v1';
const MAX_RECENT = 24;

interface RecentDir {
  root: string;
  path: string;
  at: number;
}

function loadRecent(): RecentDir[] {
  try {
    const raw = window.localStorage.getItem(RECENT_STORAGE_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is RecentDir => {
        if (typeof entry !== 'object' || entry === null) return false;
        const candidate = entry as Partial<RecentDir>;
        return (
          typeof candidate.root === 'string' &&
          typeof candidate.path === 'string' &&
          typeof candidate.at === 'number'
        );
      })
      .slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

function storeRecent(list: readonly RecentDir[]): void {
  try {
    window.localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // 本地存储不可用时仅影响快捷入口，不影响文件操作。
  }
}

function initialOctal(mode: string): string {
  const match = /[0-7]{3,4}/.exec(mode);
  return match?.[0] ?? '644';
}

function fileErrorTitle(error: unknown): string | null {
  if (isAppError(error, 'FORBIDDEN')) return '无权限访问该路径';
  if (isAppError(error, 'BAD_REQUEST')) return '路径不合法或越界';
  if (isAppError(error, 'NOT_FOUND')) return '目录不存在或已被删除';
  return null;
}

function fileErrorHint(error: unknown): string {
  if (isAppError(error, 'FORBIDDEN')) {
    return '请确认 agent 进程对文件根目录有访问权限，且路径未通过符号链接逃逸到根外。';
  }
  if (isAppError(error, 'BAD_REQUEST')) {
    return '路径必须是文件根内的 POSIX 虚拟路径，不能包含 “..”、反斜杠、盘符或控制字符。';
  }
  if (isAppError(error, 'NOT_FOUND')) {
    return '目录可能已被其他进程删除或重命名，可回到根目录重新浏览。';
  }
  return '请检查路径与文件根配置后重试。';
}

/* ------------------------------ 对话框子组件 ------------------------------ */

interface NameDialogProps {
  open: boolean;
  title: string;
  description: ReactNode;
  label: string;
  value: string;
  placeholder?: string;
  submitLabel: string;
  submitting: boolean;
  validation: string | null;
  error: unknown;
  errorTitle: string;
  onValueChange(value: string): void;
  onClose(): void;
  onSubmit(): void;
}

function NameDialog(props: NameDialogProps): JSX.Element {
  const errorInfo = props.error === null ? null : describeError(props.error, props.errorTitle);
  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title={props.title}
      description={props.description}
      size="sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={props.onClose} disabled={props.submitting}>
            取消
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={props.onSubmit}
            loading={props.submitting}
            disabled={props.value.trim().length === 0}
          >
            {props.submitLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label={props.label} required error={props.validation}>
          <Input
            value={props.value}
            onChange={(event) => props.onValueChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') props.onSubmit();
            }}
            placeholder={props.placeholder}
            invalid={props.validation !== null}
            autoFocus
          />
        </FormField>
        {errorInfo !== null ? (
          <Alert tone="danger" title={errorInfo.title} hint={errorInfo.hint}>
            {errorInfo.description}
          </Alert>
        ) : null}
      </div>
    </Modal>
  );
}

interface TransferDialogProps {
  open: boolean;
  mode: 'copy' | 'move';
  items: readonly FileItem[];
  destination: string;
  overwrite: boolean;
  validation: string | null;
  submitting: boolean;
  error: unknown;
  onDestinationChange(value: string): void;
  onOverwriteChange(value: boolean): void;
  onSubmit(): void;
  onClose(): void;
}

function TransferDialog(props: TransferDialogProps): JSX.Element {
  const errorInfo = props.error === null ? null : describeError(props.error, `${props.mode === 'copy' ? '复制' : '移动'}失败`);
  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title={props.mode === 'copy' ? '复制项目' : '移动项目'}
      description={`共 ${props.items.length} 项；仅在同一个文件根内操作。`}
      size="md"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={props.onClose} disabled={props.submitting}>
            取消
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={props.onSubmit}
            loading={props.submitting}
            disabled={props.items.length === 0}
          >
            {props.mode === 'copy' ? '复制到目标目录' : '移动到目标目录'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="rounded-lg border border-app-border bg-app-elevated/40 px-3 py-2">
          <p className="mb-1 text-xs font-medium text-app-text">源项目</p>
          <ul className="flex max-h-28 flex-col gap-0.5 overflow-auto font-mono text-[11px] text-app-muted">
            {props.items.slice(0, 20).map((item) => (
              <li key={item.path} className="truncate" title={item.path}>
                {item.path}
                {item.type === 'directory' ? '/' : ''}
              </li>
            ))}
            {props.items.length > 20 ? <li>…… 其余 {props.items.length - 20} 项</li> : null}
          </ul>
        </div>

        <FormField
          label="目标目录"
          required
          description="目标必须是当前根内已存在的目录；每个项目保留原名称。"
          error={props.validation}
        >
          <Input
            value={props.destination}
            onChange={(event) => props.onDestinationChange(event.target.value)}
            placeholder="/target/dir"
            className="font-mono"
            invalid={props.validation !== null}
          />
        </FormField>

        <Checkbox
          checked={props.overwrite}
          onChange={(event) => props.onOverwriteChange(event.target.checked)}
          label="覆盖目标位置已存在的同名项目"
          description="默认不覆盖；同名冲突会中止操作并返回 CONFLICT。"
        />

        <Alert tone="info" title="操作说明">
          {props.mode === 'copy'
            ? '复制目录时上限为 10 万文件 / 5 GiB；中途失败时已复制的内容会保留。'
            : '移动通过同根 rename 实现；跨根移动请先复制到目标根，再删除源文件。'}
        </Alert>

        {errorInfo !== null ? (
          <Alert tone="danger" title={errorInfo.title} hint={errorInfo.hint}>
            {errorInfo.description}
          </Alert>
        ) : null}
      </div>
    </Modal>
  );
}

interface ChmodDialogProps {
  open: boolean;
  target: FileItem | null;
  mode: string;
  validation: string | null;
  submitting: boolean;
  error: unknown;
  onModeChange(value: string): void;
  onSubmit(): void;
  onClose(): void;
}

const OCTAL_PRESETS = ['644', '755', '600', '640', '700', '777'] as const;

function ChmodDialog(props: ChmodDialogProps): JSX.Element {
  const errorInfo = props.error === null ? null : describeError(props.error, '修改权限失败');
  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title="修改文件权限"
      description={props.target === null ? undefined : props.target.path}
      size="sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={props.onClose} disabled={props.submitting}>
            取消
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={props.onSubmit}
            loading={props.submitting}
          >
            应用权限
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField
          label="八进制权限"
          required
          description="3~4 位八进制（如 644、0755）；Windows 只映射只读位。"
          error={props.validation}
        >
          <Input
            value={props.mode}
            onChange={(event) => props.onModeChange(event.target.value)}
            placeholder="644"
            className="font-mono"
            maxLength={4}
            invalid={props.validation !== null}
            autoFocus
          />
        </FormField>
        <div className="flex flex-wrap gap-1.5">
          {OCTAL_PRESETS.map((preset) => (
            <Button
              key={preset}
              variant={preset === props.mode ? 'primary' : 'secondary'}
              size="xs"
              className="font-mono"
              onClick={() => props.onModeChange(preset)}
            >
              {preset}
            </Button>
          ))}
        </div>
        <Alert tone="info" title="权限说明">
          644 = 属主读写、其他只读；755 = 属主读写执行、其他读执行；600 = 仅属主读写。
        </Alert>
        {errorInfo !== null ? (
          <Alert tone="danger" title={errorInfo.title} hint={errorInfo.hint}>
            {errorInfo.description}
          </Alert>
        ) : null}
      </div>
    </Modal>
  );
}

/* -------------------------------- 主组件 -------------------------------- */

/** 文件管理主界面：左侧文件根/常用目录，右侧文件表格与全部操作。 */
export function FileBrowser(): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const toast = useToast();
  const activeConnection = useActiveConnection();
  const selectedMachineId = useSelectedMachineId();

  const root = searchParams.get('root') ?? '';
  const path = normalizeVirtualPath(searchParams.get('path') ?? '/');
  const showHidden = searchParams.get('hidden') === '1';
  const sortKey = searchParams.get('sort');
  const sortDirection: 'asc' | 'desc' = searchParams.get('dir') === 'desc' ? 'desc' : 'asc';
  const sort = sortKey === null ? null : { key: sortKey, direction: sortDirection };
  const highlight = searchParams.get('highlight');
  const editPath = searchParams.get('edit');
  const searchOpen = searchParams.get('search') === '1';
  const trashOpen = searchParams.get('trash') === '1';

  const updateParams = useCallback(
    (patch: Record<string, string | null>, replace = false): void => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        for (const [key, value] of Object.entries(patch)) {
          if (value === null || value.length === 0) next.delete(key);
          else next.set(key, value);
        }
        return next;
      }, { replace });
    },
    [setSearchParams],
  );

  const rootsQuery = useQuery({ queryKey: filesKeys.roots(), queryFn: listRoots });
  const roots = rootsQuery.data?.items ?? [];
  const activeRoot = roots.find((entry) => entry.name === root);
  const writable = activeRoot?.writable === true;

  useEffect(() => {
    if (roots.length === 0) return;
    if (activeRoot !== undefined) return;
    const first = roots[0];
    if (first === undefined) return;
    updateParams(
      { root: first.name, path: '/', edit: null, highlight: null, search: null },
      true,
    );
  }, [roots, activeRoot, updateParams]);

  /* ------------------------------ 目录分页 ------------------------------ */

  const listScope = `${activeConnection?.id ?? 'none'}\u0000${selectedMachineId ?? ''}\u0000${root}\u0000${path}\u0000${showHidden ? '1' : '0'}`;
  const [pagination, setPagination] = useState<{ scope: string; cursors: Array<string | undefined> }>({
    scope: '',
    cursors: [undefined],
  });
  const cursors = pagination.scope === listScope ? pagination.cursors : [undefined];
  const canList =
    root.length > 0 && activeRoot !== undefined && rootsQuery.data?.available !== false;

  const pageQueries = useQueries({
    queries: canList
      ? cursors.map((cursor) => ({
          queryKey: filesKeys.list({
            root,
            path,
            showHidden: showHidden ? true : undefined,
            limit: PAGE_SIZE,
            cursor,
          }),
          queryFn: () =>
            listFiles({
              root,
              path,
              showHidden: showHidden ? true : undefined,
              limit: PAGE_SIZE,
              cursor,
            }),
        }))
      : [],
  });

  const items = useMemo(() => {
    const seen = new Set<string>();
    const list: FileItem[] = [];
    for (const query of pageQueries) {
      for (const item of query.data?.items ?? []) {
        if (seen.has(item.path)) continue;
        seen.add(item.path);
        list.push(item);
      }
    }
    return list;
  }, [pageQueries]);

  const listLoading = canList && pageQueries.length > 0 && pageQueries[0]?.isLoading === true;
  const listFetching = pageQueries.some((query) => query.isFetching);
  const listError =
    pageQueries.find((query) => query.error !== null && query.error !== undefined)?.error ?? null;
  const nextCursor =
    pageQueries.length === 0 ? null : (pageQueries[pageQueries.length - 1]?.data?.nextCursor ?? null);
  const listUnavailableReason =
    pageQueries[0]?.data?.available === false
      ? (pageQueries[0]?.data?.reason ?? 'agent 报告文件列表能力不可用。')
      : null;
  const addPage = (cursor: string): void => {
    setPagination({ scope: listScope, cursors: [...cursors, cursor] });
  };
  const refetchList = (): void => {
    void Promise.all(pageQueries.map((query) => query.refetch()));
  };

  /* ------------------------------ 常用目录 ------------------------------ */

  const [recent, setRecent] = useState<RecentDir[]>(loadRecent);
  useEffect(() => {
    if (root.length === 0) return;
    setRecent((prev) => {
      const next = [
        { root, path, at: Date.now() },
        ...prev.filter((entry) => !(entry.root === root && entry.path === path)),
      ].slice(0, MAX_RECENT);
      storeRecent(next);
      return next;
    });
  }, [root, path]);

  /* ------------------------------- 选择 ------------------------------- */

  const [selectedPaths, setSelectedPaths] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    setSelectedPaths(new Set());
  }, [listScope]);
  const selectedItems = useMemo(
    () => items.filter((item) => selectedPaths.has(item.path)),
    [items, selectedPaths],
  );
  const toggleSelect = (item: FileItem, selected: boolean): void => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (selected) next.add(item.path);
      else next.delete(item.path);
      return next;
    });
  };
  const selectAll = (selected: boolean): void => {
    setSelectedPaths(selected ? new Set(items.map((item) => item.path)) : new Set());
  };

  /* ------------------------------- 导航 ------------------------------- */

  const navigateTo = useCallback(
    (nextPath: string): void => {
      updateParams({
        path: normalizeVirtualPath(nextPath),
        edit: null,
        highlight: null,
        search: null,
      });
    },
    [updateParams],
  );

  const openItem = useCallback(
    (item: FileItem): void => {
      if (item.type === 'directory' || item.targetType === 'directory') {
        navigateTo(item.path);
        return;
      }
      updateParams({ edit: item.path, highlight: null });
    },
    [navigateTo, updateParams],
  );

  const locateSearchHit = useCallback(
    (item: FileItem): void => {
      if (item.type === 'directory' || item.targetType === 'directory') {
        navigateTo(item.path);
        return;
      }
      updateParams({
        path: parentVirtualPath(item.path),
        highlight: item.name,
        edit: null,
        search: null,
      });
    },
    [navigateTo, updateParams],
  );

  const ensureWritable = (): boolean => {
    if (!writable) {
      toast.warning('当前文件根为只读，无法执行该操作', '文件根配置为 writable=false。');
      return false;
    }
    return true;
  };

  /* ------------------------------- 操作 ------------------------------- */

  const [createMode, setCreateMode] = useState<'folder' | 'file' | null>(null);
  const [createName, setCreateName] = useState('');
  const [createValidation, setCreateValidation] = useState<string | null>(null);

  const createMutation = useAppMutation({
    mutationFn: (variables: { mode: 'folder' | 'file'; name: string }) => {
      const target = joinVirtualPath(path, variables.name);
      return variables.mode === 'folder'
        ? mkdir({ root, path: target })
        : writeFile({ root, path: target, content: '', create: true, overwrite: false });
    },
    successMessage: (item) => `已创建${item.type === 'directory' ? '文件夹' : '文件'} ${item.name}`,
    invalidate: [scopedKey('files', 'list'), scopedKey('files', 'roots')],
    onSuccess: () => {
      setCreateMode(null);
      setCreateName('');
      setCreateValidation(null);
    },
  });

  const openCreate = (mode: 'folder' | 'file'): void => {
    if (!ensureWritable()) return;
    createMutation.reset();
    setCreateName('');
    setCreateValidation(null);
    setCreateMode(mode);
  };

  const submitCreate = (): void => {
    if (createMode === null) return;
    const name = createName.trim();
    const nameError = validateEntryName(name);
    if (nameError !== null) {
      setCreateValidation(nameError);
      return;
    }
    if (items.some((item) => item.name === name)) {
      setCreateValidation('当前目录已存在同名项目。');
      return;
    }
    setCreateValidation(null);
    createMutation.mutate({ mode: createMode, name });
  };

  const [renameTarget, setRenameTarget] = useState<FileItem | null>(null);
  const [renameName, setRenameName] = useState('');
  const [renameValidation, setRenameValidation] = useState<string | null>(null);

  const renameMutation = useAppMutation({
    mutationFn: (variables: { target: FileItem; name: string }) =>
      rename({
        root,
        from: variables.target.path,
        to: joinVirtualPath(parentVirtualPath(variables.target.path), variables.name),
      }),
    successMessage: (item) => `已重命名为 ${item.name}`,
    invalidate: [scopedKey('files', 'list'), scopedKey('files', 'roots')],
    onSuccess: () => setRenameTarget(null),
  });

  const openRename = (item: FileItem): void => {
    if (!ensureWritable()) return;
    renameMutation.reset();
    setRenameTarget(item);
    setRenameName(item.name);
    setRenameValidation(null);
  };

  const submitRename = (): void => {
    if (renameTarget === null) return;
    const name = renameName.trim();
    const nameError = validateEntryName(name);
    if (nameError !== null) {
      setRenameValidation(nameError);
      return;
    }
    if (name === renameTarget.name) {
      setRenameTarget(null);
      return;
    }
    if (items.some((item) => item.name === name && item.path !== renameTarget.path)) {
      setRenameValidation('当前目录已存在同名项目。');
      return;
    }
    setRenameValidation(null);
    renameMutation.mutate({ target: renameTarget, name });
  };

  const [transfer, setTransfer] = useState<{ mode: 'copy' | 'move'; items: FileItem[] } | null>(null);
  const [transferDestination, setTransferDestination] = useState('/');
  const [transferOverwrite, setTransferOverwrite] = useState(false);
  const [transferValidation, setTransferValidation] = useState<string | null>(null);

  const transferMutation = useAppMutation({
    mutationFn: async (variables: {
      mode: 'copy' | 'move';
      items: FileItem[];
      destination: string;
      overwrite: boolean;
    }) => {
      let count = 0;
      for (const item of variables.items) {
        const to = joinVirtualPath(variables.destination, item.name);
        if (to === item.path) {
          throw new AppError('BAD_REQUEST', '目标路径与源路径相同', 0, {
            hint: '请选择不同的目标目录。',
          });
        }
        if (variables.mode === 'copy') {
          await copy({ root, from: item.path, to, overwrite: variables.overwrite });
        } else {
          await rename({ root, from: item.path, to, overwrite: variables.overwrite });
        }
        count += 1;
      }
      return count;
    },
    successMessage: (count, variables) =>
      `已${variables.mode === 'copy' ? '复制' : '移动'} ${count} 项`,
    invalidate: [scopedKey('files', 'list'), scopedKey('files', 'roots')],
    onSuccess: () => {
      setTransfer(null);
      setSelectedPaths(new Set());
    },
  });

  const openTransfer = (mode: 'copy' | 'move', targets: readonly FileItem[]): void => {
    if (targets.length === 0) {
      toast.warning('请先选择要操作的项目');
      return;
    }
    if (!ensureWritable()) return;
    transferMutation.reset();
    setTransfer({ mode, items: [...targets] });
    setTransferDestination(path);
    setTransferOverwrite(false);
    setTransferValidation(null);
  };

  const submitTransfer = (): void => {
    if (transfer === null) return;
    const destination = normalizeVirtualPath(transferDestination);
    const pathError = validateVirtualPath(destination);
    if (pathError !== null) {
      setTransferValidation(pathError);
      return;
    }
    setTransferValidation(null);
    transferMutation.mutate({
      mode: transfer.mode,
      items: transfer.items,
      destination,
      overwrite: transferOverwrite,
    });
  };

  const [chmodTarget, setChmodTarget] = useState<FileItem | null>(null);
  const [chmodMode, setChmodMode] = useState('644');
  const [chmodValidation, setChmodValidation] = useState<string | null>(null);

  const chmodMutation = useAppMutation({
    mutationFn: (variables: { target: FileItem; mode: string }) =>
      chmod({ root, path: variables.target.path, mode: variables.mode }),
    successMessage: (item) => `已更新 ${item.name} 的权限`,
    successDescription: (item) => `当前权限：${item.mode}`,
    invalidate: [scopedKey('files', 'list')],
    onSuccess: () => setChmodTarget(null),
  });

  const openChmod = (item: FileItem): void => {
    if (!ensureWritable()) return;
    chmodMutation.reset();
    setChmodTarget(item);
    setChmodMode(initialOctal(item.mode));
    setChmodValidation(null);
  };

  const submitChmod = (): void => {
    if (chmodTarget === null) return;
    const mode = chmodMode.trim();
    if (!/^[0-7]{3,4}$/.test(mode)) {
      setChmodValidation('请输入 3~4 位八进制权限，例如 644、755、0600。');
      return;
    }
    setChmodValidation(null);
    chmodMutation.mutate({ target: chmodTarget, mode });
  };

  const [deleteTargets, setDeleteTargets] = useState<FileItem[]>([]);
  const deleteMutation = useAppMutation({
    mutationFn: async (targets: FileItem[]) => {
      let count = 0;
      for (const target of targets) {
        await deleteFile({ root, path: target.path });
        count += 1;
      }
      return count;
    },
    successMessage: (count) => `已将 ${count} 项移入回收站`,
    successDescription: '可在回收站中恢复到原路径或彻底删除。',
    invalidate: [
      scopedKey('files', 'list'),
      scopedKey('files', 'trash'),
      scopedKey('files', 'roots'),
    ],
    onSuccess: () => {
      setDeleteTargets([]);
      setSelectedPaths(new Set());
    },
  });

  const openDelete = (targets: readonly FileItem[]): void => {
    if (targets.length === 0) return;
    if (!ensureWritable()) return;
    deleteMutation.reset();
    setDeleteTargets([...targets]);
  };

  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archivePaths, setArchivePaths] = useState<string[]>([]);
  const [archiveBasePath, setArchiveBasePath] = useState('/');
  const [extractTarget, setExtractTarget] = useState<FileItem | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);

  const openArchive = (): void => {
    if (selectedItems.length === 0) {
      toast.warning('请先选择要打包的文件或目录');
      return;
    }
    if (!ensureWritable()) return;
    setArchivePaths(selectedItems.map((item) => item.path));
    setArchiveBasePath(path);
    setArchiveOpen(true);
  };

  const [downloadingPath, setDownloadingPath] = useState<string | null>(null);
  const handleDownload = async (item: FileItem): Promise<void> => {
    setDownloadingPath(item.path);
    try {
      await downloadFile({ root: item.root, path: item.path });
    } catch (error) {
      toastError(toast, error, '下载失败');
    } finally {
      setDownloadingPath(null);
    }
  };

  const handleDownloadSelected = (): void => {
    if (selectedItems.length !== 1) {
      toast.info('多选时请使用“打包”生成归档后下载');
      return;
    }
    const target = selectedItems[0];
    if (target === undefined || target.type === 'directory') {
      toast.warning('只支持下载单个文件');
      return;
    }
    void handleDownload(target);
  };

  /* ------------------------------- 编辑器 ------------------------------- */

  const editItem = editPath === null ? undefined : items.find((item) => item.path === editPath);
  const statQuery = useQuery({
    queryKey: filesKeys.stat({ root, path: editPath ?? '' }),
    queryFn: () => statFile({ root, path: editPath ?? '' }),
    enabled: root.length > 0 && editPath !== null && editItem === undefined,
    retry: false,
    staleTime: 0,
  });
  const editorItem = editItem ?? statQuery.data ?? null;

  useEffect(() => {
    if (statQuery.error === null || statQuery.error === undefined) return;
    toastError(toast, statQuery.error, '打开文件失败');
    updateParams({ edit: null });
  }, [statQuery.error, toast, updateParams]);

  const refreshAfterSave = (): void => {
    void queryClient.invalidateQueries({ queryKey: scopedKey('files', 'list') });
    void queryClient.invalidateQueries({ queryKey: scopedKey('files', 'stat') });
  };

  /* ------------------------------- 渲染 ------------------------------- */

  const pathErrorTitle = listError === null ? null : fileErrorTitle(listError);
  const pathErrorInfo = listError === null ? null : describeError(listError, '无法读取目录');
  const showReadOnlyAlert = activeRoot !== undefined && !writable;

  const rootBody = (): JSX.Element => {
    if (rootsQuery.isLoading) return <LoadingSkeleton rows={4} />;
    if (rootsQuery.error !== null) {
      return <ErrorState error={rootsQuery.error} title="文件根加载失败" onRetry={() => void rootsQuery.refetch()} />;
    }
    if (rootsQuery.data !== undefined && rootsQuery.data.available === false) {
      return (
        <UnavailableAlert
          available={false}
          reason={rootsQuery.data.reason ?? 'agent 报告文件模块不可用。'}
          title="文件根不可用"
          hint="请确认 agent 已启用文件模块，并通过 MPANEL_FILES_ROOTS 暴露至少一个可访问目录。"
        />
      );
    }
    if (roots.length === 0) {
      return (
        <EmptyState
          compact
          title="没有可用的文件根"
          description="agent 未暴露任何文件根。请在 agent 配置 MPANEL_FILES_ROOTS（name=path 列表）后重启。"
          action={
            <Button variant="secondary" size="sm" onClick={() => void rootsQuery.refetch()}>
              重新检测
            </Button>
          }
        />
      );
    }
    return (
      <div className="flex flex-col gap-1">
        {roots.map((entry: FileRoot) => {
          const active = entry.name === root;
          return (
            <button
              type="button"
              key={entry.name}
              onClick={() => {
                updateParams({ root: entry.name, path: '/', edit: null, highlight: null });
              }}
              className={cn(
                'flex w-full flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left transition-colors',
                active ? 'bg-app-accent/10 ring-1 ring-inset ring-app-accent/40' : 'hover:bg-app-elevated',
              )}
              title={entry.path}
            >
              <span className="flex items-center gap-1.5 text-sm text-app-text">
                {active ? (
                  <FolderOpen className="h-4 w-4 shrink-0 text-app-accent" />
                ) : (
                  <Folder className="h-4 w-4 shrink-0 text-app-muted" />
                )}
                <span className="truncate font-medium">{entry.name}</span>
                {entry.writable ? null : (
                  <Badge tone="warning" className="ml-auto shrink-0">
                    只读
                  </Badge>
                )}
              </span>
              <span className="truncate font-mono text-[10px] text-app-muted">{entry.path}</span>
              {entry.freeBytes !== null && entry.freeBytes !== undefined ? (
                <span className="text-[10px] text-app-muted">
                  可用 {formatBytes(entry.freeBytes)}
                  {entry.totalBytes !== null && entry.totalBytes !== undefined
                    ? ` / ${formatBytes(entry.totalBytes)}`
                    : ''}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    );
  };

  const recentBody = (): JSX.Element => {
    if (recent.length === 0) {
      return (
        <p className="px-1 py-2 text-xs text-app-muted">访问过的目录会显示在这里，便于快速跳转。</p>
      );
    }
    return (
      <div className="flex flex-col gap-0.5">
        {recent.slice(0, 10).map((entry) => {
          const active = entry.root === root && entry.path === path;
          return (
            <button
              type="button"
              key={`${entry.root}:${entry.path}`}
              onClick={() => updateParams({ root: entry.root, path: entry.path, edit: null, highlight: null })}
              className={cn(
                'flex items-center gap-1.5 rounded px-2 py-1 text-left text-[11px]',
                active ? 'bg-app-elevated text-app-text' : 'text-app-muted hover:bg-app-elevated hover:text-app-text',
              )}
              title={`${entry.root}:${entry.path}`}
            >
              <Clock className="h-3 w-3 shrink-0" />
              <span className="truncate font-mono">
                {entry.root}:{entry.path}
              </span>
            </button>
          );
        })}
      </div>
    );
  };

  const mainBody = (): JSX.Element => {
    if (rootsQuery.isLoading) return <LoadingSkeleton rows={6} />;
    if (rootsQuery.error !== null) {
      return <ErrorState error={rootsQuery.error} title="文件根加载失败" onRetry={() => void rootsQuery.refetch()} />;
    }
    if (rootsQuery.data !== undefined && rootsQuery.data.available === false) {
      return (
        <UnavailableAlert
          available={false}
          reason={rootsQuery.data.reason ?? 'agent 报告文件模块不可用。'}
          title="文件根不可用"
          hint="请确认 agent 已启用文件模块，并通过 MPANEL_FILES_ROOTS 暴露至少一个可访问目录。"
        />
      );
    }
    if (roots.length === 0) {
      return (
        <EmptyState
          title="没有可用的文件根"
          description="请让 agent 通过 MPANEL_FILES_ROOTS 暴露可浏览目录；文件访问全部限制在这些根内。"
        />
      );
    }
    if (activeRoot === undefined) {
      return <LoadingSkeleton rows={4} />;
    }

    return (
      <div className="flex min-w-0 flex-col">
        <Breadcrumbs
          root={activeRoot.name}
          path={path}
          onNavigate={(nextPath) => navigateTo(nextPath)}
        />
        <FileToolbar
          root={root}
          path={path}
          onRefresh={refetchList}
          onNewFolder={() => openCreate('folder')}
          onNewFile={() => openCreate('file')}
          onUpload={() => {
            if (ensureWritable()) setUploadOpen(true);
          }}
          onArchive={openArchive}
          onSearch={() => updateParams({ search: '1' })}
          onTrash={() => updateParams({ trash: '1' })}
          showHidden={showHidden}
          onShowHiddenChange={(checked) => updateParams({ hidden: checked ? '1' : null })}
          selectionCount={selectedItems.length}
          onDownloadSelected={handleDownloadSelected}
          onCopySelected={() => openTransfer('copy', selectedItems)}
          onMoveSelected={() => openTransfer('move', selectedItems)}
          onDeleteSelected={() => openDelete(selectedItems)}
          onClearSelection={() => setSelectedPaths(new Set())}
          writable={writable}
          loading={listFetching}
          itemCount={items.length}
        />

        {showReadOnlyAlert ? (
          <Alert
            tone="warning"
            title="当前文件根为只读"
            hint="agent 将该根标记为 writable=false；新建、上传、编辑、删除等写操作已禁用。"
            className="mb-3"
          >
            目录仍可浏览、搜索与下载。
          </Alert>
        ) : null}

        {listUnavailableReason !== null ? (
          <UnavailableAlert
            available={false}
            reason={listUnavailableReason}
            title="文件列表不可用"
            hint="agent 可能未启用文件模块或文件根配置无效；请检查 agent 日志与 MPANEL_FILES_ROOTS。"
            className="mb-3"
          />
        ) : null}

        {pathErrorTitle !== null && pathErrorInfo !== null ? (
          <Alert
            tone="danger"
            title={pathErrorTitle}
            hint={fileErrorHint(listError)}
            className="mb-3"
            action={
              path === '/' ? undefined : (
                <Button variant="secondary" size="sm" onClick={() => navigateTo('/')}>
                  回到根目录
                </Button>
              )
            }
          >
            {pathErrorInfo.description}
          </Alert>
        ) : null}

        <FileTable
          items={items}
          selected={selectedItems}
          onOpen={openItem}
          onSelect={toggleSelect}
          onSelectAll={selectAll}
          sort={sort}
          onSortChange={(nextSort) =>
            updateParams({
              sort: nextSort === null ? null : nextSort.key,
              dir: nextSort === null ? null : nextSort.direction,
            })
          }
          loading={listLoading}
          error={listError ?? undefined}
          onRetry={refetchList}
          highlight={highlight}
          readOnly={!writable}
          onPreview={(item) => updateParams({ edit: item.path, highlight: null })}
          onDownload={(item) => void handleDownload(item)}
          onRename={openRename}
          onCopy={(item) => openTransfer('copy', [item])}
          onMove={(item) => openTransfer('move', [item])}
          onChmod={openChmod}
          onDelete={(item) => openDelete([item])}
          onExtract={(item) => {
            if (!ensureWritable()) return;
            setExtractTarget(item);
          }}
          empty={
            <EmptyState
              compact
              title={itemCountEmptyTitle(showHidden)}
              description={
                showHidden
                  ? '目录确实为空；可以新建文件夹、上传文件，或返回上级目录。'
                  : '目录为空或只包含隐藏文件；可打开“显示隐藏文件”开关查看。'
              }
              action={
                writable ? (
                  <Button variant="secondary" size="sm" onClick={() => setUploadOpen(true)}>
                    上传文件
                  </Button>
                ) : undefined
              }
            />
          }
        />

        <Pagination
          nextCursor={nextCursor}
          onNext={addPage}
          onReset={() => setPagination({ scope: listScope, cursors: [undefined] })}
          loading={listFetching}
          loaded={items.length}
          className="mb-1"
        />
        {downloadingPath === null ? null : (
          <p className="text-[11px] text-app-muted">正在下载 {downloadingPath} …</p>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-4 xl:flex-row">
      <aside className="w-full shrink-0 xl:w-64">
        <Card>
          <CardHeader
            title="文件根"
            description="agent 暴露的沙箱目录"
            icon={<HardDrive className="h-4 w-4" />}
            actions={
              <Button
                variant="ghost"
                size="icon"
                title="刷新文件根"
                aria-label="刷新文件根"
                icon={<RefreshCw className="h-3.5 w-3.5" />}
                onClick={() => void rootsQuery.refetch()}
                loading={rootsQuery.isFetching}
              />
            }
          />
          <CardBody className="p-2">{rootBody()}</CardBody>
        </Card>

        <Card className="mt-3">
          <CardHeader title="常用目录" description="最近访问的路径" icon={<Clock className="h-4 w-4" />} />
          <CardBody className="p-2">{recentBody()}</CardBody>
        </Card>

        <div className="mt-3 flex items-start gap-1.5 px-1 text-[10px] leading-relaxed text-app-muted">
          <ShieldAlert className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            所有路径都限制在文件根内；写操作拒绝符号链接穿越，越权/越界会以中文错误提示展示。
          </span>
        </div>
      </aside>

      <section className="min-w-0 flex-1">{mainBody()}</section>

      <NameDialog
        open={createMode !== null}
        title={createMode === 'folder' ? '新建文件夹' : '新建文件'}
        description={`创建位置：${root}:${path}`}
        label={createMode === 'folder' ? '文件夹名称' : '文件名'}
        value={createName}
        placeholder={createMode === 'folder' ? '新建文件夹' : 'new-file.txt'}
        submitLabel="创建"
        submitting={createMutation.isPending}
        validation={createValidation}
        error={createMutation.error}
        errorTitle="创建失败"
        onValueChange={(value) => {
          setCreateName(value);
          setCreateValidation(null);
        }}
        onClose={() => {
          setCreateMode(null);
          setCreateValidation(null);
        }}
        onSubmit={submitCreate}
      />

      <NameDialog
        open={renameTarget !== null}
        title="重命名"
        description={renameTarget === null ? undefined : `原路径：${renameTarget.path}`}
        label="新名称"
        value={renameName}
        submitLabel="重命名"
        submitting={renameMutation.isPending}
        validation={renameValidation}
        error={renameMutation.error}
        errorTitle="重命名失败"
        onValueChange={(value) => {
          setRenameName(value);
          setRenameValidation(null);
        }}
        onClose={() => {
          setRenameTarget(null);
          setRenameValidation(null);
        }}
        onSubmit={submitRename}
      />

      <TransferDialog
        open={transfer !== null}
        mode={transfer?.mode ?? 'copy'}
        items={transfer?.items ?? []}
        destination={transferDestination}
        overwrite={transferOverwrite}
        validation={transferValidation}
        submitting={transferMutation.isPending}
        error={transferMutation.error}
        onDestinationChange={(value) => {
          setTransferDestination(value);
          setTransferValidation(null);
        }}
        onOverwriteChange={setTransferOverwrite}
        onSubmit={submitTransfer}
        onClose={() => setTransfer(null)}
      />

      <ChmodDialog
        open={chmodTarget !== null}
        target={chmodTarget}
        mode={chmodMode}
        validation={chmodValidation}
        submitting={chmodMutation.isPending}
        error={chmodMutation.error}
        onModeChange={(value) => {
          setChmodMode(value);
          setChmodValidation(null);
        }}
        onSubmit={submitChmod}
        onClose={() => setChmodTarget(null)}
      />

      <ConfirmDialog
        open={deleteTargets.length > 0}
        title="删除项目"
        message={
          deleteTargets.length === 0
            ? ''
            : `将把 ${deleteTargets
                .slice(0, 5)
                .map((item) => item.name)
                .join('、')}${deleteTargets.length > 5 ? ` 等 ${deleteTargets.length} 项` : ''} 移入回收站。可在回收站中恢复。`
        }
        confirmLabel="移入回收站"
        danger
        loading={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate(deleteTargets)}
        onCancel={() => setDeleteTargets([])}
      />

      {archiveOpen ? (
        <ArchiveDialog
          open
          root={root}
          paths={archivePaths}
          basePath={archiveBasePath}
          onClose={() => setArchiveOpen(false)}
          onDone={refetchList}
        />
      ) : null}

      {extractTarget !== null ? (
        <ExtractDialog
          open
          root={root}
          file={extractTarget}
          onClose={() => setExtractTarget(null)}
          onDone={refetchList}
        />
      ) : null}

      {uploadOpen ? (
        <UploadDialog
          open
          root={root}
          path={path}
          existingNames={items.map((item) => item.name)}
          onClose={() => setUploadOpen(false)}
          onDone={() => {
            void queryClient.invalidateQueries({ queryKey: scopedKey('files', 'list') });
            void queryClient.invalidateQueries({ queryKey: scopedKey('files', 'roots') });
          }}
        />
      ) : null}

      {searchOpen ? (
        <FileSearchPanel
          root={root}
          path={path}
          onClose={() => updateParams({ search: null })}
          onOpen={locateSearchHit}
        />
      ) : null}

      {trashOpen ? (
        <TrashDrawer open onClose={() => updateParams({ trash: null })} />
      ) : null}

      <FileEditorDrawer
        file={editorItem}
        readOnly={!writable}
        onClose={() => updateParams({ edit: null })}
        onSaved={refreshAfterSave}
      />
    </div>
  );
}

function itemCountEmptyTitle(showHidden: boolean): string {
  return showHidden ? '目录为空' : '目录为空（隐藏文件未显示）';
}
