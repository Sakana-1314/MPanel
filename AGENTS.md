# AGENTS.md

MPanel 是 Go 重写后的服务器管理面板：`web/panel`（React SPA）、`core`（控制面）、`agent`（功能端）三端分离。本文件只写约束与协作方式，不重复实现细节。

## 唯一约定

**禁止未经明确授权修改 AGENTS.md。** 未获得用户明确授权，任何智能体不得增删改本文件。`CLAUDE.md` 只保留一行 `@AGENTS.md`，不复制内容。

## 事实源与接口变更

事实源顺序：**`web/docs/api/contract.md`（随仓库提交）→ 代码**。`notes/` 只放本地草稿与服务器信息，不作为唯一事实源。

- 契约是第一事实源；代码与契约不一致时，按契约修代码，不能把现状当新契约。
- 契约中的 `worker` 在 Go 版对应 `agent`；路径、请求体、响应 `data` 形状、错误码、列表 `{available,reason?,items,total?}` 语义不变。
- **任何接口变更必须同时更新 `web/panel/src/api/types.ts` 与 `web/docs` 文档**，并先改 `web/docs/api/contract.md`。只改 Go 代码或只改前端类型都视为未完成。
- 协议帧以 `web/docs/api/protocol.md` 为准；架构、配置路径与降级策略以 `web/docs/guide/` 与 `README.md` 为准。`notes/` 不提交。

## 目录约定

根目录只允许：

```text
cmd/  core/  agent/  internal/  web/  .github/  notes/
go.mod  go.sum  README.md  LICENSE  AGENTS.md  CLAUDE.md  .gitignore
```

- **禁止新增根级目录或文件**；不要恢复 `server/`、`scripts/`、`deploy/`、`docs/`、根 `package.json`、`tsconfig*`、`pnpm-*` 等旧结构。
- `cmd/`：`mpanel-core`、`mpanel-agent`、`mpanelctl` 三个入口。
- `core/`：认证、机器注册、三种传输、代理、边缘调度、审计、静态托管；不实现站点/Caddyfile/数据库/容器/文件/终端/任务逻辑。
- `agent/`：模块注册、能力探测、命令执行与 `system/` 模块；功能只在 agent 实现。
- `internal/`：配置、协议、存储、鉴权、HTTP 封装、隧道等共享实现；跨 core/agent 的类型只在这里定义。
- `web/panel`、`web/docs` 是两个独立 pnpm 包，各自有 `package.json` 与锁文件，不共享工作区。
- `notes/` 只放本地知识（契约、设计、服务器信息），必须在 `.gitignore` 中忽略，不得提交或复制进其它目录。

## Go 规范

1. HTTP 路由使用标准库 `net/http` + Go 1.22 `ServeMux` 的方法/通配符模式（如 `"GET /api/v1/sites"`）；不引入 gin、chi 等框架。
2. 日志使用 `log/slog`，结构化输出；不要用 `fmt.Println` 记业务日志。
3. 错误使用 `PanelError`（code/message/details），统一信封输出；`UNAVAILABLE` 必须带可执行的 `details.hint`；列表能力缺失返回 `available:false`，写操作返回 503，不能 500。
4. 外部命令一律参数数组（`name, args...`），禁止拼接 shell 字符串；例外只有显式标注为「可信属主」的计划任务命令与终端。
5. 不引入 gin、gorm、sqlite；控制面状态用原子写入的 JSON 文档。允许的依赖保持精简：`gorilla/websocket`、`creack/pty`、`robfig/cron/v3`、`yaml.v3`、`x/crypto`、`lib/pq`、`redis/go-redis/v9`。新增依赖先说明理由。
6. 文件访问必须先 realpath 再校验允许根前缀，拒绝 `..`、符号链接逃逸与 Windows 保留名；写文件用 tmp + rename。
7. 所有 `/ws` 必须凭一次性 ticket 或 token，不接受裸连；密码/session/token 比较使用常量时间实现。
8. PTY 只在 Unix 可用；Windows 降级为管道并标注 `pty=false`，不得因此让 agent 启动失败。
9. 能力探测失败不得阻止进程启动；`capabilities` 只反映当前主机，模块写操作按能力返回 `UNAVAILABLE`。

## 1Panel 风格路径与配置

- 安装根 `/opt/mpanel`，布局固定为 `{conf,data,log,db,backup,tmp}`；配置是 `conf/app.yaml`（core）与 `conf/agent.yaml`（agent），权限 `0600`。
- 二进制名固定：`mpanel-core`、`mpanel-agent`、`mpanelctl`；systemd 单元名固定：`mpanel-core.service`、`mpanel-agent.service`。
- 默认端口：core `10086`、agent `10087`；所有配置可用 `MPANEL_*` 环境变量覆盖，保证容器与 CI 不写 `/opt`。
- 网站管理只用 **Caddy**，不引入 nginx/OpenResty；agent 只写配置、执行 `caddy validate` 与 reload，不守护 Caddy 进程。
- 不要新增与 1Panel 无关的根级安装目录或配置文件名；需要新路径时先改 `web/docs/guide/config.md` 与 `internal/config`。

## 开发与门禁

```bash
go build ./...
go vet ./...
go test ./...

cd web/panel && pnpm install --frozen-lockfile && pnpm build
cd web/docs  && pnpm install --frozen-lockfile && pnpm build
```

- CI 工作流：`校验`（PR 与 main）与 `发布站点`（main / 手动）。工作流 `name` 一律用中文，`runs-on: ubuntu-24.04`，权限最小化。
- 提交前本地至少跑 `go build ./...`、`go vet ./...`、`go test ./...` 与受影响的 pnpm 构建；CI 失败不得合并。
- 文档站由 `web/docs` 构建，发布到 `https://sakana-1314.github.io/MPanel/docs/`；面板发布在站点根。

## 协作与提交

与 `御坂学习`（MisakaStudy）仓库同一口径：

- **作者与提交者统一使用** `Sakana <admin@yangrucheng.top>`，并**用 SSH 私钥签名**：

  ```bash
  git config user.name "Sakana"
  git config user.email "admin@yangrucheng.top"
  git config gpg.format ssh
  git config user.signingkey ~/.ssh/private.key
  git config commit.gpgsign true
  ```

- **必须走 PR**：`gh pr create` → 等 `校验` 全绿（`gh pr checks`）→ `gh pr merge --squash --delete-branch`。禁止本地 merge 后直推 `main`（会把 PR 关成 CLOSED 而非 MERGED）。
- 分支前缀：`feat/`、`fix/`、`refactor/`、`docs/`、`chore/`。
- 提交信息中文，格式 `type(scope): 描述`；一个 PR 只做一件事，契约变更、行为变更、纯文档变更不要混在一起。
- **禁止在代码、工作流、文档中硬编码真实密钥、Token、IP 或内部域名**；工作流一律使用 `${{ secrets.* }}` 或 `GITHUB_TOKEN`。
- 不要新增外部 Runner 仓库或镜像发布流水线；部署产物与运行方式以仓库内文档为准。

## 本地资料

`notes/` 只放本地知识，必须在 `.gitignore` 中忽略；不得提交、不得复制进 `web/`、代码注释或 CI 产物。`notes/` 内的契约与设计变更需要手动同步到 `web/docs` 才能对外。
