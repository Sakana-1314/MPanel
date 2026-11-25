import type { ReactNode } from 'react';
import {
  ArrowDownToLine,
  Copy,
  Eye,
  FolderInput,
  PackageOpen,
  Pencil,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import type { FileItem } from '../../api/types';
import { cn } from '../../lib/cn';
import { formatBytes } from '../../lib/format';
import { Badge } from '../../components/ui/Badge';
import { Checkbox } from '../../components/ui/Checkbox';
import { DataTable, type Column, type SortState } from '../../components/ui/DataTable';
import { EmptyState } from '../../components/ui/EmptyState';
import { FileIcon } from '../../components/ui/FileIcon';
import { RelativeTime } from '../../components/ui/RelativeTime';
import { isArchiveName } from './Breadcrumbs';

export interface FileTableProps {
  items: readonly FileItem[];
  selected: readonly FileItem[];
  onOpen(item: FileItem): void;
  onSelect(item: FileItem, selected: boolean): void;
  onSelectAll?(selected: boolean): void;
  sort?: SortState | null;
  onSortChange?(sort: SortState | null): void;
  loading?: boolean;
  error?: unknown;
  onRetry?(): void;
  /** 搜索定位时高亮的文件名。 */
  highlight?: string | null;
  /** 文件根只读时禁写操作。 */
  readOnly?: boolean;
  empty?: ReactNode;
  onPreview?(item: FileItem): void;
  onDownload?(item: FileItem): void;
  onRename?(item: FileItem): void;
  onCopy?(item: FileItem): void;
  onMove?(item: FileItem): void;
  onChmod?(item: FileItem): void;
  onDelete?(item: FileItem): void;
  onExtract?(item: FileItem): void;
}

interface ActionButtonProps {
  label: string;
  onClick(): void;
  disabled?: boolean;
  danger?: boolean;
  children: ReactNode;
}

function ActionButton(props: ActionButtonProps): JSX.Element {
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={(event) => {
        event.stopPropagation();
        props.onClick();
      }}
      className={cn(
        'rounded p-1 text-app-muted transition-colors hover:bg-app-elevated hover:text-app-text',
        'disabled:cursor-not-allowed disabled:opacity-35',
        props.danger === true ? 'hover:text-app-danger' : '',
      )}
    >
      {props.children}
    </button>
  );
}

function fileTypeLabel(item: FileItem): string {
  if (item.type === 'directory') return '目录';
  if (item.type === 'symlink') {
    if (item.targetType === 'directory') return '链接（目录）';
    if (item.targetType === 'file') return '链接（文件）';
    return '符号链接';
  }
  if (item.type === 'file') return '文件';
  return '其他';
}

function fileTypeTone(item: FileItem): 'accent' | 'info' | 'neutral' | 'warning' {
  if (item.type === 'directory') return 'accent';
  if (item.type === 'symlink') return 'info';
  if (item.type === 'other') return 'warning';
  return 'neutral';
}

/** 目录排序时排在文件前面（升序）。 */
function directoryFirst(item: FileItem): string {
  return item.type === 'directory' ? `0${item.name}` : `1${item.name}`;
}

/** 文件表格：名称、大小、权限、修改时间、类型与行内操作。 */
export function FileTable(props: FileTableProps): JSX.Element {
  const selectedPaths = new Set(props.selected.map((item) => item.path));
  const allSelected = props.items.length > 0 && props.items.every((item) => selectedPaths.has(item.path));
  const canWrite = props.readOnly !== true;

  const columns: Column<FileItem>[] = [
    {
      key: 'select',
      width: 40,
      header: (
        <Checkbox
          checked={allSelected}
          aria-label={allSelected ? '取消全选' : '全选'}
          onChange={(event) => props.onSelectAll?.(event.target.checked)}
        />
      ),
      render: (item) => (
        <span
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <Checkbox
            checked={selectedPaths.has(item.path)}
            aria-label={`选择 ${item.name}`}
            onChange={(event) => props.onSelect(item, event.target.checked)}
          />
        </span>
      ),
    },
    {
      key: 'name',
      header: '名称',
      sortable: true,
      sortValue: (item) => directoryFirst(item),
      render: (item) => (
        <div className="flex min-w-0 items-center gap-2">
          <FileIcon type={item.type} name={item.name} />
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              props.onOpen(item);
            }}
            className="min-w-0 truncate text-left text-app-text hover:text-app-accent"
            title={item.path}
          >
            {item.name}
          </button>
          {item.isSymlink ? (
            <Badge tone="info" className="shrink-0">
              链接
            </Badge>
          ) : null}
          {item.readonly ? (
            <Badge tone="warning" className="shrink-0" title="文件系统标记为只读">
              只读
            </Badge>
          ) : null}
        </div>
      ),
    },
    {
      key: 'size',
      header: '大小',
      sortable: true,
      align: 'right',
      width: 104,
      sortValue: (item) => (item.type === 'directory' ? -1 : item.size),
      render: (item) => (
        <span className="font-mono text-xs tabular-nums text-app-muted">
          {item.type === 'directory' ? '—' : formatBytes(item.size)}
        </span>
      ),
    },
    {
      key: 'mode',
      header: '权限',
      sortable: true,
      width: 92,
      sortValue: (item) => item.mode,
      render: (item) => (
        <span className="font-mono text-xs text-app-muted" title={`模式：${item.mode}`}>
          {item.mode.length === 0 ? '—' : item.mode}
        </span>
      ),
    },
    {
      key: 'mtime',
      header: '修改时间',
      sortable: true,
      width: 140,
      sortValue: (item) => {
        const time = Date.parse(item.mtime);
        return Number.isNaN(time) ? 0 : time;
      },
      render: (item) => (
        <RelativeTime value={item.mtime} className="text-xs text-app-muted" />
      ),
    },
    {
      key: 'type',
      header: '类型',
      width: 104,
      render: (item) => (
        <Badge tone={fileTypeTone(item)}>{fileTypeLabel(item)}</Badge>
      ),
    },
    {
      key: 'actions',
      header: '',
      width: 188,
      render: (item) => (
        <div className="flex items-center justify-end gap-0.5">
          {item.type === 'file' ? (
            <ActionButton label="预览/编辑" onClick={() => props.onPreview?.(item)}>
              <Eye className="h-3.5 w-3.5" />
            </ActionButton>
          ) : null}
          {item.type === 'file' ? (
            <ActionButton label="下载" onClick={() => props.onDownload?.(item)}>
              <ArrowDownToLine className="h-3.5 w-3.5" />
            </ActionButton>
          ) : null}
          {canWrite && item.type === 'file' && isArchiveName(item.name) ? (
            <ActionButton label="解压到目录" onClick={() => props.onExtract?.(item)}>
              <PackageOpen className="h-3.5 w-3.5" />
            </ActionButton>
          ) : null}
          <ActionButton label="重命名" disabled={!canWrite} onClick={() => props.onRename?.(item)}>
            <Pencil className="h-3.5 w-3.5" />
          </ActionButton>
          <ActionButton label="复制" disabled={!canWrite} onClick={() => props.onCopy?.(item)}>
            <Copy className="h-3.5 w-3.5" />
          </ActionButton>
          <ActionButton label="移动" disabled={!canWrite} onClick={() => props.onMove?.(item)}>
            <FolderInput className="h-3.5 w-3.5" />
          </ActionButton>
          <ActionButton label="修改权限" disabled={!canWrite} onClick={() => props.onChmod?.(item)}>
            <ShieldCheck className="h-3.5 w-3.5" />
          </ActionButton>
          <ActionButton
            label="删除（移入回收站）"
            danger
            disabled={!canWrite}
            onClick={() => props.onDelete?.(item)}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </ActionButton>
        </div>
      ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={props.items}
      rowKey={(item) => `${item.root}:${item.path}`}
      loading={props.loading === true}
      error={props.error}
      onRetry={props.onRetry}
      onRowClick={props.onOpen}
      rowClassName={(item) =>
        cn(
          selectedPaths.has(item.path) ? 'bg-app-accent/10 hover:bg-app-accent/15' : '',
          props.highlight !== null && props.highlight !== undefined && item.name === props.highlight
            ? 'ring-1 ring-inset ring-app-accent/60'
            : '',
        )
      }
      sort={props.sort}
      onSortChange={props.onSortChange}
      dense
      stickyHeader
      empty={
        props.empty ?? (
          <EmptyState
            compact
            title="目录为空"
            description="这里还没有文件；可以新建文件夹、上传文件或拖拽文件到上传对话框。"
          />
        )
      }
      footer={
        <span className="text-[11px] text-app-muted">
          共 {props.items.length} 项；默认目录优先，点击表头可切换排序。
        </span>
      }
    />
  );
}
