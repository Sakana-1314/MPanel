import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { activeConnectionId } from '@/lib/connection-store';
import { ensureSession, sessionSnapshot } from '@/lib/session';

declare module 'vue-router' {
  interface RouteMeta {
    /** 不需要登录。 */
    public?: boolean;
    /** 页面标题（工作台标签、document.title）。 */
    title?: string;
    /** 机器级页面；路由必须带 :machineId。 */
    machine?: boolean;
  }
}

const AppShell = () => import('@/components/AppShell.vue');
const LoginPage = () => import('@/pages/LoginPage.vue');
const NotFoundPage = () => import('@/pages/NotFoundPage.vue');
const DashboardPage = () => import('@/pages/dashboard/DashboardPage.vue');
const MachinesPage = () => import('@/pages/machines/MachinesPage.vue');
const MachineDetailPage = () => import('@/pages/machines/MachineDetailPage.vue');
const EdgePage = () => import('@/pages/edge/EdgePage.vue');
const SettingsPage = () => import('@/pages/settings/SettingsPage.vue');
const SitesPage = () => import('@/pages/sites/SitesPage.vue');
const SiteEditorPage = () => import('@/pages/sites/SiteEditorPage.vue');
const CertsPage = () => import('@/pages/certs/CertsPage.vue');
const DatabasesPage = () => import('@/pages/databases/DatabasesPage.vue');
const ContainersPage = () => import('@/pages/containers/ContainersPage.vue');
const ImagesPage = () => import('@/pages/containers/ImagesPage.vue');
const StacksPage = () => import('@/pages/containers/StacksPage.vue');
const StackDetailPage = () => import('@/pages/containers/StackDetailPage.vue');
const StackEditorPage = () => import('@/pages/containers/StackEditorPage.vue');
const FilesPage = () => import('@/pages/files/FilesPage.vue');
const TerminalPage = () => import('@/pages/terminal/TerminalPage.vue');
const TasksPage = () => import('@/pages/tasks/TasksPage.vue');
const TaskEditorPage = () => import('@/pages/tasks/TaskEditorPage.vue');

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: LoginPage,
    meta: { public: true, title: '登录' },
  },
  {
    path: '/',
    component: AppShell,
    children: [
      {
        path: '',
        name: 'dashboard',
        component: DashboardPage,
        meta: { title: '概览' },
      },
      {
        path: 'machines',
        name: 'machines',
        component: MachinesPage,
        meta: { title: '机器' },
      },
      {
        path: 'machines/:machineId',
        name: 'machine-detail',
        component: MachineDetailPage,
        meta: { title: '机器详情' },
      },
      {
        path: 'edge',
        name: 'edge',
        component: EdgePage,
        meta: { title: '边缘节点' },
      },
      {
        path: 'settings',
        name: 'settings',
        component: SettingsPage,
        meta: { title: '设置' },
      },
      {
        path: 'm/:machineId',
        redirect: (to) => `/m/${String(to.params.machineId)}/sites`,
      },
      {
        path: 'm/:machineId/sites',
        name: 'sites',
        component: SitesPage,
        meta: { title: '站点', machine: true },
      },
      {
        path: 'm/:machineId/sites/new',
        name: 'site-new',
        component: SiteEditorPage,
        meta: { title: '新建站点', machine: true },
      },
      {
        path: 'm/:machineId/sites/:siteId',
        name: 'site-edit',
        component: SiteEditorPage,
        meta: { title: '编辑站点', machine: true },
      },
      {
        path: 'm/:machineId/certs',
        name: 'certs',
        component: CertsPage,
        meta: { title: '证书', machine: true },
      },
      {
        path: 'm/:machineId/databases',
        name: 'databases',
        component: DatabasesPage,
        meta: { title: '数据库', machine: true },
      },
      {
        path: 'm/:machineId/containers',
        name: 'containers',
        component: ContainersPage,
        meta: { title: '容器', machine: true },
      },
      {
        path: 'm/:machineId/containers/:containerId',
        name: 'container-detail',
        component: ContainersPage,
        meta: { title: '容器', machine: true },
      },
      {
        path: 'm/:machineId/images',
        name: 'images',
        component: ImagesPage,
        meta: { title: '镜像', machine: true },
      },
      {
        path: 'm/:machineId/stacks',
        name: 'stacks',
        component: StacksPage,
        meta: { title: 'Compose 栈', machine: true },
      },
      {
        path: 'm/:machineId/stacks/:stackName',
        name: 'stack-detail',
        component: StackDetailPage,
        meta: { title: '栈详情', machine: true },
      },
      {
        path: 'm/:machineId/stacks/:stackName/edit',
        name: 'stack-edit',
        component: StackEditorPage,
        meta: { title: '编辑栈', machine: true },
      },
      {
        path: 'm/:machineId/files',
        name: 'files',
        component: FilesPage,
        meta: { title: '文件', machine: true },
      },
      {
        path: 'm/:machineId/terminal',
        name: 'terminal',
        component: TerminalPage,
        meta: { title: '终端', machine: true },
      },
      {
        path: 'm/:machineId/tasks',
        name: 'tasks',
        component: TasksPage,
        meta: { title: '计划任务', machine: true },
      },
      {
        path: 'm/:machineId/tasks/new',
        name: 'task-new',
        component: TaskEditorPage,
        meta: { title: '新建任务', machine: true },
      },
      {
        path: 'm/:machineId/tasks/:taskId',
        name: 'task-edit',
        component: TaskEditorPage,
        meta: { title: '编辑任务', machine: true },
      },
    ],
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: NotFoundPage,
    meta: { public: true, title: '页面不存在' },
  },
];

const base = import.meta.env.BASE_URL.replace(/\/+$/, '') || '/';

export const router = createRouter({
  history: createWebHistory(base),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});

router.beforeEach(async (to) => {
  if (to.meta.public === true) {
    if (to.name === 'login' && activeConnectionId.value !== null) {
      await ensureSession();
      if (sessionSnapshot().status === 'authenticated') {
        const redirect = typeof to.query.redirect === 'string' ? to.query.redirect : '/';
        return redirect.startsWith('/login') ? { path: '/' } : { path: redirect };
      }
    }
    return true;
  }

  if (activeConnectionId.value === null) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }

  await ensureSession();
  if (sessionSnapshot().status !== 'authenticated') {
    return { name: 'login', query: { redirect: to.fullPath } };
  }
  return true;
});

router.afterEach((to) => {
  const pageTitle = typeof to.meta.title === 'string' ? to.meta.title : 'MPanel';
  document.title = `${pageTitle} · MPanel`;
});
