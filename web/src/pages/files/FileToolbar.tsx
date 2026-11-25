import {
  Archive,
  FilePlus2,
  FolderPlus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Switch } from '../../components/ui/Switch';
import { Toolbar } from '../../components/ui/Toolbar';

export interface FileToolbarProps {
  root: string;
  path: string;
  onRefresh: () => void;
  onNewFolder: () => void;
  onUpload: () => void;
  onArchive: () => void;
  onSearch: () => void;
  onTrash: () => void;
  onNewFile?(): void;
  showHidden?: boolean;
  onShowHiddenChange?(value: boolean): void;
  selectionCount?: number;
  onDownloadSelected?(): void;
  onCopySelected?(): void;
  onMoveSelected?(): void;
  onDeleteSelected?(): void;
  onClearSelection?(): void;
  /** 当前根是否可写；false 时禁用新建/上传等写操作。 */
  writable?: boolean;
  loading?: boolean;
  itemCount?: number;
}

/** 文件浏览器工具栏 + 批量选择操作条。 */
export function FileToolbar(props: FileToolbarProps): JSX.Element {
  const writable = props.writable !== false;
  const selectionCount = props.selectionCount ?? 0;

  return (
    <>
      <Toolbar
        bordered
        left={
          <>
            <span className="max-w-[22rem] truncate font-mono text-[11px] text-app-muted" title={`${props.root}:${props.path}`}>
              {props.root}:{props.path}
            </span>
            {props.itemCount === undefined ? null : (
              <span className="text-[11px] text-app-muted">共 {props.itemCount} 项</span>
            )}
          </>
        }
        right={
          <>
            <Switch
              checked={props.showHidden === true}
              onChange={(checked) => props.onShowHiddenChange?.(checked)}
              label="显示隐藏文件"
            />
            <Button
              size="sm"
              variant="ghost"
              icon={<RefreshCw className="h-3.5 w-3.5" />}
              onClick={props.onRefresh}
              loading={props.loading === true}
              title="刷新目录"
            >
              刷新
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon={<FolderPlus className="h-3.5 w-3.5" />}
              onClick={props.onNewFolder}
              disabled={!writable}
              title={writable ? '新建文件夹' : '当前文件根只读'}
            >
              新建文件夹
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon={<FilePlus2 className="h-3.5 w-3.5" />}
              onClick={props.onNewFile}
              disabled={!writable || props.onNewFile === undefined}
              title={writable ? '新建空文件' : '当前文件根只读'}
            >
              新建文件
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon={<Upload className="h-3.5 w-3.5" />}
              onClick={props.onUpload}
              disabled={!writable}
              title={writable ? '上传文件' : '当前文件根只读'}
            >
              上传
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon={<Archive className="h-3.5 w-3.5" />}
              onClick={props.onArchive}
              title="将选中项打包为归档"
            >
              打包
            </Button>
            <Button
              size="sm"
              variant="secondary"
              icon={<Search className="h-3.5 w-3.5" />}
              onClick={props.onSearch}
            >
              搜索
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<Trash2 className="h-3.5 w-3.5" />}
              onClick={props.onTrash}
            >
              回收站
            </Button>
          </>
        }
      />
      {selectionCount > 0 ? (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-app-accent/40 bg-app-accent/5 px-3 py-2 text-xs">
          <span className="font-medium text-app-text">已选择 {selectionCount} 项</span>
          <span className="text-app-muted">可下载单个文件、复制/移动或批量删除（删除移入回收站）。</span>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <Button
              size="xs"
              variant="secondary"
              onClick={props.onDownloadSelected}
              disabled={selectionCount !== 1}
              title={selectionCount === 1 ? '下载选中文件' : '多选时请使用“打包”'}
            >
              下载
            </Button>
            <Button
              size="xs"
              variant="secondary"
              onClick={props.onCopySelected}
              disabled={!writable}
            >
              复制
            </Button>
            <Button
              size="xs"
              variant="secondary"
              onClick={props.onMoveSelected}
              disabled={!writable}
            >
              移动
            </Button>
            <Button
              size="xs"
              variant="danger"
              onClick={props.onDeleteSelected}
              disabled={!writable}
            >
              删除
            </Button>
            <Button
              size="xs"
              variant="ghost"
              icon={<X className="h-3.5 w-3.5" />}
              onClick={props.onClearSelection}
            >
              取消选择
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}
