# MPanel 架构设计

状态：v1 契约冻结（2026-11-25）。本文件与 `docs/api-contract.md`、`docs/protocol.md`、`docs/file-layout.md`、`server/shared/src/*` 共同构成实现契约。

**文档优先级（冲突裁决）**：`docs/api-contract.md` > `docs/protocol.md` > `docs/file-layout.md` > `docs/architecture.md`；`server/shared/src` 实现 API/protocol 类型。低优先级文档与高优先级冲突时，低优先级必须让位并修正。13 条并行实现轨道按 `docs/file-layout.md` 的文件所有权逐字执行；任何偏离先改契约再改代码。

## 1. 目标与非目标

### 1.1 目标

- **三端可独立部署**：`web/`（静态前端）、`server/core/`（多机管理中框）、`server/worker/`（真正执行功能的代理）。core 不实现任何站点、证书、数据库、容器、文件、终端、计划任务逻辑。
- **两种使用形态**：前端可直连单个 worker（单机面板），也可连 core 管理多台 worker（多机面板），同一套 REST/WS 契约、只切换 `basePath`。
- **依赖可缺失**：本机可能没有 Docker、Caddy、PostgreSQL、Redis 或 `node-pty`。worker 启动不因外部依赖缺失而失败；能力探测结果进入 `capabilities`，资源列表返回 `available=false`，写操作返回 `UNAVAILABLE` 且带可执行提示。
- **安全的默认值**：无认证不暴露管理 API；文件路径沙箱；命令参数数组化；Caddyfile 只从结构化配置生成；所有密钥可轮换。
- **可并行实现**：文件所有权、导出签名、错误码和协议帧在写代码前冻结，13 条轨道不互相改文件。

### 1.2 非目标（v1）

- 多租户、细粒度 RBAC、审计合规认证。v1 的已认证用户等同“可信属主”。
- 内置 SQL/Redis 查询器。查询界面是外部 dbx 的 iframe，地址由 `VITE_DBX_URL` 提供；worker 只发一次性 handoff 票据。
- 管理 Caddy/Docker/PostgreSQL/Redis 进程本身（安装、启停、升级）。worker 调用已安装的二进制/服务。
- core 高可用、多副本共享状态。core 是单进程、单写者。
- 任意 Caddyfile 原文导入、任意 Caddy 指令注入。
- Windows 服务封装、容器化部署的强制形态；`deploy/` 提供示例，实际以宿主机进程为主。

## 1.3 硬性决定的落地索引

| 决定 | 落地位置 | 偏离/说明 |
|---|---|---|
| A 统一隧道协议（8 种帧，stdio/reverse-ws 共用；http 直连） | `docs/protocol.md`、`server/shared/src/protocol.ts`、§4 | 隧道模式下 worker 另开 loopback 端口复用同一 Fastify 处理器；未把 `inject` 作为主路径（§4.3） |
| B 同一套 REST v1；core 机器/代理/system/auth | `docs/api-contract.md` §4–§6、§8–§12 | 代理额外支持 WS（`/proxy/ws/*`），因为终端/日志必须走 WS；仍是 `/proxy/*` 命名空间 |
| C worker token / core scrypt+cookie+ticket / Bearer；WS 不得裸连 | §6.1、API §2–§3 | `/ws/worker` 是机器注册通道，用 machine secret Bearer，不是用户 ticket；已显式标注 |
| D capabilities + 统一列表 + UNAVAILABLE+hint | §5、API §2.3、`capabilities.ts` | 站点/档案草稿在能力缺失时仍可读写；Caddy/Docker 等动作按能力拒绝（§5.1） |
| E 文件路径 realpath 前缀、拒绝 `..`/符号链接逃逸 | §6.3、worker `paths.ts` | 终端 cwd 是可信属主功能，不套文件沙箱；已在 §6.4 标注 |
| F 命令 argv 数组、Caddyfile 校验/转义、任务 shell 标注 | §6.4–§6.5、worker `exec.ts`、sites `caddyfile.ts` | 任务命令、PTY、Compose、docker exec、stdio 启动命令是显式可信属主例外 |
| G 不引入原生依赖：原子 JSON（非 node:sqlite） | §7 | 理由：数据量小、单写者、并行模块解耦、可恢复；lock 分角色 |

## 2. 三端职责

| 端 | 职责 | 明确不做 |
|---|---|---|
| `web/` | React SPA；多后端连接管理；core 登录；直连 worker token；站点/证书/数据库档案/容器/文件/终端/任务 UI；运行时 `/config.json`；iframe 嵌入 dbx | 不实现业务规则；不直接访问宿主文件/命令；不 import `@mpanel/shared` |
| `server/core/` | 用户名密码认证（scrypt）+ session cookie；一次性 WS ticket；机器注册/凭据保管/健康；反向代理 REST 与 WS 到 worker；`/system/overview` 聚合；静态托管 `web/dist`（可选） | 不实现站点/Caddyfile、不碰数据库、不执行容器/文件/终端/任务逻辑 |
| `server/worker/` | 认证（静态 token）；能力探测；七类功能模块；Caddy 校验/原子替换/回滚；证书 X509 读取；数据库档案/健康/统计/备份恢复/handoff；Docker/Compose；文件沙箱；PTY；cron；三种传输适配 | 不管理机器注册；不做多机聚合；不托管前端（由 Caddy/core/其他静态服务器托管） |

### 2.1 `server/shared/` 的决定

`server/shared/` 是 core 与 worker 的**构建期依赖**（协议帧、错误码、模型、zod 校验器、CommandRunner/Module/WsBridge 接口）。它不包含运行时业务实现，也不被 `web/` 引用（web 独立部署，手写契约镜像 `web/src/api/types.ts`）。三端仍可独立发布：worker/core 的发布物由 `pnpm deploy` 生成（dist + 生产 node_modules，含 @mpanel/shared 与 zod）；不允许只复制 dist 启动。web 只依赖 `docs/api-contract.md`。新增 shared 文件的唯一理由是 core 与 worker 必须逐字节一致，否则复制会漂移。

## 3. 部署拓扑

### 3.1 单机直连（worker + 静态前端）

```
Browser ──HTTPS──> Caddy/nginx ──/──> web/dist
                         └──/api, /ws──> worker 127.0.0.1:8787
```

- worker 以 `MPANEL_TRANSPORT=http` 启动，默认只绑 `127.0.0.1`；由同机 Caddy 终结 TLS 并反代 `/api/v1` 与 `/ws`。
- 前端连接配置：`{ kind: "worker", url: "https://panel.example.com" }`，用户在连接页输入 `MPANEL_TOKEN`。
- 没有 core。`/system/overview`、`/machines*` 在该部署下返回 404。

### 3.2 core + 多机

```
Browser ──HTTPS──> core 127.0.0.1:8790 ──http────────> worker A (公网/内网端口)
   (cookie)              │
                         ├──stdio (spawn)───────────> worker B 子进程
                         └──reverse-ws (worker 拨号) <── worker C
```

- core 托管 `web/dist` 或由独立静态服务器托管；浏览器只与 core 同源通信，不接触 worker token。
- 三种传输可同时存在于一个 core：
  - **http**：worker 暴露端口，core 反向代理并注入 worker token。适合已有内网、容器场景。
  - **stdio**：core 拉起 worker 子进程，NDJSON 帧走 stdin/stdout，stderr 作为日志。适合同机强隔离、worker 完全不监听公网。要求 `MPANEL_ALLOW_STDIO=1`（旧名 `MPANEL_CORE_ALLOW_STDIO` 只作为启动告警 alias）。
  - **reverse-ws**：worker 主动连接 core 的 `/ws/worker`，适合 worker 在 NAT/防火墙后。core 不主动连 worker。注册 secret 与 worker 自身 loopback 的 `MPANEL_TOKEN` 是两个独立凭据，均只在创建/轮换时下发一次。
- core 的机器列表、健康、代理 API 均以机器 id 为作用域；前端选中机器后把特性页 basePath 切到 `/api/v1/machines/<id>/proxy`。

### 3.3 混合

- 同一 worker（http 模式）既可被 core 以 http 注册，也可被运维通过其直连地址访问。前端可保存两个连接（一个 core、一个 worker），数据相同但权限边界不同。
- 混合模式的代价：worker token 出现在两个地方；建议只给 core 配置长期 token，直连连接使用独立轮换 token（worker 目前只支持一个静态 token，轮换会使旧连接失效；见 §10 限制）。
- reverse-ws/stdio 的 worker 不暴露公网 HTTP；其内部 loopback 端口不可被外部访问，不能直连。

### 3.4 边缘节点（Portainer Edge 的最小实现）

边缘节点不是第四种传输，而是 reverse-ws 的一种**入网方式**：

1. 运维在 core 创建**入网密钥**（可限次数、有效期、分组）。
2. 目标机上的 worker 以 `MPANEL_TRANSPORT=reverse-ws` + `MPANEL_CORE_URL` + `MPANEL_EDGE_KEY` 启动；
   它先 `POST /api/v1/edge/enroll` 换取 `{machine, secret, wsUrl}`，把身份写到
   `MPANEL_HOME/edge.json`（0600），然后用既有 secret 机制拨 `/ws/worker`。
3. 入网成功后它就是一台普通 reverse-ws 机器（`edge=true`），代理、WS、终端全部复用既有路径，
   **不新增任何隧道帧**。
4. core 负责三件增量：定期取节点快照（`GET /system/snapshot`）、把 offline 期间排队的
   异步作业在重连后串行补跑、按 `group` 聚合与筛选。

这样做的取舍：边缘能力全部落在 core 的调度循环里，worker 不需要知道「作业」概念；
代价是作业的可靠性以 core 的本地 JSON 存储为准，core 单点仍然是单点。

### 3.5 端口与路径约定

| 项 | 默认 |
|---|---|
| worker HTTP | `127.0.0.1:8787`（`MPANEL_HOST`/`MPANEL_PORT`，`port=0` 时打印实际端口） |
| core HTTP | `127.0.0.1:8790` |
| web dev | `5173` |
| worker API | `/api/v1/*`，WS `/ws/*` |
| core API | `/api/v1/*`，WS `/ws/worker`、代理 WS `/api/v1/machines/:id/proxy/ws/*` |
| 健康检查 | 两端 `GET /healthz`（无需认证，仅返回进程存活） |
| core 静态站点 | `MPANEL_WEB_DIR`（默认 `web/dist`），SPA fallback 不吞 `/api`/`/ws` |

## 4. 传输层设计

### 4.1 三种传输

| 传输 | 连接方向 | 应用层 | worker 监听 | 认证 |
|---|---|---|---|---|
| `http` | core → worker | 真实 HTTP/WS 反向代理，无隧道帧 | 可配置公网/内网地址 | core 注入 `Authorization: Bearer <workerToken>` |
| `stdio` | core spawn worker | NDJSON 隧道帧（stdout 只放帧，stderr 放日志） | 不监听公网；内部 loopback 随机端口 | 子进程 `hello.token` + 环境变量 |
| `reverse-ws` | worker → core | 一条 WebSocket，每个 text message 一帧 JSON | 不监听公网；内部 loopback 随机端口 | `/ws/worker` 升级请求 Bearer machine secret |

`http` 不是隧道：core 的 `HttpTransportDriver` 直接 `fetch` worker，`WsTransportDriver` 直接连 worker `/ws/*`。`stdio`/`reverse-ws` 共用 `TunnelTransportDriver`：帧编解码、请求复用、WS 多路复用、心跳完全一致，只替换字节通道。

### 4.2 统一帧协议

帧类型固定为 `hello | ping | pong | http-request | http-response | ws-open | ws-frame | ws-close`，详见 `docs/protocol.md` 与 `server/shared/src/protocol.ts`。要点：

- 每条 HTTP 请求/响应有 `id`；请求头帧后可按 `seq` 跟 chunk 帧；响应同理；`cancel` 取消。
- 每条 WS 流有独立 `id`，`ws-open` 建立，`ws-frame` 双向传输（utf8 或 base64），`ws-close` 终止。
- 终端与容器日志都是 WS 流，因此在同一隧道上天然多路复用；终端 64 条上限，超出新开被拒绝。
- 心跳 `ping/pong` 10s/30s；断线由 core 标记 offline，worker 重连。
- 帧上限 16 MiB，chunk 默认 512 KiB；HTTP 请求体与响应体都支持流式，避免大文件下载整段进内存。

### 4.3 三种传输共用同一套请求处理器

worker 只有一个 Fastify 应用：模块把路由注册到 `app`，WS 处理器注册到 `WsBridge`。传输适配只负责把外部请求送入这个应用：

- `http`：Fastify 直接 `listen` 公网地址；WS 由 `@fastify/websocket` 适配到 `WsBridge`。
- `stdio` / `reverse-ws`：worker 额外在 `127.0.0.1:0` 启动同一个 Fastify 实例（仅 loopback，强制绑定，不能改成 0.0.0.0），隧道桥接器把帧翻译成对 loopback 的 `fetch` 与 `ws` 客户端调用。HTTP 流式 body/response 和 WS upgrade 都保留真实语义，worker 模块完全不知道传输类型。

**为什么不用 `fastify.inject` 作为隧道主路径**：`inject` 会把响应缓冲到内存，文件下载（可达 GB）和日志流会破坏内存上限；它也不能执行 WebSocket upgrade。`inject` 仍用于进程内测试/健康自检。loopback 方案让三种传输共享同一组 Fastify 路由、hooks、zod 校验、错误处理器，满足“同一套请求处理器”的硬性要求；隧道桥只通过 loopback 的 HTTP/WS + worker token 访问，不直接调用 WsBridge 绕过鉴权。代价是隧道模式下多一个仅本机可见的随机端口（见 §10 风险）。

### 4.4 core 代理分层

```
Fastify proxy route ──> MachineService ──> TransportDriver ──> worker
        │                    │                    │
        │                    ├─ MachineStore      ├─ HttpTransportDriver
        │                    ├─ HealthMonitor     ├─ StdioTransportDriver
        │                    └─ ConnectionPool    └─ ReverseWsTransportDriver
        └─ auth/ticket（网关层，与传输无关）
```

- `MachineService` 是网关/路由唯一依赖（接口见 file-layout）；`TransportDriver` 只暴露 `start/stop/request/openWs/status`，reverse-ws 额外实现 `attach`。
- 代理层不 import `ws`/`child_process`，不感知 NDJSON；传输层不解析 `/api/v1` 业务路径。
- 统一路径映射：客户端 `/api/v1/machines/:id/proxy/<suffix>` → worker：
  - `<suffix>` 以 `/ws/` 开头 → 原样作为 worker WS 路径（`/ws/...`）。
  - 其余 → `/api/v1<suffix>`。
- core 转发前剥离 hop-by-hop 头、`cookie`、`authorization`（防止 core 凭据泄漏给 worker），注入 worker 凭据与 `x-mpanel-request-id`；响应保留业务 envelope/状态码，`401/403` 来自 worker 时说明 core 的 worker 凭据配置错误，core 转为 `UPSTREAM_ERROR`。

### 4.5 前端 basePath 切换

| 连接 | 特性 API basePath | WS base |
|---|---|---|
| 直连 worker | `<url>/api/v1` | `<ws-url>/ws` |
| core（未选机器，机器管理） | `<url>/api/v1` | `<ws-url>`（core 自身 WS） |
| core（已选机器，特性页） | `<url>/api/v1/machines/<machineId>/proxy` | `<ws-url>/api/v1/machines/<machineId>/proxy/ws` |

前端 `api/client.ts` 只接收 `basePath`；页面不拼接 URL。这样同一页面代码直连 worker 与经 core 都能工作。

## 5. 能力与降级策略

### 5.1 能力模型

`GET /api/v1/system/info` 返回：

```ts
capabilities: {
  caddy:    { available: boolean; version?: string; reason?: string; details?: Record<string, unknown> }
  docker:   { ... }
  postgres: { ... }
  redis:    { ... }
  pty:      { ... }
}
```

能力是**宿主级**探测，与单个数据库档案/容器无关；探测带 5s 超时、30s 缓存，`GET /system/info?refresh=1` 强制刷新。探测失败只写 `reason`，绝不使进程退出。

模块拿到的是 `CapabilityProvider`（`get(force?)`/`snapshot()`），不是启动快照；每次写操作前按需解析，`requires` 仅为 advisory，绝不因缺依赖阻止 worker 启动。

| 能力 | 探测方式 | 不可用时 |
|---|---|---|
| `caddy` | `caddy version`（`MPANEL_CADDY_BIN`） | `/sites` 仍可读写草稿（JSON 存储），但 `validate/apply` 返回 `UNAVAILABLE`，`preview` 只生成片段、`validation=null` 并给原因；`/certs` 的可用性取决于 Caddy data 目录是否可读，而不是二进制。`details.hint` 指向安装或设 `MPANEL_CADDY_BIN` |
| `docker` | `docker version --format '{{json .Server.Version}}'`；区分 CLI 缺失与 daemon 不可达 | `/containers`、`/images`、`/stacks` 列表 `available=false`；写操作 `UNAVAILABLE` |
| `postgres` | 加载 `pg` 驱动 + `pg_dump`/`pg_restore`/`psql` 探测；`details.tools` 逐项列出 | 档案仍可增删改查（JSON 存储）；`test`/`stats`/`handoff` 若驱动不可用则 `UNAVAILABLE`；备份/恢复缺工具时单独 `UNAVAILABLE` |
| `redis` | 加载 `ioredis` + `redis-cli` 探测 | 同上；无 `redis-cli` 时统计/连通性/`logical` 备份恢复仍可用（ioredis），`rdb` 物理快照不可用 |
| `pty` | `import('node-pty')` | 终端会话降级为 `child_process.spawn` 管道：仍可交互，`session.pty=false`，resize 无效；`capabilities.pty.available=false` 并存 |

### 5.2 统一列表形状

所有资源列表（sites/certs/profiles/containers/images/stacks/files/roots/trash/sessions/shells/tasks/runs/machines/backups/jobs）返回：

```ts
{ available: boolean; reason?: string; items: T[]; nextCursor?: string | null; total?: number }
```

不可用时 `available=false`、`reason` 为人类可读原因、`items=[]`。容器/镜像/编排等无数据源的详情在能力不可用时返回 `UNAVAILABLE`；站点与数据库档案的详情始终返回存储对象（草稿仍可编辑），依赖外部能力的动作按 §5.3 拒绝。

### 5.3 降级原则

1. **读优先**：能力缺失尽量保留只读/可编辑信息（站点草稿、数据库档案、任务定义）；容器/镜像/编排因无数据源直接不可用，证书目录不可读时也不可用。
2. **写拒绝**：不可用能力上的写操作一律 `UNAVAILABLE`，`details.hint` 必须可执行（例如 `Install Caddy or set MPANEL_CADDY_BIN`）。
3. **不自动安装/启动**：worker 不执行 `apt install`、不启动 Docker daemon、不拉起 Caddy。
4. **不隐藏失败**：探测原因、命令退出码、stderr 尾部进入 `reason`/`details`，日志脱敏。
5. **可选依赖**：`node-pty` 放 `optionalDependencies`，`pnpm install` 失败不阻断；`pg`/`ioredis` 是普通依赖但 import 失败也降级。

## 6. 安全模型

### 6.1 认证

**worker**
- `MPANEL_TOKEN` 静态 token（CLI `mpanel-worker token generate` 生成，建议 ≥32 字节随机）。缺失时除 `token` 子命令外拒绝启动。
- REST：`Authorization: Bearer <token>`。比较使用 SHA-256 + `timingSafeEqual`。
- WS：必须 `?ticket=<one-time>` 或 `?token=<token>`；无 ticket/token 的升级直接 401。浏览器无法设置 WS header，因此前端先 `POST /api/v1/auth/ws-ticket` 换票。
- 不提供用户名密码、无匿名模式、无“仅本机免认证”。

**core**
- 用户名密码：`scrypt`（N=16384,r=8,p=1,keyLen=64，随机 16 字节 salt），存储 `{salt, hash, N, r, p}`；`timingSafeEqual`。密码最短 10 字符。
- 用户通过 CLI 管理：`mpanel-core user add|passwd|list|delete`，`--password-stdin` 非交互。没有匿名初始化端点。首次启动可用 `MPANEL_ADMIN_USER`/`MPANEL_ADMIN_PASSWORD` 在 `users.json` 为空时 seed 一个 admin；seed 只执行一次，之后忽略并告警。
- 登录成功设置 `mpanel_session`：HttpOnly、SameSite=Lax（`MPANEL_COOKIE_SAMESITE`）、Path=/、`Secure`（HTTPS 或 `MPANEL_COOKIE_SECURE=1`）、Max-Age 7 天。Cookie 值是 32 字节随机数；服务器只存 SHA-256，session 文件泄漏不能直接重放。前端与 core 跨站部署时必须改为 `SameSite=None; Secure` 并配置 CORS，否则浏览器不发送 cookie。
- 多 core 同主机不同端口会共享 cookie 名，部署时给每个 core 设 `MPANEL_COOKIE_NAME=mpanel_session_<name>`。
- 脚本可用 `MPANEL_CORE_TOKEN` 静态 Bearer（未设置则禁用），映射为 `system` 管理员身份；比较同样 timing-safe。
- 登录失败限速：内存滑动窗口，连续 5 次失败锁定 30 秒，返回 `UNAUTHORIZED` + `details.retryAfterSec`（错误码全集没有 RATE_LIMITED，不新造码）。
- WS ticket：`POST /api/v1/auth/ws-ticket` 换 60 秒、一次性、绑定身份/机器/规范化路径+业务 query 的票据；所有 core WS 与代理 WS 必须凭 ticket 或 Bearer，不能裸连。
- `/ws/worker` 是 core↔worker 的机器注册通道，不属于用户 WS：用 machine secret 的 `Authorization: Bearer` 认证，同样不允许裸连；`/ws/terminal/*`、`/ws/containers/*/logs` 与 core 代理 WS 一律走用户 ticket/token。worker 的 WS gateway 还必须接受服务端到服务端的 `Authorization: Bearer <MPANEL_TOKEN>`（core http 传输），与 `?token=`/`?ticket=` 并存。
- 鉴权 hook 的作用域：REST 只挂 `/api/v1` 子作用域（core 精确放行 login 与 handoff redeem；worker 精确放行 handoff redeem）；`/healthz`、core 静态、`/ws/worker`、worker `/ws/*`、core 代理 WS 不经过 REST hook。
- **handoff redeem 的唯一无 session 例外**：core 对 `POST /api/v1/machines/:id/proxy/databases/handoff/redeem` 不做 session/Bearer 校验，因为 JSON body 中的 worker 256-bit 一次性 ticket 本身就是凭据（TTL 60s，绑定 profile，worker 端原子消费）。该例外仅限精确路径、仅 POST、仅允许 `MPANEL_DBX_ORIGIN` 的 CORS，并做限速；其他任何代理路径仍必须认证。
- CSRF：SameSite=Lax；cookie 认证的 `POST/PUT/PATCH/DELETE` 还要求 `Origin` 同源或在 `MPANEL_CORS_ORIGINS` 内，或带 `X-MPanel-Request: 1`（跨站表单无法设置该头）。Bearer 请求不受 CSRF 影响。

### 6.2 机密

- worker 数据库密码、core 的 worker token / reverse-ws secret 使用 AES-256-GCM 加密后落盘。密钥来自 `MPANEL_SECRET_KEY`（base64 32 字节）；未配置时首次启动用 `open(path,'wx',0o600)` 原子创建 `$MPANEL_HOME/secrets.key`（EEXIST 则读取已有文件，避免 core/worker 同 home 竞态），并在日志提示备份。除 handoff redeem 返回一次性明文连接信息外，API 永不返回明文/密文，只返回 `hasPassword`；handoff 是唯一例外（ticket 凭据、no-store、CORS 限定、单次）。更换密钥会使旧密文不可解密（数据库密码需重录、机器 token/secret 需重新下发），升级/迁移前先备份 key。
- reverse-ws 注册 secret 只在创建/轮换响应中出现一次；core 存 SHA-256 哈希。
- reverse-ws 的 `?machineId=&secret=` 兼容认证默认关闭；只有 core 设置 `MPANEL_ALLOW_WS_QUERY_SECRET=1` 才接受，且始终优先 `Authorization` header。
- handoff 票据是 32 字节随机数，内存 Map，单次使用，TTL 10–300 秒；redeem 返回数据库密码，因此 redeem 端点允许 `MPANEL_DBX_ORIGIN` 跨域且禁止缓存。
- 日志/错误/details 脱敏：`authorization`、`cookie`、`set-cookie`、`password`、`secret`、`token`、`ticket`、`PGPASSWORD`、`REDISCLI_AUTH` 一律替换为 `[redacted]`。stdout 在 stdio 模式只允许帧。

### 6.3 文件路径沙箱

- 根由 `MPANEL_FILES_ROOTS` 配置，格式 `name=absolutePath`，缺省 `files=$MPANEL_HOME/files`；名称唯一。
- 所有文件 API 用户路径是**根内虚拟路径**（POSIX 风格，可带前导 `/`），拒绝 NUL/控制字符、反斜杠、盘符、UNC、`..` 段；terminal/task cwd 与 Caddy root 使用独立 hostPathSchema，不混用虚拟路径。
- 先 `realpath` 根，再 `realpath` 目标（不存在时 realpath 最近存在的父目录），用 `path.relative` 验证结果不以 `..` 开头且非绝对路径；Windows 下大小写归一化后比较。
- 符号链接：列表可见（`type=symlink`, `isSymlink=true`），但所有读写/修改/删除/打包/解压操作拒绝最终路径或中间路径为符号链接（v1 直接 `BAD_REQUEST` + hint），避免 `..` 与链接双重逃逸。`targetType` 仅在目标仍在根内时返回。
- 上传先写 `$ROOT/.mpanel-tmp/`，fsync 后 rename；下载只允许 `file` 类型；禁止设备/管道/FIFO。
- 归档/解压使用 `tar` 二进制参数数组，先 `tar -tvf` 扫描条目，拒绝绝对路径、`..`、符号链接/硬链接条目；解压目标必须仍在根内。
- 文件根白名单也是 Caddy `file_server.root` 的允许范围（`MPANEL_SITES_ROOTS` 默认包含 files 根与 `$MPANEL_HOME/sites`）。

### 6.4 命令执行

- 所有系统命令走 `CommandRunner`（`execFile`/`spawn` + argv 数组），禁止 `exec`、`execSync`、`shell: true`、字符串拼接。Caddy validate/reload、docker、compose、tar、pg_dump/pg_restore/psql、redis-cli、chmod 全部如此。默认 env 只允许 `PATH/HOME/TMPDIR/TMP/TEMP/SystemRoot/ComSpec/PATHEXT/LANG/LC_ALL/TZ` 等最小集合，绝不继承 `MPANEL_*`；需要密码/凭据的调用显式传 `PGPASSWORD`、`REDISCLI_AUTH`。
- 环境变量传递密码（`PGPASSWORD`、`REDISCLI_AUTH`），不放 argv。
- 超时、输出上限（默认 8 MiB）、进程树 kill；stderr 截断后进错误信息。
- **可信属主功能**（命令本身就是用户输入，无法参数化）：
  - 计划任务的 shell 命令（`ShellRunner`）；
  - 终端 PTY/交互 shell；
  - Docker `exec`（argv，不经过 shell，但仍可执行任意命令）；
  - Compose YAML（可挂载宿主目录、privileged）；
  - stdio 机器的启动命令（core 管理员可指定任意可执行文件）；
  - 文件根、Caddy file_server 根配置。
  这些功能仅对已认证属主开放。v1 没有只读用户隔离；`authUser.role` 的 `operator` 预留但不降低权限。文档、UI 和 API 均明确标注。

### 6.5 Caddyfile 注入边界

- 站点只接受结构化 `SiteConfig`；**不支持**原始 Caddyfile 片段、`import`、任意指令、`basic_auth` 哈希注入。
- 域名/监听地址用白名单正则；header 名用 RFC token 正则；header 值、redirect 目标拒绝 CR/LF；upstream/root 进入生成器前校验。
- 生成器对所有用户字符串使用 Caddy token 引号（双引号包裹，转义 `\` 与 `"`，拒绝所有控制字符），upstream/healthUri/root/header 名/值在 zod 层也先校验；指令名和结构由代码固定。
- `preview` 展示将要写入的内容；`apply` 先写 staging 并 `caddy validate`，失败绝不触碰线上目录。

### 6.6 网络与部署

- worker/core 默认 `127.0.0.1`。对外必须由 TLS 反代（Caddy/nginx）或内网可信网络。
- 反向代理必须透传 `Upgrade`/`Connection` 以支持 WS，并设置足够大的 body 上限（文件上传由 worker 自己限流，默认 100 MiB）。
- CORS 只允许 `MPANEL_CORS_ORIGINS` 明确列出的 origin，`credentials: true` 时禁止 `*`；允许请求头至少 `authorization`、`content-type`、`x-mpanel-request`、`range`，暴露 `x-mpanel-request-id`、`content-disposition`。handoff redeem 额外允许 `MPANEL_DBX_ORIGIN`，只读/无 cookie。
- 静态托管（core `registerStatic` 或 Caddy）必须设置 `Content-Security-Policy`（`frame-src` 含 dbx 源）、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`；core 的 CSP 可由 `MPANEL_CSP` 覆盖。
- 安全响应头由前端托管层负责：`Content-Security-Policy`（iframe 需允许 dbx 源）、`X-Content-Type-Options`、`Referrer-Policy`。iframe 使用 `sandbox` 与最小 `allow`。
- core 的 `MPANEL_ALLOW_STDIO=1` 是危险开关：创建 stdio 机器等于在 core 主机执行命令，仅管理员可用；未开启时 API 返回 `FORBIDDEN`。

## 7. 持久化

### 7.1 决定：原子 JSON 存储（tmp + rename + fsync），不使用 `node:sqlite`

理由：

1. **数据量小且单写者**：core 只存机器/用户/session；worker 每模块最多数百条配置，历史用 JSONL 追加。SQLite 的查询/事务能力用不上。
2. **并行开发解耦**：13 条轨道共享一个 schema 会引入迁移所有权冲突；JSON 文件按模块划分（`sites.json`、`tasks.json`…），一个模块只写自己的文件。JSONL 追加不需要跨模块锁。
3. **可恢复/可审计**：文本可直接检查、复制、手工修复；备份就是复制目录。
4. **运维简单**：JSON 文件无 schema 迁移、无 SQLite 文件损坏后的 `.wal`/`.shm` 处理；备份/迁移就是复制/打包文本目录。Node 24 的 `node:sqlite` 可用，但本项目不需要它的 SQL/事务能力，引入它会增加中央 schema 与跨模块迁移成本。
5. **零原生依赖**：满足硬性要求 G。

代价与约束：

- 无跨文件事务；每个文件独立原子写。需要跨文件一致性的操作（site 配置 + 应用状态）以 revision/备份补偿，不使用多文件事务。
- 每进程单写者：worker 获取 `$MPANEL_HOME/state/.worker.lock`，core 获取 `$MPANEL_HOME/state/.core.lock`（pid+启动时间），检测 stale pid 后可接管；同角色的第二个进程直接退出。core/worker 可以共享同一个 `MPANEL_HOME`，锁按角色隔离。
- 写入：同目录 `.<name>.<pid>.<rand>.tmp` → `fsync` → `rename`；读缺失/损坏时从 `.bak` 恢复并报 `INTERNAL` 日志；写前保留一份 `.bak`。
- 每个 JSON 根对象包含 `schemaVersion: 1`；读取时逐版本迁移，迁移前备份。
- JSONL（任务历史、审计）追加写，单行 ≤ 256 KiB；超过 5 MiB 轮转为 `.1`，保留 3 份。

### 7.2 目录

```
$MPANEL_HOME/                       # 默认 ~/.mpanel
├─ state/
│  ├─ .worker.lock                  # worker
│  ├─ .core.lock                    # core
│  ├─ sites.json                    # worker
│  ├─ databases.json                # worker
│  ├─ tasks.json                    # worker
│  ├─ task-runs.jsonl               # worker
│  ├─ machines.json                 # core
│  ├─ users.json                    # core
│  ├─ sessions.json                 # core
│  └─ audit.jsonl                   # core
├─ secrets.key                      # 未配置 MPANEL_SECRET_KEY 时生成
├─ caddy/
│  ├─ Caddyfile                     # 主配置，import sites.d/*.caddy
│  ├─ sites.d/                      # 每站点一个片段
│  ├─ staging/                      # 生成/校验
│  └─ data/                         # Caddy 数据目录（证书），可配置
├─ sites/                           # 默认静态站点根
├─ files/                           # 默认文件管理根
├─ stacks/<name>/compose.yaml
├─ backups/
│  ├─ caddy/<timestamp>/
│  └─ databases/<profileId>/<backupId>.<ext>
├─ trash/<trashId>/{manifest.json,data/}
└─ logs/
   ├─ worker.log
   ├─ core.log
   ├─ tasks/<taskId>/<runId>.log
   └─ workers/<machineId>.log       # core 捕获 stdio stderr
```

## 8. 关键流程

### 8.1 站点应用（Caddy 现代化模型）

1. 读取所有站点，按 `enabled` + `revision` 生成每个站点的 Caddyfile 片段到 `caddy/staging/sites.d/`，生成主 Caddyfile（固定 global + `import sites.d/*.caddy`）。
2. `caddy validate --config <staging>/Caddyfile --adapter caddyfile`（`execFile`）。失败：删除 staging，返回 `BAD_REQUEST`（含 stderr 尾部），线上不变。
3. 备份 `Caddyfile` 与 `sites.d/` 到 `backups/caddy/<timestamp>/`。
4. 原子替换：更新 `sites.d/`（Windows 用 `sites.d.next` → 旧目录改名 → 新目录改名），`Caddyfile` 用 tmp+rename。持有 apply 互斥锁，串行化。
5. `caddy reload --config <Caddyfile> --adapter caddyfile`。失败：恢复备份目录与主配置，再次 reload；返回 `UPSTREAM_ERROR` 或 `INTERNAL`，`rolledBack=true`。
6. 全部成功才把每个站点的 `appliedRevision` 设为其当前站点 `revision`、`status=applied`，`lastApply.revision` 写本次全局 apply 序号；失败保留 `status=error`，站点仍可编辑重试。
7. `POST /sites/preview` 可只生成不校验；`validate=true` 时调用 validate 但不写线上目录。

**Caddyfile 映射规则（worker 站点轨道按此生成）**：

| SiteConfig | 片段 |
|---|---|
| `tls.mode='off'` | 站点地址加 `http://` 前缀；不生成 `tls` 指令 |
| `tls.mode='auto'` | 纯域名地址；可选 `tls <email>` |
| `tls.mode='internal'` | 纯域名地址 + `tls internal` |
| `listen[]` | block 内 `bind <addr>`（每项一行，地址已白名单） |
| `reverse_proxy` | `reverse_proxy "upstream1" "upstream2" { lb_policy ...; header_up ...; transport http { tls_insecure_skip_verify } }`；`healthUri` → `health_uri` |
| `file_server` | `root * "<root>"`；`spa` → `try_files {path} /index.html`；`browse` → `file_server browse`；`precompressed[]` → `precompressed <gzip\|zstd>` |
| `redirect` | `redir "<to>" permanent`；`preserveQuery` 时目标追加 `{uri}`（目标本身禁止引号/CRLF） |
| `headers` | 每个 header `header "<name>" "<value>"`（生成器转义） |
| `encode` | `encode gzip zstd`（按数组顺序） |
| `log` | `log`（固定，无用户字段） |

所有用户字符串都经过 `quoteCaddyToken()`；不允许把站点名、域名、header 值直接拼进指令名。

### 8.2 证书读取

- 扫描 `MPANEL_CADDY_DATA_DIR` 下 `certificates/**/*.{crt,pem}`；用 `node:crypto` 的 `X509Certificate` 解析，绝不读取/返回私钥。
- 从 SAN/CN 提取域名；`notAfter`/`notBefore` 转 ISO；`daysRemaining = floor((notAfter-now)/86400000)`；`expiring` 阈值 14 天；`expired` 若 `notAfter < now`。
- `id` 使用 SHA-256 指纹（hex）；按指纹去重（Caddy 可能同时有 `.crt` 与 `.pem` 副本）。
- 目录不存在/不可读 → 列表 `available=false`；单个证书解析失败跳过并记录警告，不让整个列表 500。

### 8.3 数据库 handoff

1. 前端（已认证）`POST /databases/profiles/:id/handoff`。
2. worker 生成一次性 ticket（32 字节随机，TTL 默认 60s，最多 300s），返回 `{ticket, expiresAt, redeemUrl, kind}`。
3. 前端用 `VITE_DBX_URL` 构造 iframe 地址（dbx 自己的约定），`redeemUrl` 是相对 API feature base 的 `/databases/handoff/redeem`（直连 worker → `/api/v1/databases/handoff/redeem`；经 core → `/api/v1/machines/<id>/proxy/databases/handoff/redeem`）。ticket 只放 URL fragment（`#handoff=...`）或由前端 postMessage 给 dbx，不进入服务器 path/query/access log；密码永不放 URL。
4. dbx 读取 ticket 后 `POST redeemUrl`，body `{ticket}`；worker 校验未过期/未使用，原子标记已用，解密密码，返回 `HandoffPayload`。响应 `Cache-Control: no-store`，CORS 仅 `MPANEL_DBX_ORIGIN`。经 core 时走 §6.1 的唯一无 session 代理例外，ticket 仍由 worker 校验；core/worker 审计只记录 ticket 哈希前 8 位，不记录 body/URL secret。
5. worker 不实现查询执行；dbx 负责连接与 UI。ticket 与 profile 绑定，profile 删除后 ticket 失效。

### 8.4 计划任务

- croner 解析 cron + IANA timezone；`nextRunAt` 由 croner 计算；启用任务注册调度器。
- 到点或 `run-now`：创建 run 记录（`running`），`spawn(shell, argv, { env, cwd, timeout })`；`skip` 策略在上一轮未结束时记 `skipped`。
- stdout/stderr 各留 16 KiB tail 进 run 记录，完整日志到 `logs/tasks/...`；超时 kill 进程树，状态 `timeout`。
- 任务命令是 shell 字符串，属于可信属主功能（F 的显式例外）；启动前从环境删除 `MPANEL_TOKEN`、`MPANEL_CORE_TOKEN`、`MPANEL_SECRET_KEY`、`MPANEL_MACHINE_SECRET`。

## 9. 目录结构

精确到文件、owner、导出签名见 `docs/file-layout.md`。概要：

```
MPanel/
├─ package.json / pnpm-workspace.yaml / tsconfig.base.json     # 脚手架
├─ docs/{architecture,api-contract,protocol,file-layout}.md    # 架构
├─ server/shared/src/                                           # 架构
├─ server/worker/src/{index,config,http,auth,registry,capabilities,exec,paths,store}.ts
│                    transports/{stdio,http,reverse-ws}.ts
│                    modules/{sites,certs,databases,containers,files,terminal,tasks}/
├─ server/core/src/{index,config,app,static}.ts
│                  auth/ machines/ transports/ proxy/
├─ web/src/{main.tsx,routes.tsx,app,api,lib,components,pages,styles}
├─ scripts/{check,smoke}.mjs
└─ deploy/{systemd,env,Caddyfile.example,README.md}
```

## 10. 版本与升级

### 10.1 版本面

| 版本 | 位置 | 规则 |
|---|---|---|
| 产品版本 `0.x.y` | 各 package.json、`system/info.version` | 语义化；三端可不同小版本 |
| API `apiVersion: 1` | `/api/v1`、`system/info.apiVersion` | 破坏性变更升 `/api/v2`；v1 只做加法 |
| 隧道 `protocolVersion: 1` | hello、`system/info.protocolVersion` | 帧字段只加可选；破坏性变更升 2 并拒绝旧连接 |
| 数据 `schemaVersion: 1` | 每个 JSON 根对象 | 读取时迁移，迁移前备份 |

### 10.2 兼容规则

- **worker 先向后兼容**：core 必须能解析旧 worker 的 v1 帧和响应；未知的响应字段忽略（zod 默认 strip）。worker 不得依赖 core 的新可选字段。
- **新 core + 旧 worker**：允许；新功能若依赖新字段，按能力/版本降级并提示。
- **旧 core + 新 worker**：worker 的 hello 可带新字段；旧 core 忽略。若新 worker 需要新帧，必须先用 hello 协商，未确认则退回 v1 行为。
- **前端**：运行时 `/config.json` 可覆盖编译期默认；API 客户端对未知字段宽容，对未知错误码显示通用错误并保留 `code`。
- **协议握手失败**：reverse-ws/stdio 的 hello `v` 不匹配或 `accepted:false`，关闭码 `4002 VERSION_MISMATCH`；core 标记机器 `error` 并在 UI 显示两端版本。

### 10.3 升级顺序

1. **core 先升级**（若协议仅加法）：新 core 兼容旧 worker；保留 `/api/v1`。
2. **逐台升级 worker**：http 模式滚动重启；stdio 模式由 core 重启子进程（新入口路径）；reverse-ws 模式 worker 重连后 core 更新版本。
3. **web 最后/独立**：静态文件替换即生效；`config.json` 回滚可恢复后端指向。
4. 破坏性协议升级：core 同时支持 v1/v2 一个发布周期，用机器维度 `protocolVersion` 协商；不支持双版本的部署必须先停 worker 再升 core（文档中标注）。
5. 降级：不支持自动降级。恢复 `$MPANEL_HOME/backups` 与旧二进制；JSON 迁移后的文件旧版本可能无法读取，升级前自动备份整个 `state/`。

### 10.4 发布物

- `server/shared`：先 `tsc` 产出 `dist`，core/worker 构建时通过 workspace 依赖解析。
- `server/worker`：`pnpm deploy` 产物（dist + 生产 node_modules）单入口 `node dist/index.js`；`node-pty` 可选。
- `server/core`：`pnpm deploy` 产物（dist + 生产 node_modules）；可托管 `web/dist`。
- `web`：`vite build` 产出静态文件 + `config.json`。
- 三端均不打包成单文件二进制；Node 24 运行时是前置条件。

## 11. 可观测性与运维

- Fastify 内置 pino JSON 日志；`MPANEL_LOG_LEVEL`。stdio 模式日志强制 stderr，stdout 仅帧。
- 请求 id：core 生成 `x-mpanel-request-id`，经代理传给 worker；worker 回显到日志与响应头。
- 审计（core）：登录成功/失败、用户管理、机器创建/删除/轮换 secret、代理写请求（方法/路径/机器/状态）。worker 审计可选，写入 `logs/worker.log`。
- 健康：`GET /healthz` 返回 `{ ok, status, version }`；core `/machines/:id/health` 与 `/system/overview` 汇总。
- 资源上限：上传 100 MiB（可配）、JSON body 8 MiB（`/files/write` 20 MiB）、隧道帧 16 MiB、并发请求 128/机器、WS 64/机器、终端 20 会话/worker、文件搜索 200 结果。core 代理使用独立封装插件 + catch-all no-op content-type parser + ≥110 MiB route bodyLimit，绝不能消费 `req.raw`；413/415 统一映射为 `BAD_REQUEST` 信封。
- 备份：`state/` 与 `caddy/` 由部署方定期快照；worker 自身只保留 Caddy 应用前回滚备份和数据库备份。

## 12. 测试与验收

- `pnpm typecheck`：所有包 strict tsc。
- `pnpm check`：契约静态检查（owner 覆盖、禁止 `exec`/`shell:true`、web 不 import shared、无 TODO、zod 编译）。
- `pnpm smoke`：无外部服务依赖的端到端脚本（详见 `docs/file-layout.md` §scripts）：worker token、401、system/info 能力形状、文件沙箱逃逸拒绝、任务 run-now、站点预览、core 登录、http 机器注册、代理 system/info、经 core 的 multipart 上传与成功代理 WS、WS ticket 拒绝裸连，以及 stdio/reverse-ws 各一条 hello+请求。Caddy/Docker 不可用时断言 `available=false` 与 `UNAVAILABLE`，PTY 不可用时断言 `capabilities.pty.available=false` 且终端仍可创建（`pty=false`），而不是跳过。
- 不引入 vitest/jest；冒烟脚本用 `node:assert`，失败退出非零。

## 13. 已知限制与风险

1. **单属主模型**：没有租户隔离；任务/终端/Compose/stdio 机器本质上是宿主 RCE 能力，只应部署给可信管理员。
2. **stdio/reverse-ws 的 loopback 端口**：隧道模式会监听 `127.0.0.1` 随机端口。它受 worker token 保护且不可配置为公网，但同机其他用户可以扫描到端口；威胁模型假设同机用户可信。若不可接受，可改为 `fastify.inject` + 非流式上限（会牺牲大文件流）。
3. **Windows 目录原子性**：NTFS 不支持“原子替换非空目录”；apply 采用“旧目录改名→新目录改名→reload”并保留回滚，存在毫秒级窗口。Linux 上可做到近原子。
4. **单 core**：session/ticket 存在内存与本地 JSON，不能多副本；JSON 存储单写者。横向扩展需外部存储与会话共享，v1 不做。
5. **worker 单 token**：轮换会使所有使用旧 token 的客户端失效；core 与直连需协调。
6. **Caddy 进程不由面板管理**：`caddy reload` 依赖系统服务/管理员 API；Caddy 未运行时 apply 会失败并回滚。
7. **Redis 备份**提供两种：`logical`（ioredis `SCAN`/`DUMP` + `RESTORE`，在线恢复，默认）与 `rdb`（依赖 `redis-cli --rdb`，只能离线恢复）。`rdb` 的恢复请求返回 `UNAVAILABLE`。
8. **Windows 语义**：`chmod` 仅映射只读位；文件模式字符串是尽力而为；PTY 依赖 ConPTY。
9. **dbx 外部契约**：iframe URL 形态、handoff 参数名由 dbx 决定；MPanel 只保证 `redeemUrl` 与 CORS。若 dbx 不支持跨域，需要同源反代。
10. **前端依赖补充**：固定技术栈未列路由库，使用 `react-router-dom`（非 UI 组件库）。若必须零额外依赖，可用 hash 路由自建，但不建议。
11. **Caddy 证书路径**：Caddy 版本/存储后端不同可能改变目录布局；扫描器按扩展名+证书内容识别，找不到时 `available=false` 并提示配置 `MPANEL_CADDY_DATA_DIR`。

## 14. 需要人工裁决的契约矛盾

1. **“13 个 owner”与枚举出 16 个名字**：任务原文要求“正好 13 个 owner 名字”，随后列出 16 个（架构、脚手架、worker 核心/站点/容器/数据/文件/终端与任务、core 主机与代理、core 认证与网关、前端外壳、前端数据库页、前端容器页、前端文件页、前端终端与任务页、集成）。本契约以**枚举的 16 个名称为准**，其中 13 条实现轨道 = 16 − {架构, 脚手架, 集成}；架构/脚手架/集成是横切轨道。未静默合并任何实现域。
2. **没有“前端站点与证书页”owner**：枚举中没有该前端轨道。为避免新增 owner，`web/src/pages/sites/`、`web/src/pages/certs/` 归 **前端外壳**；worker 侧站点/证书仍归 **worker 站点**。这是唯一可行的不重叠分配。
3. **`fastify.inject` 建议**：硬性决定只写“可以借助”，未强制。为保留流式下载/上传与 WS，采用 loopback 内部监听；`inject` 仅用于测试。已在 §4.3 说明。
4. **额外依赖**：`ws`（`@fastify/websocket` 的底层，core/worker 直接使用）、`react-router-dom`（路由，非 UI 组件库）、`tsx`（dev-only，用于运行 TS 源码）、Tailwind 所需的 `postcss`/`autoprefixer`（构建期）。其余运行时依赖严格按固定栈。

如裁决结果不同，先改本文件、`docs/file-layout.md` 与 `server/shared`，再启动实现轨道。
