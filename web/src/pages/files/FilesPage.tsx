import { HardDrive } from 'lucide-react';
import { PageHeader } from '../../components/ui/PageHeader';
import { FileBrowser } from './FileBrowser';

/** 文件管理页面：文件根沙箱浏览、编辑、上传、归档与回收站。 */
export default function FilesPage(): JSX.Element {
  return (
    <div>
      <PageHeader
        title="文件管理"
        description="浏览 worker 暴露的沙箱文件根：上传/下载、在线编辑文本与图片、打包解压，以及回收站恢复。"
        meta={
          <span className="inline-flex items-center gap-1 rounded-full border border-app-border bg-app-elevated px-2 py-0.5 text-[11px] text-app-muted">
            <HardDrive className="h-3 w-3" />
            路径限制在文件根内
          </span>
        }
      />
      <FileBrowser />
    </div>
  );
}
