import { Link } from 'react-router-dom';
import { Clock, Files, Globe, TerminalSquare } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';

interface QuickAction {
  to: string;
  label: string;
  description: string;
  icon: LucideIcon;
}

const ACTIONS: readonly QuickAction[] = [
  {
    to: '/sites/new',
    label: '新建站点',
    description: '创建 Caddy 站点配置',
    icon: Globe,
  },
  {
    to: '/terminal',
    label: '打开终端',
    description: '连接到目标机器的 shell',
    icon: TerminalSquare,
  },
  {
    to: '/files',
    label: '上传文件',
    description: '浏览文件根并上传文件',
    icon: Files,
  },
  {
    to: '/tasks/new',
    label: '新建任务',
    description: '创建 cron 计划任务',
    icon: Clock,
  },
];

export function QuickActions(props: { needsMachine: boolean }): JSX.Element {
  return (
    <section>
      <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-app-text">快捷操作</h2>
          <p className="text-xs text-app-muted">
            跳转到对应页面；core 连接下这些页面仍需要已选择机器。
          </p>
        </div>
        {props.needsMachine ? (
          <span className="rounded-full border border-app-warning/40 bg-app-warning/10 px-2 py-0.5 text-[11px] text-app-warning">
            尚未选择机器
          </span>
        ) : null}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {ACTIONS.map((action) => (
          <Link
            key={action.to}
            to={action.to}
            className={cn(
              'flex items-center gap-3 rounded-xl border border-app-border bg-app-surface px-4 py-3 transition-colors',
              'hover:border-app-accent/50 hover:bg-app-elevated/50',
            )}
          >
            <span className="rounded-md bg-app-accent/10 p-2 text-app-accent">
              <action.icon className="h-4 w-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-app-text">{action.label}</span>
              <span className="block truncate text-[11px] text-app-muted">
                {action.description}
              </span>
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}
