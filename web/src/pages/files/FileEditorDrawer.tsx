import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownToLine, RotateCcw, Save } from 'lucide-react';
import type { FileItem } from '../../api/types';
import { downloadFile, readFile, writeFile } from '../../api/files';
import { describeError, isAppError } from '../../api/errors';
import { useAppMutation } from '../../lib/mutations';
import { scopedKey } from '../../lib/query-keys';
import { formatBytes, formatDate } from '../../lib/format';
import { Alert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { CodeEditor, type CodeLanguage } from '../../components/ui/CodeEditor';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Drawer } from '../../components/ui/Drawer';
import { ErrorState, LoadingSkeleton } from '../../components/ui/ErrorState';
import { EmptyState } from '../../components/ui/EmptyState';
import { useToast } from '../../components/ui/Toast';
import { FilePreview } from './FilePreview';
import { extensionOf, isImageName } from './Breadcrumbs';

/** 在线编辑上限；超过则只提供下载，避免把大文件读进浏览器。 */
const EDIT_LIMIT = 5 * 1024 * 1024;
/** /files/read 契约允许的最大 maxBytes。 */
const READ_LIMIT = 8 * 1024 * 1024;

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
};

function imageMime(name: string): string {
  return IMAGE_MIME[extensionOf(name)] ?? 'application/octet-stream';
}

function editorLanguage(name: string): CodeLanguage {
  const ext = extensionOf(name);
  if (ext === 'json') return 'json';
  if (ext === 'sql') return 'sql';
  if (ext === 'caddy' || name.toLowerCase() === 'caddyfile') return 'caddyfile';
  return 'text';
}

/** 契约：二进制文件以 400 BAD_REQUEST 拒绝，hint 提示改用 base64。 */
function looksBinaryError(error: unknown): boolean {
  if (!isAppError(error, 'BAD_REQUEST')) return false;
  const text = `${error.message} ${error.hint}`.toLowerCase();
  return text.includes('binary') || text.includes('二进制') || text.includes('base64');
}

export interface FileEditorDrawerProps {
  file: FileItem | null;
  onClose(): void;
  onSaved(item: FileItem): void;
  /** 当前文件根只读时禁用保存。 */
  readOnly?: boolean;
}

/**
 * 文件预览/编辑抽屉：
 * - 文本：CodeEditor，保存时带 expectedMtime，冲突时二次确认覆盖；
 * - 图片：base64 读取后直接预览；
 * - 二进制/超过 5 MiB/被截断：只读提示 + 下载。
 */
export function FileEditorDrawer(props: FileEditorDrawerProps): JSX.Element {
  const { file } = props;
  const fileKey = file === null ? '' : `${file.root}\u0000${file.path}`;
  const imageFile = file !== null && isImageName(file.name);
  const tooLarge = file !== null && file.size > EDIT_LIMIT;
  const enabled = file !== null && file.type !== 'directory' && !tooLarge;

  const [draft, setDraft] = useState('');
  const [baseline, setBaseline] = useState('');
  const [mtime, setMtime] = useState<string | null>(null);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [reloadOpen, setReloadOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const toast = useToast();

  const readQuery = useQuery({
    queryKey: scopedKey(
      'files',
      'read',
      file?.root ?? '',
      file?.path ?? '',
      imageFile ? 'base64' : 'utf8',
    ),
    queryFn: () =>
      readFile({
        root: file?.root ?? '',
        path: file?.path ?? '',
        encoding: imageFile ? 'base64' : 'utf8',
        maxBytes: READ_LIMIT,
      }),
    enabled,
    retry: false,
    staleTime: 0,
  });

  useEffect(() => {
    setDraft('');
    setBaseline('');
    setMtime(null);
    setConflictOpen(false);
    setDiscardOpen(false);
    setReloadOpen(false);
  }, [fileKey]);

  useEffect(() => {
    const data = readQuery.data;
    if (data === undefined || data.isBinary || imageFile) return;
    setDraft(data.content);
    setBaseline(data.content);
    setMtime(data.mtime);
  }, [readQuery.data, imageFile]);

  const binary =
    !imageFile &&
    (readQuery.data?.isBinary === true || looksBinaryError(readQuery.error));
  const truncated = readQuery.data?.truncated === true;
  const dirty = draft !== baseline;
  const canEdit =
    enabled &&
    props.readOnly !== true &&
    !binary &&
    !imageFile &&
    readQuery.data !== undefined &&
    !truncated;

  const saveMutation = useAppMutation({
    mutationFn: (variables: { force: boolean }) =>
      writeFile({
        root: file?.root ?? '',
        path: file?.path ?? '',
        content: draft,
        encoding: 'utf8',
        overwrite: true,
        expectedMtime: variables.force ? undefined : (mtime ?? undefined),
      }),
    successMessage: (item) => `已保存 ${item.name}`,
    successDescription: (item) => `文件修改时间已更新为 ${formatDate(item.mtime)}`,
    invalidate: [
      scopedKey('files', 'list'),
      scopedKey('files', 'stat'),
      scopedKey('files', 'roots'),
    ],
    silentError: true,
    onSuccess: (item) => {
      setBaseline(draft);
      setMtime(item.mtime);
      setConflictOpen(false);
      props.onSaved(item);
    },
    onError: (error) => {
      if (isAppError(error, 'CONFLICT')) setConflictOpen(true);
      else setConflictOpen(false);
    },
  });

  useEffect(() => {
    if (file === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (canEdit && dirty && !saveMutation.isPending) saveMutation.mutate({ force: false });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [file, canEdit, dirty, saveMutation]);

  const imageUrl = useMemo(() => {
    if (!imageFile || file === null) return undefined;
    if (readQuery.data === undefined || readQuery.data.truncated) return undefined;
    return `data:${imageMime(file.name)};base64,${readQuery.data.content}`;
  }, [imageFile, file, readQuery.data]);

  const readError =
    readQuery.error !== null && !binary ? describeError(readQuery.error, '读取文件失败') : null;
  const saveError =
    saveMutation.error !== null && !conflictOpen
      ? describeError(saveMutation.error, '保存失败')
      : null;

  const handleDownload = async (): Promise<void> => {
    if (file === null) return;
    setDownloading(true);
    try {
      await downloadFile({ root: file.root, path: file.path });
    } catch (error) {
      toast.error('下载失败', describeError(error).hint);
    } finally {
      setDownloading(false);
    }
  };

  const requestClose = (): void => {
    if (dirty) setDiscardOpen(true);
    else props.onClose();
  };

  const requestReload = (): void => {
    if (dirty) setReloadOpen(true);
    else void readQuery.refetch();
  };

  const body = (): JSX.Element | null => {
    if (file === null) return null;

    if (file.type === 'directory') {
      return (
        <EmptyState
          title="目录不能预览"
          description="请返回文件列表进入该目录，或选择其中的文件进行预览/编辑。"
        />
      );
    }

    if (tooLarge) {
      return (
        <div className="flex flex-col gap-3">
          <Alert
            tone="warning"
            title="文件过大，无法在线编辑"
            hint="在线编辑上限为 5 MiB；请下载后用本地编辑器修改，再上传覆盖。"
            action={
              <Button
                variant="secondary"
                size="sm"
                icon={<ArrowDownToLine className="h-3.5 w-3.5" />}
                onClick={() => void handleDownload()}
                loading={downloading}
              >
                下载
              </Button>
            }
          >
            当前文件 {formatBytes(file.size)}，超过 5 MiB 上限。
          </Alert>
        </div>
      );
    }

    if (readQuery.isLoading) {
      return <LoadingSkeleton rows={6} />;
    }

    if (imageFile) {
      const imageError =
        readQuery.error !== null
          ? describeError(readQuery.error, '读取图片失败').description
          : imageUrl === undefined
            ? truncated
              ? '图片超过 8 MiB 读取上限，无法完整预览；请下载后查看。'
              : '图片数据尚未就绪或无法解析，请重试或下载。'
            : undefined;
      return (
        <FilePreview
          file={file}
          content=""
          isBinary={false}
          imageUrl={imageUrl}
          imageError={imageError}
          onDownload={() => void handleDownload()}
        />
      );
    }

    if (readError !== null) {
      return (
        <div className="flex flex-col gap-3">
          <ErrorState error={readQuery.error} title="读取文件失败" onRetry={() => void readQuery.refetch()} />
          <Button
            variant="secondary"
            size="sm"
            icon={<ArrowDownToLine className="h-3.5 w-3.5" />}
            onClick={() => void handleDownload()}
            loading={downloading}
          >
            下载文件
          </Button>
        </div>
      );
    }

    if (binary) {
      return (
        <FilePreview
          file={file}
          content=""
          isBinary
          onDownload={() => void handleDownload()}
        />
      );
    }

    if (readQuery.data === undefined) {
      return <LoadingSkeleton rows={4} />;
    }

    return (
      <div className="flex flex-col gap-3">
        {truncated ? (
          <Alert tone="warning" title="内容已截断" hint="只显示了文件开头部分；为避免误覆盖，已禁用保存。">
            文件超过单次读取上限（8 MiB），请下载后编辑。
          </Alert>
        ) : null}
        {saveError !== null ? (
          <Alert tone="danger" title={saveError.title} hint={saveError.hint}>
            {saveError.description}
          </Alert>
        ) : null}
        <CodeEditor
          value={draft}
          onChange={setDraft}
          readOnly={!canEdit}
          language={editorLanguage(file.name)}
          height="60vh"
          ariaLabel={`编辑 ${file.name}`}
        />
      </div>
    );
  };

  const isTextFile = file !== null && file.type !== 'directory' && !tooLarge && !imageFile;

  return (
    <Drawer
      open={file !== null}
      onClose={requestClose}
      title={file?.name ?? '文件编辑器'}
      description={file === null ? undefined : `${file.root}:${file.path}`}
      size="xl"
      bodyClassName="flex flex-col"
      footer={
        file === null ? undefined : (
          <>
            <Button variant="ghost" size="sm" onClick={requestClose}>
              关闭
            </Button>
            {isTextFile ? (
              <Button
                variant="secondary"
                size="sm"
                icon={<RotateCcw className="h-3.5 w-3.5" />}
                onClick={requestReload}
                loading={readQuery.isFetching}
              >
                重新加载
              </Button>
            ) : null}
            <Button
              variant="secondary"
              size="sm"
              icon={<ArrowDownToLine className="h-3.5 w-3.5" />}
              onClick={() => void handleDownload()}
              loading={downloading}
            >
              下载
            </Button>
            {isTextFile && !binary && readError === null ? (
              <Button
                variant="primary"
                size="sm"
                icon={<Save className="h-3.5 w-3.5" />}
                onClick={() => saveMutation.mutate({ force: false })}
                loading={saveMutation.isPending}
                disabled={!canEdit || !dirty}
                title={!canEdit ? '当前文件不可编辑' : dirty ? '保存（Ctrl/⌘+S）' : '没有需要保存的修改'}
              >
                保存
              </Button>
            ) : null}          </>
        )
      }
    >
      {file === null ? (
        <span />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2 text-xs text-app-muted">
            <Badge tone="neutral">{file.type === 'directory' ? '目录' : formatBytes(file.size)}</Badge>
            <Badge tone="neutral" title="文件权限">
              {file.mode.length === 0 ? '—' : file.mode}
            </Badge>
            <span>
              修改时间：{formatDate(mtime ?? file.mtime)}
              {mtime !== null && mtime !== file.mtime ? '（本地已更新）' : ''}
            </span>
            {dirty ? (
              <Badge tone="warning" dot>
                未保存的修改
              </Badge>
            ) : null}
            {canEdit ? <span className="ml-auto">Ctrl/⌘+S 保存</span> : null}
          </div>
          {props.readOnly === true ? (
            <Alert tone="warning" title="当前文件根只读" hint="文件根配置为 writable=false，保存与写操作已禁用；仍可预览与下载。">
              只读模式下编辑器内容不可保存。
            </Alert>
          ) : null}
          {body()}
        </div>
      )}

      <ConfirmDialog
        open={conflictOpen}
        title="文件在服务器上已变更"
        message="保存时写入的 mtime 与服务器当前文件不一致（可能被其他进程修改）。要用当前编辑内容覆盖服务器上的文件吗？"
        confirmLabel="覆盖保存"
        danger
        loading={saveMutation.isPending}
        onConfirm={() => saveMutation.mutate({ force: true })}
        onCancel={() => setConflictOpen(false)}
      />
      <ConfirmDialog
        open={reloadOpen}
        title="重新加载文件"
        message="将丢弃当前未保存的修改，并从服务器重新读取文件内容。"
        confirmLabel="重新加载"
        danger
        onConfirm={() => {
          setReloadOpen(false);
          void readQuery.refetch();
        }}
        onCancel={() => setReloadOpen(false)}
      />
      <ConfirmDialog
        open={discardOpen}
        title="放弃未保存的修改？"
        message={`文件 ${file?.name ?? ''} 有未保存的修改，关闭后这些修改会丢失。`}
        confirmLabel="放弃并关闭"
        danger
        onConfirm={() => {
          setDiscardOpen(false);
          props.onClose();
        }}
        onCancel={() => setDiscardOpen(false)}
      />
    </Drawer>
  );
}
