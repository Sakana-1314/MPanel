import { useEffect, useRef, useState } from 'react';
import { Ban, FileUp, RotateCcw, Trash2, UploadCloud, X } from 'lucide-react';
import type { FileItem } from '../../api/types';
import { AppError, errorFromStatus, type AppErrorCode } from '../../api/errors';
import { getClient } from '../../api/client';
import { cn } from '../../lib/cn';
import { formatBytes } from '../../lib/format';
import { Alert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { FormField } from '../../components/ui/FormField';
import { Modal } from '../../components/ui/Modal';
import { Select } from '../../components/ui/Select';
import { useToast } from '../../components/ui/Toast';
import { joinVirtualPath } from './Breadcrumbs';

/** 契约 §8.3：multipart 上传单文件上限 100 MiB。 */
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

type ConflictMode = 'overwrite' | 'skip' | 'rename';
type EntryStatus = 'pending' | 'uploading' | 'done' | 'error' | 'skipped' | 'canceled';

interface UploadEntry {
  id: string;
  file: File;
  status: EntryStatus;
  progress: number;
  targetName?: string;
  message?: string;
}

let uploadSequence = 0;

function nextUploadId(): string {
  uploadSequence += 1;
  return `upload-${uploadSequence}`;
}

function splitExtension(name: string): { base: string; ext: string } {
  const index = name.lastIndexOf('.');
  if (index <= 0 || index === name.length - 1) return { base: name, ext: '' };
  return { base: name.slice(0, index), ext: name.slice(index) };
}

/** 目标名冲突时生成 `name (1).ext` 形式的唯一名。 */
function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const { base, ext } = splitExtension(name);
  let index = 1;
  let candidate = `${base} (${index})${ext}`;
  while (taken.has(candidate)) {
    index += 1;
    candidate = `${base} (${index})${ext}`;
  }
  return candidate;
}

interface UploadProgressOptions {
  url: string;
  token?: string;
  file: File;
  onProgress(progress: number): void;
  registerAbort?(abort: () => void): void;
}

/**
 * 用 XHR 上传以拿到真实进度（fetch 无法报告上传进度）。
 * 认证与 ApiClient 一致：Bearer token（若有）+ cookie（core 会话）。
 */
function uploadWithProgress(options: UploadProgressOptions): Promise<FileItem> {
  return new Promise<FileItem>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', options.url, true);
    xhr.withCredentials = true;
    xhr.timeout = 620_000;
    xhr.responseType = 'text';
    if (options.token !== undefined && options.token.length > 0) {
      xhr.setRequestHeader('Authorization', `Bearer ${options.token}`);
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        options.onProgress(Math.min(1, event.loaded / event.total));
      }
    };
    xhr.onload = () => {
      try {
        resolve(parseUploadResponse(xhr));
      } catch (error) {
        reject(error);
      }
    };
    xhr.onerror = () =>
      reject(
        new AppError('NETWORK', '上传失败：无法连接后端', 0, {
          hint: '请确认连接可用，且反向代理未限制大请求体或 CORS 预检。',
        }),
      );
    xhr.ontimeout = () =>
      reject(
        new AppError('TIMEOUT', '上传超时', 0, {
          hint: '文件较大或网络较慢，可重试；也请确认代理超时设置。',
        }),
      );
    xhr.onabort = () => reject(new AppError('ABORTED', '上传已取消', 0));

    const form = new FormData();
    form.append('file', options.file);
    options.registerAbort?.(() => xhr.abort());
    xhr.send(form);
  });
}

function parseUploadResponse(xhr: XMLHttpRequest): FileItem {
  const text = xhr.responseText ?? '';
  let payload: unknown = null;
  if (text.trim().length > 0) {
    try {
      payload = JSON.parse(text);
    } catch {
      throw errorFromStatus(xhr.status, text.slice(0, 300));
    }
  }
  if (payload !== null && typeof payload === 'object' && 'ok' in payload) {
    const envelope = payload as {
      ok: boolean;
      data?: unknown;
      error?: { code?: string; message?: string; details?: unknown };
    };
    if (envelope.ok === true && envelope.data !== undefined) {
      return envelope.data as FileItem;
    }
    if (envelope.error !== undefined) {
      throw new AppError(
        (envelope.error.code ?? 'INTERNAL') as AppErrorCode,
        envelope.error.message ?? '上传失败',
        xhr.status,
        envelope.error.details,
      );
    }
  }
  if (xhr.status >= 200 && xhr.status < 300) {
    throw new AppError('INTERNAL', '上传响应缺少文件信息', xhr.status, {
      hint: '请确认前端与 worker 版本一致。',
    });
  }
  throw errorFromStatus(xhr.status, '上传失败');
}

function statusLabel(entry: UploadEntry): string {
  if (entry.status === 'pending') return '待上传';
  if (entry.status === 'uploading') return `上传中 ${Math.round(entry.progress * 100)}%`;
  if (entry.status === 'done') return '已完成';
  if (entry.status === 'skipped') return '已跳过';
  if (entry.status === 'canceled') return '已取消';
  return '失败';
}

function statusTone(entry: UploadEntry): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
  if (entry.status === 'uploading') return 'info';
  if (entry.status === 'done') return 'success';
  if (entry.status === 'skipped') return 'warning';
  if (entry.status === 'error') return 'danger';
  return 'neutral';
}

export interface UploadDialogProps {
  open: boolean;
  root: string;
  path: string;
  onClose(): void;
  onDone(): void;
  /** 当前目录已有文件名，用于“跳过/重命名”冲突策略。 */
  existingNames?: readonly string[];
}

/** 多文件上传队列：拖拽/选择、真实进度、覆盖/跳过/重命名冲突策略。 */
export function UploadDialog(props: UploadDialogProps): JSX.Element {
  const toast = useToast();
  const [entries, setEntries] = useState<UploadEntry[]>([]);
  const [conflict, setConflict] = useState<ConflictMode>('overwrite');
  const [dragging, setDragging] = useState(false);
  const [running, setRunning] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const runningRef = useRef(false);
  const abortedRef = useRef(false);
  const abortRef = useRef<(() => void) | null>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (props.open && !wasOpenRef.current) {
      setEntries([]);
      setConflict('overwrite');
      setDragging(false);
      setRunning(false);
      runningRef.current = false;
      abortedRef.current = false;
      abortRef.current = null;
    }
    wasOpenRef.current = props.open;
  }, [props.open]);

  const updateEntry = (id: string, patch: Partial<UploadEntry>): void => {
    setEntries((prev) => prev.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));
  };

  const addFiles = (files: readonly File[]): void => {
    setEntries((prev) => {
      const known = new Set(
        prev.map((entry) => `${entry.file.name}:${entry.file.size}:${entry.file.lastModified}`),
      );
      const next = [...prev];
      for (const file of files) {
        const key = `${file.name}:${file.size}:${file.lastModified}`;
        if (known.has(key)) continue;
        known.add(key);
        const tooBig = file.size > MAX_UPLOAD_BYTES;
        next.push({
          id: nextUploadId(),
          file,
          status: tooBig ? 'error' : 'pending',
          progress: 0,
          message: tooBig ? `超过 100 MiB 上限（${formatBytes(file.size)}）` : undefined,
        });
      }
      return next;
    });
  };

  const start = async (source: readonly UploadEntry[]): Promise<void> => {
    if (runningRef.current) return;
    const queue = source.filter((entry) => entry.status === 'pending');
    if (queue.length === 0) {
      toast.warning('没有待上传的文件');
      return;
    }
    runningRef.current = true;
    abortedRef.current = false;
    abortRef.current = null;
    setRunning(true);

    const taken = new Set<string>(props.existingNames ?? []);
    for (const entry of source) {
      if (entry.status === 'done' && entry.targetName !== undefined) taken.add(entry.targetName);
    }
    let success = 0;
    let failed = 0;
    let skipped = 0;

    try {
      for (const entry of queue) {
        if (abortedRef.current) {
          updateEntry(entry.id, { status: 'canceled', message: '已取消' });
          continue;
        }

        let targetName = entry.file.name;
        if (conflict === 'skip' && taken.has(targetName)) {
          updateEntry(entry.id, { status: 'skipped', message: '同名文件已存在，按策略跳过' });
          skipped += 1;
          continue;
        }
        if (conflict === 'rename') {
          targetName = uniqueName(targetName, taken);
        }
        taken.add(targetName);

        updateEntry(entry.id, { status: 'uploading', progress: 0, targetName, message: undefined });

        try {
          const client = getClient();
          const uploadFile_ =
            targetName === entry.file.name
              ? entry.file
              : new File([entry.file], targetName, {
                  type: entry.file.type,
                  lastModified: entry.file.lastModified,
                });
          const item = await uploadWithProgress({
            url: client.url('/files/upload', {
              root: props.root,
              path: props.path,
              overwrite: conflict === 'overwrite',
            }),
            token: client.token,
            file: uploadFile_,
            onProgress: (progress) => updateEntry(entry.id, { progress }),
            registerAbort: (abort) => {
              abortRef.current = abort;
            },
          });
          updateEntry(entry.id, {
            status: 'done',
            progress: 1,
            targetName: item.name,
            message: joinVirtualPath(props.path, item.name),
          });
          success += 1;
        } catch (error) {
          const appError = error instanceof AppError ? error : null;
          const message =
            appError !== null
              ? appError.toUserMessage()
              : error instanceof Error
                ? error.message
                : '上传失败';
          updateEntry(entry.id, {
            status: appError?.code === 'ABORTED' ? 'canceled' : 'error',
            message,
          });
          failed += 1;
          if (appError?.code === 'ABORTED') abortedRef.current = true;
        }
      }
    } finally {
      runningRef.current = false;
      abortRef.current = null;
      setRunning(false);
      if (skipped > 0) toast.info(`已跳过 ${skipped} 个同名文件`);
      if (failed > 0) toast.error(`上传结束：成功 ${success} 个，失败 ${failed} 个`);
      else if (success > 0) toast.success(`已上传 ${success} 个文件`);
      if (success > 0) props.onDone();
    }
  };

  const cancel = (): void => {
    abortedRef.current = true;
    abortRef.current?.();
  };

  const retryFailed = (): void => {
    const retryable = entries.map((entry) =>
      entry.status === 'error' && entry.file.size <= MAX_UPLOAD_BYTES
        ? { ...entry, status: 'pending' as EntryStatus, progress: 0, message: undefined }
        : entry,
    );
    setEntries(retryable);
    void start(retryable);
  };

  const pendingCount = entries.filter((entry) => entry.status === 'pending').length;
  const failedCount = entries.filter(
    (entry) => entry.status === 'error' && entry.file.size <= MAX_UPLOAD_BYTES,
  ).length;
  const doneCount = entries.filter((entry) => entry.status === 'done').length;

  return (
    <Modal
      open={props.open}
      onClose={running ? () => undefined : props.onClose}
      title="上传文件"
      description={`目标目录：${props.root}:${props.path}`}
      size="lg"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={props.onClose} disabled={running}>
            关闭
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<RotateCcw className="h-3.5 w-3.5" />}
            onClick={retryFailed}
            disabled={running || failedCount === 0}
          >
            重试失败项（{failedCount}）
          </Button>
          {running ? (
            <Button
              variant="danger"
              size="sm"
              icon={<Ban className="h-3.5 w-3.5" />}
              onClick={cancel}
            >
              取消上传
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              icon={<UploadCloud className="h-3.5 w-3.5" />}
              onClick={() => void start(entries)}
              disabled={pendingCount === 0}
            >
              开始上传（{pendingCount}）
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField
          label="同名文件处理"
          description="“覆盖”会替换同名文件；“跳过”保留服务器文件；“重命名”自动生成 name (1).ext。"
        >
          <Select
            value={conflict}
            onChange={(event) => setConflict(event.target.value as ConflictMode)}
            disabled={running}
            options={[
              { value: 'overwrite', label: '覆盖同名文件' },
              { value: 'skip', label: '跳过同名文件' },
              { value: 'rename', label: '自动重命名' },
            ]}
          />
        </FormField>

        <div
          onDragOver={(event) => {
            event.preventDefault();
            if (!running) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            if (running) return;
            const files = Array.from(event.dataTransfer.files);
            if (files.length > 0) addFiles(files);
          }}
          className={cn(
            'flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-7 text-center transition-colors',
            dragging
              ? 'border-app-accent bg-app-accent/10'
              : 'border-app-border bg-app-surface/40',
          )}
        >
          <span className="rounded-full bg-app-elevated p-2.5 text-app-accent">
            <UploadCloud className="h-5 w-5" />
          </span>
          <p className="text-sm text-app-text">
            拖拽文件到这里，或{' '}
            <button
              type="button"
              className="font-medium text-app-accent hover:underline"
              onClick={() => inputRef.current?.click()}
              disabled={running}
            >
              选择文件
            </button>
          </p>
          <p className="text-xs text-app-muted">支持多文件；单文件上限 100 MiB。</p>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            aria-label="选择要上传的文件"
            onChange={(event) => {
              const files = event.target.files === null ? [] : Array.from(event.target.files);
              if (files.length > 0) addFiles(files);
              event.target.value = '';
            }}
          />
        </div>

        {entries.length === 0 ? (
          <EmptyState
            compact
            icon={<FileUp className="h-5 w-5" />}
            title="尚未选择文件"
            description="选择或拖入文件后，这里会显示上传队列与进度。"
          />
        ) : (
          <div className="flex max-h-72 flex-col gap-2 overflow-auto pr-1">
            {entries.map((entry) => (
              <div
                key={entry.id}
                className="flex flex-col gap-1.5 rounded-lg border border-app-border bg-app-surface px-2.5 py-2"
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs text-app-text" title={entry.file.name}>
                    {entry.file.name}
                    {entry.targetName !== undefined && entry.targetName !== entry.file.name ? (
                      <span className="ml-1 text-app-muted">→ {entry.targetName}</span>
                    ) : null}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-app-muted">
                    {formatBytes(entry.file.size)}
                  </span>
                  <Badge tone={statusTone(entry)}>{statusLabel(entry)}</Badge>
                  {!running && entry.status !== 'uploading' ? (
                    <button
                      type="button"
                      aria-label={`移除 ${entry.file.name}`}
                      title="移除"
                      className="rounded p-0.5 text-app-muted hover:bg-app-elevated hover:text-app-danger"
                      onClick={() =>
                        setEntries((prev) => prev.filter((item) => item.id !== entry.id))
                      }
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>
                {entry.status === 'uploading' || entry.status === 'done' ? (
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-app-elevated">
                    <div
                      className={cn(
                        'h-full rounded-full transition-all',
                        entry.status === 'done' ? 'bg-app-success' : 'bg-app-accent',
                      )}
                      style={{ width: `${Math.round(entry.progress * 100)}%` }}
                    />
                  </div>
                ) : null}
                {entry.message !== undefined ? (
                  <p
                    className={cn(
                      'text-[11px] leading-snug',
                      entry.status === 'error' ? 'text-app-danger' : 'text-app-muted',
                    )}
                  >
                    {entry.message}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        )}

        {running ? (
          <Alert tone="info" title="正在上传">
            关闭按钮在上传期间不可用；可以点击“取消上传”中断剩余队列。
          </Alert>
        ) : null}
        {doneCount > 0 && !running ? (
          <Alert tone="success" title={`已完成 ${doneCount} 个文件`}>
            列表会自动刷新；关闭对话框可继续操作。
            <Button
              variant="ghost"
              size="xs"
              className="ml-2"
              icon={<X className="h-3 w-3" />}
              onClick={props.onClose}
            >
              收起
            </Button>
          </Alert>
        ) : null}
      </div>
    </Modal>
  );
}
