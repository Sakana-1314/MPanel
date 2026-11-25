import { Archive, File, FileCode, FileImage, FileText, Folder } from 'lucide-react';
import type { FileType } from '../../api/types';
import { cn } from '../../lib/cn';

export interface FileIconProps {
  type: FileType | string;
  name?: string;
  className?: string;
}

const CODE_EXT = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'json',
  'yml',
  'yaml',
  'toml',
  'sh',
  'bash',
  'ps1',
  'sql',
  'html',
  'css',
  'scss',
  'py',
  'go',
  'rs',
  'java',
  'php',
  'conf',
  'ini',
  'caddy',
  'caddyfile',
]);
const ARCHIVE_EXT = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'avif']);

function extOf(name: string | undefined): string {
  if (name === undefined) return '';
  const index = name.lastIndexOf('.');
  if (index < 0 || index === name.length - 1) return '';
  return name.slice(index + 1).toLowerCase();
}

/** 按类型/扩展名给出图标；目录统一文件夹。 */
export function FileIcon(props: FileIconProps): JSX.Element {
  const className = cn('h-4 w-4 shrink-0', props.className);
  if (props.type === 'directory') return <Folder className={cn(className, 'text-app-accent')} />;
  if (props.type === 'symlink') return <File className={cn(className, 'text-app-info')} />;

  const ext = extOf(props.name);
  if (ARCHIVE_EXT.has(ext)) return <Archive className={cn(className, 'text-app-warning')} />;
  if (IMAGE_EXT.has(ext)) return <FileImage className={cn(className, 'text-app-success')} />;
  if (CODE_EXT.has(ext)) return <FileCode className={cn(className, 'text-app-info')} />;
  if (ext === 'md' || ext === 'txt' || ext === 'log') {
    return <FileText className={cn(className, 'text-app-muted')} />;
  }
  return <File className={cn(className, 'text-app-muted')} />;
}
