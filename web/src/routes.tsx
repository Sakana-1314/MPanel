import { lazy } from 'react';
import type { ComponentType, LazyExoticComponent, ReactNode } from 'react';
import type { RouteObject } from 'react-router-dom';
import { AppShell } from './app/AppShell';
import { useActiveConnection } from './lib/connection-store';
import { Alert } from './components/ui/Alert';
import LoginPage from './pages/LoginPage';
import NotFoundPage from './pages/NotFoundPage';

type PageModule = { default: ComponentType };

/**
 * 页面按目录懒加载，优先 `<area>/index.tsx`，回退到脚手架命名文件。
 * 其他前端轨道只需在对应目录提供 index.tsx（或保留 *Page.tsx），路由无需改动。
 */
const pageModules = import.meta.glob<PageModule>('./pages/**/*.tsx');

function MissingPage(props: { modulePath: string }): JSX.Element {
  return (
    <div className="py-10">
      <Alert tone="warning" title="页面尚未实现">
        未找到页面模块 <code className="font-mono">{props.modulePath}</code>。
        请确认对应前端轨道已创建 index.tsx 或 *Page.tsx。
      </Alert>
    </div>
  );
}

function lazyPage(area: string, fileName: string): LazyExoticComponent<ComponentType> {
  const base = `./pages/${area}`;
  const candidates = [`${base}/index.tsx`, `${base}/${fileName}.tsx`];
  for (const key of candidates) {
    const loader = pageModules[key];
    if (loader !== undefined) {
      return lazy(async () => {
        const module = await loader();
        return { default: module.default };
      });
    }
  }
  return lazy(async () => ({
    default: function Missing(): JSX.Element {
      return <MissingPage modulePath={candidates[candidates.length - 1] ?? base} />;
    },
  }));
}

const DashboardPage = lazyPage('dashboard', 'DashboardPage');
const EdgePage = lazyPage('edge', 'EdgePage');
const MachinesPage = lazyPage('machines', 'MachinesPage');
const MachineDetailPage = lazyPage('machines', 'MachineDetailPage');
const SitesPage = lazyPage('sites', 'SitesPage');
const SiteEditorPage = lazyPage('sites', 'SiteEditorPage');
const CertsPage = lazyPage('certs', 'CertsPage');
const DatabasesPage = lazyPage('db', 'DatabasesPage');
const ContainersPage = lazyPage('containers', 'ContainersPage');
const ImagesPage = lazyPage('containers', 'ImagesPage');
const StacksPage = lazyPage('containers', 'StacksPage');
const StackDetailPage = lazyPage('containers', 'StackDetailPage');
const StackEditorPage = lazyPage('containers', 'StackEditorPage');
const FilesPage = lazyPage('files', 'FilesPage');
const TerminalPage = lazyPage('terminal', 'TerminalPage');
const TasksPage = lazyPage('tasks', 'TasksPage');
const TaskEditorPage = lazyPage('tasks', 'TaskEditorPage');
const SettingsPage = lazyPage('settings', 'SettingsPage');

/** core 专属页面（机器管理）；worker 连接下显示提示而不是 404。 */
function CoreOnly(props: { children: ReactNode }): JSX.Element {
  const connection = useActiveConnection();
  if (connection !== undefined && connection.kind !== 'core') {
    return (
      <Alert tone="info" title="仅 core 支持">
        机器管理只在 core 连接下可用；当前是 worker 直连。请在侧边栏切换到 core 连接。
      </Alert>
    );
  }
  return <>{props.children}</>;
}

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <DashboardPage /> },
      {
        path: 'machines',
        element: (
          <CoreOnly>
            <MachinesPage />
          </CoreOnly>
        ),
      },
      {
        path: 'machines/:id',
        element: (
          <CoreOnly>
            <MachineDetailPage />
          </CoreOnly>
        ),
      },
      {
        path: 'edge',
        element: (
          <CoreOnly>
            <EdgePage />
          </CoreOnly>
        ),
      },
      { path: 'sites', element: <SitesPage /> },
      { path: 'sites/new', element: <SiteEditorPage /> },
      { path: 'sites/:id', element: <SiteEditorPage /> },
      { path: 'certs', element: <CertsPage /> },
      { path: 'databases', element: <DatabasesPage /> },
      { path: 'containers', element: <ContainersPage /> },
      { path: 'containers/:id', element: <ContainersPage /> },
      { path: 'images', element: <ImagesPage /> },
      { path: 'stacks', element: <StacksPage /> },
      { path: 'stacks/:name', element: <StackDetailPage /> },
      { path: 'stacks/:name/edit', element: <StackEditorPage /> },
      { path: 'files', element: <FilesPage /> },
      { path: 'terminal', element: <TerminalPage /> },
      { path: 'tasks', element: <TasksPage /> },
      { path: 'tasks/new', element: <TaskEditorPage /> },
      { path: 'tasks/:id', element: <TaskEditorPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
  { path: '/login', element: <LoginPage /> },
  { path: '*', element: <NotFoundPage /> },
];
