import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Command,
  LogOut,
  Menu,
  Moon,
  RefreshCw,
  Settings2,
  Sun,
  User,
} from 'lucide-react';
import { getSystemInfo, systemKeys } from '../../api/system';
import { coreLogout } from '../../api/auth';
import { useActiveConnection } from '../../lib/connection-store';
import { removeSecret } from '../../lib/connection-secrets';
import { clearAuth } from '../../lib/auth-store';
import { queryClient } from '../../lib/query-client';
import { useRefresh } from '../../lib/use-refresh';
import { useSession } from '../../lib/use-session';
import { useTheme } from '../../app/ThemeProvider';
import { cn } from '../../lib/cn';
import { ConnectionManager } from '../ConnectionManager';
import { StatusBadge } from '../ui/StatusBadge';
import { Button } from '../ui/Button';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Tooltip } from '../ui/Tooltip';
import { useToast } from '../ui/Toast';
import { MachineSwitcher } from './MachineSwitcher';
import { OPEN_COMMAND_PALETTE_EVENT } from '../CommandPalette';

export interface TopBarProps {
  onMenuClick?(): void;
}

/** 顶栏：当前机器 + 在线状态 + 全局刷新 + 主题/命令面板/连接设置/退出。 */
export function TopBar(props: TopBarProps = {}): JSX.Element {
  const connection = useActiveConnection();
  const session = useSession();
  const { theme, toggleTheme } = useTheme();
  const { refresh, busy } = useRefresh();
  const toast = useToast();
  const navigate = useNavigate();

  const [managerOpen, setManagerOpen] = useState(false);
  const [logoutOpen, setLogoutOpen] = useState(false);

  const statusQuery = useQuery({
    queryKey: systemKeys.info(),
    queryFn: () => getSystemInfo(),
    enabled: connection !== undefined && session.status === 'authenticated',
    retry: 1,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  const onlineState =
    connection === undefined
      ? { status: 'unknown', label: '未连接' }
      : session.status !== 'authenticated'
        ? { status: 'unknown', label: '未登录' }
        : statusQuery.isError
          ? { status: 'offline', label: '不可达' }
          : statusQuery.data !== undefined
            ? { status: 'online', label: '在线' }
            : { status: 'starting', label: '检查中' };

  const doLogout = async (): Promise<void> => {
    if (connection === undefined) return;
    try {
      if (connection.kind === 'core') {
        await coreLogout();
      }
    } catch {
      // 会话可能已过期，忽略并继续清理本地状态。
    }
    if (connection.kind === 'worker') removeSecret(connection.id);
    clearAuth(connection.id);
    queryClient.clear();
    toast.success('已退出登录');
    setLogoutOpen(false);
    navigate('/login');
  };

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-app-border bg-app-surface/90 px-3 backdrop-blur md:px-4">
      <div className="flex min-w-0 items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          onClick={props.onMenuClick}
          aria-label="打开菜单"
        >
          <Menu className="h-4 w-4" />
        </Button>
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-app-text">
              {connection?.name ?? '未连接后端'}
            </span>
            <StatusBadge status={onlineState.status} label={onlineState.label} size="sm" />
          </div>
          <div className="hidden items-center gap-2 text-[11px] text-app-muted sm:flex">
            {statusQuery.data === undefined ? (
              <span>{connection === undefined ? '请先添加连接' : connection.baseUrl}</span>
            ) : (
              <span>
                {statusQuery.data.role} · v{statusQuery.data.version} · {statusQuery.data.hostname}
              </span>
            )}
          </div>
        </div>
        <span className="mx-1 hidden h-5 w-px bg-app-border lg:block" />
        <div className="hidden lg:block">
          <MachineSwitcher />
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Tooltip content="刷新当前页面数据（R）">
          <Button
            variant="ghost"
            size="icon"
            onClick={refresh}
            aria-label="刷新"
            title="刷新"
          >
            <RefreshCw className={cn('h-4 w-4', busy ? 'animate-spin' : '')} />
          </Button>
        </Tooltip>
        <Tooltip content={theme === 'dark' ? '切换到浅色' : '切换到深色'}>
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleTheme}
            aria-label="切换主题"
            title="切换主题"
          >
            {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
        </Tooltip>
        <Tooltip content="命令面板（Ctrl/⌘ + K）">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => window.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT))}
            aria-label="命令面板"
            title="命令面板"
          >
            <Command className="h-4 w-4" />
          </Button>
        </Tooltip>
        <Tooltip content="连接设置">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setManagerOpen(true)}
            aria-label="连接设置"
            title="连接设置"
          >
            <Settings2 className="h-4 w-4" />
          </Button>
        </Tooltip>

        {session.status === 'authenticated' ? (
          <div className="ml-1 flex items-center gap-1 border-l border-app-border pl-2">
            <span className="hidden max-w-32 items-center gap-1 truncate text-xs text-app-muted sm:flex">
              <User className="h-3.5 w-3.5" />
              {session.me?.user?.displayName ?? session.me?.user?.username ?? '已认证'}
            </span>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setLogoutOpen(true)}
              aria-label="退出登录"
              title="退出登录"
            >
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        ) : null}
      </div>

      <ConnectionManager open={managerOpen} onClose={() => setManagerOpen(false)} />

      <ConfirmDialog
        open={logoutOpen}
        title="退出登录"
        message={
          connection?.kind === 'core'
            ? '将注销 core 会话并清除本地 token。'
            : '将清除本地保存的 agent token（sessionStorage/localStorage）。'
        }
        confirmLabel="退出"
        onCancel={() => setLogoutOpen(false)}
        onConfirm={doLogout}
      />
    </header>
  );
}
