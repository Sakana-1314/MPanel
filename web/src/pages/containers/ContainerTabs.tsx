import { NavLink } from 'react-router-dom';
import { Boxes, Container, Layers } from 'lucide-react';
import { cn } from '../../lib/cn';

const TABS = [
  { to: '/containers', label: '容器', icon: Container },
  { to: '/images', label: '镜像', icon: Boxes },
  { to: '/stacks', label: '编排', icon: Layers },
] as const;

/** 容器/镜像/编排三个页面共用的顶层导航。 */
export function ContainerTabs(): JSX.Element {
  return (
    <nav
      aria-label="容器功能导航"
      className="mb-4 inline-flex flex-wrap items-center gap-1 rounded-lg border border-app-border bg-app-surface p-1"
    >
      {TABS.map((tab) => {
        const Icon = tab.icon;
        return (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) =>
              cn(
                'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-app-elevated text-app-text shadow-sm'
                  : 'text-app-muted hover:bg-app-elevated/60 hover:text-app-text',
              )
            }
          >
            <Icon className="h-4 w-4" />
            {tab.label}
          </NavLink>
        );
      })}
    </nav>
  );
}
