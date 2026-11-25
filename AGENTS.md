# AGENTS.md

MPanel 服务器管理面板。事实标准以代码与 `docs/` 内文档为准，本文件只写约束与协作方式，不重复实现细节。

## 唯一约定

**禁止未经明确授权修改 AGENTS.md。** 未获得用户明确授权，任何智能体不得增删改本文件。

## 事实源

- 接口契约：`docs/api-contract.md`（新增/修改端点必须先改这里，再改代码与 `web/src/api/types.ts`）
- 架构与降级策略：`docs/architecture.md`
- core↔worker 隧道帧协议：`docs/protocol.md`
- 文件归属与模块边界：`docs/file-layout.md`

## 目录

- `web/` — 前端（Vite + React + TypeScript），可独立部署
- `server/core/` — 多机管理中框（只做注册、代理、认证、聚合），可独立部署
- `server/worker/` — 功能承载端（六模块 + 三种传输），可独立部署
- `server/shared/` — core 与 worker 构建期共享的协议、类型与 zod 校验（不改变三端独立部署）
- `scripts/` — `check.mjs`（类型检查 + web 构建门禁）、`smoke.mjs`（真实进程端到端）
- `deploy/` — Dockerfile、compose、systemd、反代示例
- `.github/workflows/` — CI（校验 + 镜像构建）

根目录除构建必需文件（`package.json`、`pnpm-workspace.yaml`、`pnpm-lock.yaml`、`tsconfig*.json`、`.gitignore`、`.env.example`）外，只放 `AGENTS.md`、`CLAUDE.md`、`LICENSE`、`README.md`。文档放 `docs/`，脚本放 `scripts/`，不要往根目录堆。

## 硬约束

1. **功能只在 worker 实现。** core 不得直接执行 caddy/docker/文件操作；它只做机器注册、隧道代理、认证与聚合。
2. **同一套 REST v1 由 worker 与 core 共同提供。** worker 挂 `/api/v1/*`；core 另提供 `/api/v1/machines*` 与 `/api/v1/machines/:machineId/proxy/*`。前端只切换 basePath 即可直连或经 core。
3. **三种传输（stdio / http / reverse-ws）共用同一套请求处理器与隧道帧协议**（`docs/protocol.md`）。不要为某一种传输单开业务分支。
4. **外部命令一律经 `CommandRunner` + 参数数组**（`execFile`/`spawn`），禁止拼接 shell 字符串。用户可控文本进入 Caddyfile 必须校验/转义。
5. **能力缺失返回 `UNAVAILABLE` + `details.hint`**，列表响应统一 `{ available, reason?, items }`，不得 500，不得抛未捕获异常。
6. **文件访问必须 realpath 后做允许根前缀校验**，拒绝 `..`、符号链接逃逸、Windows 保留名。
7. **所有 `/ws` 连接必须凭一次性 ticket 或 token**，不得裸连。
8. **不要引入原生编译依赖**（不用 better-sqlite3 / node-gyp）；存储用 `node:sqlite` 或原子写入 JSON（tmp + fsync + rename）。
9. **不要在代码、工作流、文档中硬编码 IP、密钥、内部域名**；工作流一律 `${{ secrets.* }}`。
10. **未经授权不要改 `AGENTS.md` 以外的协作文件，不要 git init/提交/推送之外的历史改写。**

## 开发与门禁

```bash
pnpm install
pnpm dev                 # shared 构建 + worker/core/web 并行 dev
pnpm typecheck           # 全仓类型检查
pnpm build               # server 构建 + web 生产构建
node scripts/check.mjs   # 唯一类型/构建门禁：CHECK: PASS / CHECK: FAIL
node scripts/smoke.mjs   # 真实进程端到端：SMOKE: PASS <n> checks
```

- Windows 上不能直接 spawn `pnpm`/`npm`（`.cmd` 会被 ENOENT），脚本内统一用 `node <js>` 调用；人工执行用 Bash。
- 门禁脚本必须真实可失败：`check.mjs` 与 `smoke.mjs` 的断言不得静默跳过。

## 协作与提交

与 `御坂学习`（MisakaStudy）仓库同一口径：

- **作者与提交者统一使用当前 GitHub 账号的名称与邮箱**（`Sakana <admin@yangrucheng.top>`），并**用 SSH 私钥签名**：

  ```bash
  git config user.name "Sakana"
  git config user.email "admin@yangrucheng.top"
  git config gpg.format ssh
  git config user.signingkey ~/.ssh/private.key
  git config commit.gpgsign true
  ```

- **必须走 PR**：`gh pr create` → 等 CI（`校验` 作业）→ `gh pr checks` 全绿后 `gh pr merge --squash --delete-branch`。禁止本地 `merge` 后直推 `main`（会把 PR 关成 CLOSED 而非 MERGED）。
- 分支前缀 `feat/`、`fix/`、`refactor/`、`docs/`、`chore/`。
- 提交信息中文，格式 `type(scope): 描述`；squash 合并后标题带 PR 号。
- 工作流 `name` 用中文（专有名词除外）。
- 一个 PR 只做一件事；契约变更、行为变更、纯文档变更不要混在一起。

## CI 与镜像

- `.github/workflows/` 内工作流在**本仓库**执行（MPanel 不使用外部 Runner 仓库）。
- PR：只跑 `校验`（`node scripts/check.mjs` + `node scripts/smoke.mjs`），不推镜像。
- push `main`、打 `v*` tag、手动 `workflow_dispatch`：构建并推送三个镜像到 GHCR，使用**固定 tag**：
  - `ghcr.io/sakana-1314/mpanel-web:latest` / `:v<version>`
  - `ghcr.io/sakana-1314/mpanel-core:latest` / `:v<version>`
  - `ghcr.io/sakana-1314/mpanel-worker:latest` / `:v<version>`
- 版本号来自根 `package.json` 的 `version`；不要在工作流里另立版本来源。

## 本地资料

`notes/` 只放本地资料（机密、测试服务器信息），必须在 `.gitignore` 中忽略，不得提交、不得复制进其它目录。
