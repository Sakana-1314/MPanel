# MPanel Web

MPanel 的 React + Vite 前端：多后端连接（worker 直连 / core 多机代理）、站点与证书管理，
以及 shell、共享组件和 API 客户端。

## 技术栈

- React 18 + TypeScript strict（ESM，`jsx: react-jsx`）
- Vite 6、Tailwind CSS 3（深色优先的双主题，CSS 变量驱动）
- TanStack Query 5、Zustand 5、React Router 6
- CodeMirror（`@uiw/react-codemirror` + json/sql 语言包）

## 命令

```bash
# 类型检查（仓库根目录）
node node_modules/typescript/bin/tsc -p web --noEmit

# 生产构建（在 web/ 目录）
node node_modules/vite/bin/vite.js build

# 开发服务器（在 web/ 目录）
node node_modules/vite/bin/vite.js --port 5173
```

## 默认后端与运行时配置

连接种子来源按优先级合并（`lib/runtime-config.ts`）：

1. **运行时 `config.json`**（`GET ${BASE_URL}config.json`，`cache: 'no-store'`，404/网络失败静默忽略）
2. **`VITE_DEFAULT_BACKENDS`**：JSON 数组，优先于单个默认后端
3. **`VITE_DEFAULT_BACKEND`** + `VITE_DEFAULT_BACKEND_NAME` / `VITE_DEFAULT_BACKEND_TOKEN` / `VITE_DEFAULT_BACKEND_KIND`

`config.json` 与编译期种子按 **id 合并**：同 id 覆盖（config.json 优先），其余追加；
config.json 是公开静态文件，**不得**包含 token/密码/secret。`config.json.dbxUrl` 会覆盖
`VITE_DBX_URL`。示例：

```json
{
  "appName": "MPanel",
  "dbxUrl": "https://dbx.example.com",
  "allowUserConnections": true,
  "backends": [
    { "id": "prod-core", "name": "生产 core", "kind": "core", "baseUrl": "https://panel.example.com" },
    { "id": "dev-worker", "name": "本地 worker", "kind": "worker", "baseUrl": "http://127.0.0.1:8787" }
  ]
}
```

启动顺序（`main.tsx`）：`loadRuntimeConfig()` → `bootstrapConnections()` → `createRoot().render(<App />)`。
已存在的连接不会被覆盖，env token 只在本地没有 token 时写入。

## 连接与安全

- 连接元数据保存在 `localStorage: mpanel.connections.v1`，**不含 token**。
- worker token 默认存 `sessionStorage: mpanel.secrets.session.v1`；勾选“记住 token”后才写
  `localStorage: mpanel.secrets.local.v1`（UI 会提示 XSS 风险）。
- core 使用 HttpOnly cookie 会话，前端不保存密码；登录态按 connection id 记录在内存 store。
- 切换连接或机器会清空 Query 缓存、关闭所有 WebSocket，并把机器选择按连接隔离
  （`selectedMachineByConnection`）。
- basePath 规则（`lib/connection-store.ts`）：
  - worker：`<url>/api/v1`
  - core 已选机器：`<url>/api/v1/machines/<id>/proxy`
  - core 未选机器：特性页只显示“选择机器”，不发 `/proxy` 请求（`app/MachineGate.tsx`）
- 认证端点（`/auth/*`）、机器管理（`/machines*`）、`/system/overview` 固定走连接根
  `/api/v1`，不经过机器代理。

## 目录（本轨道负责）

```
web/src/
├─ main.tsx / routes.tsx         入口与路由（页面懒加载：优先 <area>/index.tsx，回退 *Page.tsx）
├─ app/                          AppShell、Providers、Theme、ErrorBoundary、各 Gate
├─ api/
│  ├─ types.ts                   docs/api-contract.md §15 的手写镜像（禁止 import shared）
│  ├─ errors.ts                  AppError（code/message/hint/details）
│  ├─ transport.ts               ApiTransport 接口
│  ├─ client.ts                  createClient / getClient / apiRequest / probeConnection
│  ├─ ws.ts                      wsPathFor / connectWs（ticket）
│  └─ auth|system|machines|sites|certs|databases|containers|files|terminal|tasks.ts
│                                资源工厂 + 具名函数 + 带连接作用域的 query keys
├─ lib/                          连接 store、secrets、runtime config、query keys、mutations 等
├─ components/
│  ├─ ui/                        共享 UI（index.ts 统一导出）
│  ├─ layout/                    Sidebar / TopBar / ConnectionSwitcher / MachineSwitcher
│  ├─ ConnectionDialog.tsx       新增/编辑/测试连接
│  ├─ ConnectionManager.tsx      连接管理抽屉（测试、重命名、设为默认、删除）
│  └─ CommandPalette.tsx         Ctrl/⌘+K 命令面板
├─ pages/sites/                  站点列表、表单、编辑、预览、导入导出
├─ pages/certs/                  证书列表与详情
├─ pages/LoginPage.tsx / NotFoundPage.tsx
└─ pages/settings/               连接摘要、关于、修改密码
```

其他 `pages/<feature>/` 由各自轨道实现；`routes.tsx` 通过 `import.meta.glob` 自动解析，
只要目录下存在 `index.tsx`（或保留的 `*Page.tsx`）即可，无需改路由。

## API 客户端

```ts
import { createClient, getClient } from './api/client';

// 绑定具体后端（测试/探测/后台任务）
const client = createClient({ baseUrl: 'https://panel.example.com/api/v1', kind: 'core', token });
await client.sites.list({ limit: 50 });

// 当前连接 + 机器（页面默认使用）
const api = getClient();
await api.sites.apply({ siteIds: ['st_1'] });
```

- 所有响应统一解包 `{ ok, data }`；失败映射为 `AppError`（含契约错误码、HTTP 状态、
  `details`，`hint` 优先取 `details.hint`，否则按错误码给默认可执行提示）。
- Query key 规范：`[connectionId, machineId, resource, action, ...params]`
  （`lib/query-keys.ts`），切换连接/机器由 `queryClient.clear()` 隔离缓存。
- mutations 使用 `useAppMutation`（`lib/mutations.ts`）：成功 toast + 统一 invalidate，
  失败 toast 含 `UNAVAILABLE` 的 hint。

## 主题

`styles/index.css` 定义 `--app-*` RGB 变量；`html.dark`（默认）/`html.light` 切换。
Tailwind 语义色：`app-bg`、`app-surface`、`app-elevated`、`app-border`、`app-text`、
`app-muted`、`app-accent`、`app-success`、`app-warning`、`app-danger`、`app-info`。
旧页面使用的 `panel-*` 也映射到同一组变量。

## 已知限制 / 契约偏差

- **基础认证未实现**：`api-contract.md` §6.1 的 `SiteConfig` 没有 basicauth 字段，
  Caddyfile 生成器也无对应指令；表单中明确提示而不静默丢弃。
- **站点导入不支持原始 Caddyfile**：契约规定 Caddyfile 由结构化配置单向生成；
  “导入/导出”提供 `SiteExportBundle` JSON。
- 证书只读：不提供手动续期/删除；签发与续期由 Caddy 负责。
