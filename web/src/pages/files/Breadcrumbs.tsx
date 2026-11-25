import { ChevronRight, Folder, Home } from 'lucide-react';
import { cn } from '../../lib/cn';

export interface BreadcrumbsProps {
  path: string;
  onNavigate: (path: string) => void;
  /** 当前文件根名称；提供后在最左侧显示根入口。 */
  root?: string;
  className?: string;
}

/* ------------------------------- 虚拟路径工具 ------------------------------ */

/** 确保虚拟路径以单个 `/` 开头、不以 `/` 结尾（根目录除外）。 */
export function normalizeVirtualPath(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) return '/';
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const withoutTrailing = withLeading.length > 1 ? withLeading.replace(/\/+$/, '') : '/';
  return withoutTrailing.length === 0 ? '/' : withoutTrailing;
}

/** 目录 + 名称 → 虚拟路径；名称中的前导 `/` 会被去掉。 */
export function joinVirtualPath(dir: string, name: string): string {
  const base = normalizeVirtualPath(dir);
  const cleanName = name.replace(/^\/+/, '');
  if (base === '/') return `/${cleanName}`;
  return `${base}/${cleanName}`;
}

/** 父目录；根目录的父目录仍是根目录。 */
export function parentVirtualPath(path: string): string {
  const normalized = normalizeVirtualPath(path);
  if (normalized === '/') return '/';
  const index = normalized.lastIndexOf('/');
  return index <= 0 ? '/' : normalized.slice(0, index);
}

/** 路径最后一段（文件名/目录名）。 */
export function baseName(path: string): string {
  const normalized = normalizeVirtualPath(path);
  if (normalized === '/') return '/';
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

/** 面包屑分段。 */
export function pathSegments(path: string): string[] {
  return normalizeVirtualPath(path)
    .split('/')
    .filter((segment) => segment.length > 0);
}

/** 校验单个文件/目录名；返回中文错误信息，合法时返回 null。 */
export function validateEntryName(name: string): string | null {
  if (name.length === 0) return '名称不能为空。';
  if (name === '.' || name === '..') return '名称不能是 “.” 或 “..”。';
  if (name.includes('/')) return '名称不能包含斜杠 “/”。';
  if (name.includes('\\')) return '名称不能包含反斜杠 “\\”。';
  if (/[\u0000-\u001f\u007f]/.test(name)) return '名称不能包含控制字符。';
  if (name.length > 255) return '名称不能超过 255 个字符。';
  return null;
}

/** 校验完整虚拟路径（目标目录/归档文件）；返回中文错误信息，合法时返回 null。 */
export function validateVirtualPath(path: string): string | null {
  const value = path.trim();
  if (value.length === 0) return '路径不能为空。';
  if (!value.startsWith('/')) return '路径必须以 “/” 开头（文件根内 POSIX 虚拟路径）。';
  if (value.includes('\\')) return '路径不能包含反斜杠 “\\”。';
  if (/[\u0000-\u001f\u007f]/.test(value)) return '路径不能包含控制字符。';
  for (const segment of value.split('/')) {
    if (segment === '..') return '路径不能包含 “..” 段（禁止越界）。';
  }
  return null;
}

const ARCHIVE_EXTENSIONS = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz']);

export function isArchiveName(name: string): boolean {
  const index = name.lastIndexOf('.');
  if (index < 0 || index === name.length - 1) return false;
  return ARCHIVE_EXTENSIONS.has(name.slice(index + 1).toLowerCase());
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'avif']);

export function isImageName(name: string): boolean {
  const index = name.lastIndexOf('.');
  if (index < 0 || index === name.length - 1) return false;
  return IMAGE_EXTENSIONS.has(name.slice(index + 1).toLowerCase());
}

export function extensionOf(name: string): string {
  const index = name.lastIndexOf('.');
  if (index < 0 || index === name.length - 1) return '';
  return name.slice(index + 1).toLowerCase();
}

/* --------------------------------- 组件 --------------------------------- */

/** 面包屑：根入口 + 逐段可点击的路径。 */
export function Breadcrumbs(props: BreadcrumbsProps): JSX.Element {
  const segments = pathSegments(props.path);
  return (
    <nav
      aria-label="目录路径"
      className={cn('mb-2 flex flex-wrap items-center gap-1 text-xs text-app-muted', props.className)}
    >
      <button
        type="button"
        onClick={() => props.onNavigate('/')}
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-app-elevated hover:text-app-text"
        title="回到根目录"
      >
        <Home className="h-3.5 w-3.5" />
        {props.root === undefined ? '根目录' : props.root}
      </button>
      <ChevronRight className="h-3 w-3 shrink-0 opacity-60" />
      <button
        type="button"
        onClick={() => props.onNavigate('/')}
        className="rounded px-1 py-0.5 font-mono hover:bg-app-elevated hover:text-app-text"
      >
        /
      </button>
      {segments.map((segment, index) => {
        const target = `/${segments.slice(0, index + 1).join('/')}`;
        const last = index === segments.length - 1;
        return (
          <span key={target} className="flex min-w-0 items-center gap-1">
            <ChevronRight className="h-3 w-3 shrink-0 opacity-60" />
            {last ? (
              <span className="flex min-w-0 items-center gap-1 rounded bg-app-elevated px-1.5 py-0.5 font-mono text-app-text">
                <Folder className="h-3.5 w-3.5 shrink-0 text-app-accent" />
                <span className="truncate">{segment}</span>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => props.onNavigate(target)}
                className="max-w-[12rem] truncate rounded px-1 py-0.5 font-mono hover:bg-app-elevated hover:text-app-text"
                title={target}
              >
                {segment}
              </button>
            )}
          </span>
        );
      })}
    </nav>
  );
}
