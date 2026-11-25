import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Boxes,
  Clock,
  Container,
  Database,
  Files,
  Globe,
  Layers,
  LayoutDashboard,
  Moon,
  Network,
  RefreshCw,
  Server,
  Settings,
  ShieldCheck,
  Sun,
  Terminal,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useActiveConnection } from '../lib/connection-store';
import { useRefresh } from '../lib/use-refresh';
import { useTheme } from '../app/ThemeProvider';
import { cn } from '../lib/cn';
import { Modal } from './ui/Modal';
import { Input } from './ui/Input';

export const OPEN_COMMAND_PALETTE_EVENT = 'mpanel:open-command-palette';

interface PaletteCommand {
  id: string;
  label: string;
  hint?: string;
  icon: LucideIcon;
  keywords?: string;
  run(): void;
}

interface NavCommand {
  to: string;
  label: string;
  icon: LucideIcon;
  coreOnly?: boolean;
}

const NAV: NavCommand[] = [
  { to: '/', label: '概览', icon: LayoutDashboard },
  { to: '/edge', label: '边缘节点', icon: Network, coreOnly: true },
  { to: '/machines', label: '机器', icon: Server, coreOnly: true },
  { to: '/sites', label: '站点', icon: Globe },
  { to: '/certs', label: '证书', icon: ShieldCheck },
  { to: '/databases', label: '数据库', icon: Database },
  { to: '/containers', label: '容器', icon: Container },
  { to: '/images', label: '镜像', icon: Boxes },
  { to: '/stacks', label: '编排', icon: Layers },
  { to: '/files', label: '文件', icon: Files },
  { to: '/terminal', label: '终端', icon: Terminal },
  { to: '/tasks', label: '计划任务', icon: Clock },
  { to: '/settings', label: '设置', icon: Settings },
];

/** Ctrl/⌘+K 命令面板（可选功能）：跳转页面 + 主题 + 刷新。 */
export function CommandPalette(): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const navigate = useNavigate();
  const { theme, toggleTheme } = useTheme();
  const { refresh } = useRefresh();
  const connection = useActiveConnection();
  const isCore = connection?.kind === 'core';

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setActiveIndex(0);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    const onOpenEvent = (): void => setOpen(true);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpenEvent);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpenEvent);
    };
  }, []);

  const commands = useMemo<PaletteCommand[]>(() => {
    const navigation: PaletteCommand[] = NAV.filter((item) => item.coreOnly !== true || isCore).map(
      (item) => ({
        id: `nav:${item.to}`,
        label: `前往 ${item.label}`,
        hint: item.to,
        icon: item.icon,
        keywords: item.label,
        run: () => {
          navigate(item.to);
          close();
        },
      }),
    );
    return [
      ...navigation,
      {
        id: 'action:theme',
        label: theme === 'dark' ? '切换到浅色主题' : '切换到深色主题',
        icon: theme === 'dark' ? Sun : Moon,
        keywords: 'theme 主题 深色 浅色',
        run: () => {
          toggleTheme();
          close();
        },
      },
      {
        id: 'action:refresh',
        label: '刷新当前页面数据',
        icon: RefreshCw,
        keywords: 'refresh 刷新',
        run: () => {
          refresh();
          close();
        },
      },
    ];
  }, [navigate, close, theme, toggleTheme, refresh, isCore]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return commands;
    return commands.filter((command) =>
      `${command.label} ${command.hint ?? ''} ${command.keywords ?? ''}`
        .toLowerCase()
        .includes(needle),
    );
  }, [commands, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  if (!open) return null;

  return (
    <Modal open={open} onClose={close} size="md" bodyClassName="p-0">
      <div className="flex flex-col">
        <div className="border-b border-app-border p-2">
          <Input
            autoFocus
            value={query}
            placeholder="输入命令或页面名称…"
            aria-label="命令面板搜索"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActiveIndex((index) => Math.min(index + 1, Math.max(filtered.length - 1, 0)));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActiveIndex((index) => Math.max(index - 1, 0));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                filtered[activeIndex]?.run();
              }
            }}
          />
        </div>
        <ul className="max-h-80 overflow-auto p-1">
          {filtered.length === 0 ? (
            <li className="px-3 py-6 text-center text-xs text-app-muted">没有匹配的命令</li>
          ) : (
            filtered.map((command, index) => (
              <li key={command.id}>
                <button
                  type="button"
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={command.run}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors',
                    index === activeIndex
                      ? 'bg-app-accent/12 text-app-text'
                      : 'text-app-muted hover:bg-app-elevated',
                  )}
                >
                  <command.icon className="h-4 w-4 shrink-0" />
                  <span className="flex-1 truncate">{command.label}</span>
                  {command.hint === undefined ? null : (
                    <span className="text-[10px] text-app-muted">{command.hint}</span>
                  )}
                </button>
              </li>
            ))
          )}
        </ul>
        <div className="flex items-center justify-between border-t border-app-border px-3 py-1.5 text-[10px] text-app-muted">
          <span>↑↓ 选择 · Enter 执行 · Esc 关闭</span>
          <span>Ctrl/⌘ + K</span>
        </div>
      </div>
    </Modal>
  );
}
