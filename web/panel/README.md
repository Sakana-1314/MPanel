# MPanel Web

MPanel 面板：Vue 3 + Vite + Vue Router + Naive UI 静态 SPA。

- **只连接 core**：浏览器不保存 agent token / machine secret，也不直连 agent；所有机器请求经
  `/api/v1/machines/:machineId/proxy` 转发。
- **多机工作台**：每个标签页独立绑定 `machineId + 路由`，可以同时混合打开多台机器的不同页面；
  切换机器不会替换其它标签，也没有 1Panel 式的全局“当前机器”开关。
- **core 级页面**（概览、机器、边缘节点、设置）与机器级页面（站点、证书、数据库、容器、镜像、
  Compose 栈、文件、终端、计划任务）共用同一套外壳。

## 命令

```bash
pnpm install
pnpm dev        # 开发服务器，默认 5173
pnpm typecheck  # vue-tsc --noEmit
pnpm build      # vue-tsc + vite build
```

`pnpm install --frozen-lockfile` 与 `pnpm build` 是 CI 门禁使用的命令。

## 目录

```text
web/panel/src/
├─ main.ts / App.vue             入口、Naive UI Provider 与主题
├─ router/index.ts               路由与登录守卫；机器级路由形如 /m/:machineId/sites
├─ api/                          契约镜像与 API 客户端
│  ├─ types.ts                   web/docs/api/contract.md 的类型镜像
│  ├─ client.ts                  createClient / getCoreClient / getMachineClient
│  ├─ ws.ts                      一次性 ticket + core 代理 WS
│  └─ auth|system|machines|...   资源工厂
├─ lib/
│  ├─ connection-store.ts        core 连接（只持久化元数据）
│  ├─ session.ts                 cookie 会话、登录/登出
│  ├─ workspace.ts               多机标签页状态与持久化
│  ├─ navigation.ts              打开机器页面 / core 页面
│  ├─ api.ts                     useCoreApi / useMachineApi
│  ├─ cron.ts                    cron 校验与本地未来运行预览
│  └─ theme.ts / format.ts / status.ts
├─ components/
│  ├─ AppShell.vue               NLayout 外壳 + KeepAlive 页面缓存
│  ├─ AppSidebar.vue             分组导航 + 机器列表 + 左下角账户/主题
│  ├─ WorkspaceTabs.vue          顶栏标签页（无 navbar；移动端菜单入口）
│  ├─ QuickOpen.vue              Ctrl+K 打开任意机器的页面
│  ├─ MachineContextBar.vue      当前标签机器的状态/能力/新开页面
│  └─ common/                    PageHeader、CodeEditor、Xterm、StatusTag…
└─ pages/
   ├─ LoginPage.vue              core 登录与连接管理
   ├─ dashboard/                 多机总览
   ├─ machines/                  机器 CRUD、健康、入网信息
   ├─ edge/                      入网密钥、节点、离线作业
   ├─ sites/                     站点列表/表单/预览/导入导出/应用
   ├─ certs/                     只读证书
   ├─ databases/                 档案、统计、备份、dbx
   ├─ containers/                容器/镜像/Compose 栈
   ├─ files/                     文件浏览、编辑、上传、回收站
   ├─ terminal/                  经 core 的终端会话
   └─ tasks/                     Cron 任务与运行历史
```

## 连接与安全

- 连接元数据存 `localStorage: mpanel.core-connections.v1`，不含 token。
- core 使用 HttpOnly cookie 会话；登录态只保存在内存。
- 可选 core Bearer token 仅来自编译期 `VITE_DEFAULT_BACKEND_TOKEN`，只存在内存。
- `config.json` 是公开文件，禁止放密码/token；旧 `kind=worker` 条目会被忽略。
- 切换 core 连接会清空 Query 缓存、关闭所有 WebSocket 并重置工作台。
- WebSocket 先 `POST /auth/ws-ticket`（path 为 contract 规定的
  `/api/v1/machines/<id>/proxy/ws/...`），再连 core 代理；浏览器不接触 agent 地址。

## 运行时配置

启动顺序：`loadRuntimeConfig()` → `bootstrapConnections()` → `restoreWorkspace()` → 挂载应用。

`config.json`（`GET ${BASE_URL}config.json`，`cache: no-store`，404 不致命）示例：

```json
{
  "appName": "MPanel",
  "dbxUrl": "https://dbx.example.com",
  "allowUserConnections": true,
  "backends": [
    { "id": "prod-core", "name": "生产 core", "baseUrl": "https://panel.example.com" }
  ]
}
```

## 已知限制

- 站点基础认证未纳入 `SiteConfig` 契约，表单明确提示而不静默丢弃。
- 站点导入只接受 `SiteExportBundle` JSON，不支持原始 Caddyfile。
- 证书只读；签发与续期由 Caddy 负责。
- 受契约限制，容器日志页使用 REST 拉取并定时刷新；实时 follow 仍可通过 agent WS 在后续版本接入。
