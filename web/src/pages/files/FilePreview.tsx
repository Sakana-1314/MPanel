import { ArrowDownToLine, FileWarning, ImageOff } from 'lucide-react';
import type { FileItem } from '../../api/types';
import { Alert } from '../../components/ui/Alert';
import { Button } from '../../components/ui/Button';
import { CodeBlock } from '../../components/ui/CodeBlock';
import { EmptyState } from '../../components/ui/EmptyState';
import { formatBytes } from '../../lib/format';

export interface FilePreviewProps {
  file: FileItem;
  content: string;
  isBinary: boolean;
  /** 图片预览的 data URL（由 base64 读取结果构造）。 */
  imageUrl?: string;
  /** 读取被 maxBytes 截断时为 true。 */
  truncated?: boolean;
  /** 图片预览失败/不可用时的说明。 */
  imageError?: string;
  onDownload?(): void;
}

function DownloadAction(props: { onDownload?(): void }): JSX.Element | null {
  if (props.onDownload === undefined) return null;
  return (
    <Button
      variant="secondary"
      size="sm"
      icon={<ArrowDownToLine className="h-3.5 w-3.5" />}
      onClick={props.onDownload}
    >
      下载文件
    </Button>
  );
}

/** 只读预览：图片、二进制提示、文本代码块；可编辑内容由 FileEditorDrawer 使用 CodeEditor。 */
export function FilePreview(props: FilePreviewProps): JSX.Element {
  if (props.imageUrl !== undefined) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-center rounded-lg border border-app-border bg-app-elevated/40 p-3">
          <img
            src={props.imageUrl}
            alt={props.file.name}
            className="max-h-[60vh] max-w-full rounded object-contain"
          />
        </div>
        <p className="text-xs text-app-muted">
          {formatBytes(props.file.size)} · 图片预览（只读）
        </p>
      </div>
    );
  }

  if (props.imageError !== undefined) {
    return (
      <EmptyState
        icon={<ImageOff className="h-5 w-5" />}
        title="图片预览不可用"
        description={props.imageError}
        action={<DownloadAction onDownload={props.onDownload} />}
      />
    );
  }

  if (props.isBinary) {
    return (
      <EmptyState
        icon={<FileWarning className="h-5 w-5" />}
        title="二进制文件，无法在线编辑"
        description="该文件不是 UTF-8 文本（或包含二进制内容）。请下载后使用本地工具查看。"
        action={<DownloadAction onDownload={props.onDownload} />}
      />
    );
  }

  if (props.content.length === 0) {
    return (
      <EmptyState
        title="空文件"
        description="文件内容为空；可以在编辑器中输入内容后保存。"
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {props.truncated === true ? (
        <Alert tone="warning" title="内容已截断" hint="只读取了文件开头部分，保存会覆盖整个文件，因此已禁用编辑。">
          文件超过单次读取上限（8 MiB）；请下载后编辑，或拆分文件。
        </Alert>
      ) : null}
      <CodeBlock code={props.content} maxHeight="60vh" copyable />
    </div>
  );
}
