import { useEffect, useState } from 'react';
import { Archive, PackageOpen } from 'lucide-react';
import type { FileItem } from '../../api/types';
import { archiveFiles, extractFile } from '../../api/files';
import { describeError } from '../../api/errors';
import { useAppMutation } from '../../lib/mutations';
import { scopedKey } from '../../lib/query-keys';
import { formatBytes } from '../../lib/format';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { FormField } from '../../components/ui/FormField';
import { Input } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { Select } from '../../components/ui/Select';
import { baseName, joinVirtualPath, parentVirtualPath, validateVirtualPath } from './Breadcrumbs';

type ArchiveFormat = 'tar.gz' | 'tar' | 'zip';

function timestampFragment(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function replaceArchiveExtension(value: string, format: ArchiveFormat): string {
  const trimmed = value.trim();
  const withoutExt = trimmed.replace(/\.(tar\.gz|tgz|tar|zip)$/i, '');
  return `${withoutExt.length === 0 ? `archive-${timestampFragment()}` : withoutExt}.${format}`;
}

export interface ArchiveDialogProps {
  open: boolean;
  root: string;
  paths: string[];
  onClose(): void;
  onDone(): void;
  /** 默认归档位置所在目录；缺省用第一个源路径的父目录。 */
  basePath?: string;
}

/** 选中项打包：命名目标归档、选择格式；zip 依赖 worker 的 bsdtar/zip。 */
export function ArchiveDialog(props: ArchiveDialogProps): JSX.Element {
  const [destination, setDestination] = useState('');
  const [format, setFormat] = useState<ArchiveFormat>('tar.gz');
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) return;
    const first = props.paths[0];
    const base =
      props.basePath !== undefined
        ? props.basePath
        : first === undefined
          ? '/'
          : parentVirtualPath(first);
    setFormat('tar.gz');
    setDestination(joinVirtualPath(base, `archive-${timestampFragment()}.tar.gz`));
    setValidationError(null);
  }, [props.open, props.basePath, props.paths]);

  const archiveMutation = useAppMutation({
    mutationFn: () =>
      archiveFiles({
        root: props.root,
        paths: props.paths,
        destination: destination.trim(),
        format,
      }),
    successMessage: (result) => `已创建 ${baseName(result.path)}`,
    successDescription: (result) =>
      `${result.entries} 个条目，${formatBytes(result.sizeBytes)}；刷新列表后可下载。`,
    invalidate: [scopedKey('files', 'list'), scopedKey('files', 'roots')],
    onSuccess: () => {
      props.onDone();
      props.onClose();
    },
  });

  const submit = (): void => {
    const pathError = validateVirtualPath(destination.trim());
    if (pathError !== null) {
      setValidationError(pathError);
      return;
    }
    if (props.paths.includes(destination.trim())) {
      setValidationError('归档目标不能与源路径相同。');
      return;
    }
    setValidationError(null);
    archiveMutation.mutate();
  };

  const error = archiveMutation.error;
  const errorInfo = error === null ? null : describeError(error, '打包失败');

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title="打包为归档"
      description={`将 ${props.paths.length} 个选中项打包到 ${props.root}`}
      size="md"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={props.onClose} disabled={archiveMutation.isPending}>
            取消
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon={<Archive className="h-3.5 w-3.5" />}
            onClick={submit}
            loading={archiveMutation.isPending}
            disabled={props.paths.length === 0}
          >
            开始打包
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="rounded-lg border border-app-border bg-app-elevated/40 px-3 py-2 text-xs text-app-muted">
          <p className="mb-1 font-medium text-app-text">将打包以下 {props.paths.length} 项：</p>
          <ul className="flex max-h-28 flex-col gap-0.5 overflow-auto font-mono text-[11px]">
            {props.paths.map((path) => (
              <li key={path} className="truncate" title={path}>
                {path}
              </li>
            ))}
          </ul>
        </div>

        <FormField
          label="归档目标路径"
          required
          description="必须是当前文件根内的虚拟路径；目标不能位于被选中的目录内部。"
          error={validationError}
        >
          <Input
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
            placeholder="/backup/archive.tar.gz"
            className="font-mono"
            invalid={validationError !== null}
          />
        </FormField>

        <FormField
          label="格式"
          description="tar.gz/tar 使用 agent 上的 tar 命令；zip 需要 bsdtar 或 zip，缺失时返回 UNAVAILABLE。"
        >
          <Select
            value={format}
            onChange={(event) => {
              const next = event.target.value as ArchiveFormat;
              setFormat(next);
              setDestination((prev) => replaceArchiveExtension(prev, next));
            }}
            options={[
              { value: 'tar.gz', label: 'tar.gz（推荐）' },
              { value: 'tar', label: 'tar' },
              { value: 'zip', label: 'zip（需要 bsdtar/zip）' },
            ]}
          />
        </FormField>

        {errorInfo !== null ? (
          <Alert tone="danger" title={errorInfo.title} hint={errorInfo.hint}>
            {errorInfo.description}
          </Alert>
        ) : null}
        {format === 'zip' ? (
          <Alert tone="info" title="zip 能力提示">
            若 agent 未安装 bsdtar/zip，接口会返回 UNAVAILABLE 并附带安装提示；可改用 tar.gz。
          </Alert>
        ) : null}
      </div>
    </Modal>
  );
}

export interface ExtractDialogProps {
  open: boolean;
  root: string;
  file: FileItem | null;
  onClose(): void;
  onDone(): void;
}

/** 解压归档：确认目标目录（默认归档所在目录），由后端做条目预检。 */
export function ExtractDialog(props: ExtractDialogProps): JSX.Element {
  const [destination, setDestination] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open || props.file === null) return;
    setDestination(parentVirtualPath(props.file.path));
    setValidationError(null);
  }, [props.open, props.file]);

  const extractMutation = useAppMutation({
    mutationFn: () =>
      extractFile({
        root: props.root,
        path: props.file?.path ?? '',
        destination: destination.trim(),
      }),
    successMessage: (result) => `已解压 ${result.entries} 个条目`,
    successDescription: (result) => `目标目录：${result.destination}`,
    invalidate: [scopedKey('files', 'list'), scopedKey('files', 'roots')],
    onSuccess: () => {
      props.onDone();
      props.onClose();
    },
  });

  const submit = (): void => {
    const pathError = validateVirtualPath(destination.trim());
    if (pathError !== null) {
      setValidationError(pathError);
      return;
    }
    setValidationError(null);
    extractMutation.mutate();
  };

  const error = extractMutation.error;
  const errorInfo = error === null ? null : describeError(error, '解压失败');

  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title="解压归档"
      description={props.file === null ? undefined : `${props.root}:${props.file.path}`}
      size="md"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={props.onClose} disabled={extractMutation.isPending}>
            取消
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon={<PackageOpen className="h-3.5 w-3.5" />}
            onClick={submit}
            loading={extractMutation.isPending}
            disabled={props.file === null}
          >
            解压到目标目录
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="rounded-lg border border-app-border bg-app-elevated/40 px-3 py-2 text-xs text-app-muted">
          <p className="font-mono text-app-text" title={props.file?.path}>
            {props.file?.name ?? '未选择归档'}
          </p>
          {props.file !== null ? (
            <p className="mt-0.5">大小：{formatBytes(props.file.size)}</p>
          ) : null}
        </div>

        <FormField
          label="解压目标目录"
          required
          description="目标必须是当前文件根内的现有目录；后端会先检查条目，拒绝绝对路径、.. 与链接。"
          error={validationError}
        >
          <Input
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
            placeholder="/target/dir"
            className="font-mono"
            invalid={validationError !== null}
          />
        </FormField>

        <Alert tone="info" title="冲突与上限">
          目标目录已有同名文件时会返回 CONFLICT；单次解压上限为 10 万条目 / 5 GiB。
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
