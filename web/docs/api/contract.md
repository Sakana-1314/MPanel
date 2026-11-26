# MPanel REST API v1 契约

状态：v1 冻结（2026-11-25）。**本文件是唯一事实源**，`web/panel/src/api/types.ts` 是浏览器侧的手写镜像，Go 结构体在 `server/core/protocol` 与各模块内实现。

> 术语说明：本文档写于 TypeScript 版本时期，「worker」在 Go 实现中更名为 **agent**（对应 `mpanel-agent`、`server/agent/`、`MPANEL_AGENT_*`）。机器模型里的 `worker` 字段（`machine.worker`）与 `/system/info` 的 `role: "worker"` 是协议字段，保留原名。

- 基础路径：worker 与 core 都是 `/api/v1`；core 另有 `/api/v1/machines/:machineId/proxy/*`。
- 内容类型：JSON 为 `application/json; charset=utf-8`；上传 `multipart/form-data`；下载为二进制流（§2.8）。
- 时间：RFC 3339 / ISO 8601 UTC，带 `Z`，如 `2026-11-25T08:30:00.000Z`。
- 标识：不透明字符串，建议前缀 `st_`、`db_`、`bk_`、`job_`、`tk_`、`run_`、`term_`、`m_`、`tr_`；客户端不得解析。
- 布尔查询参数：`true|false|1|0`。
- v1 只做加法：客户端忽略未知响应字段，服务器忽略未知请求字段（zod strip）；破坏性变更开 `/api/v2`。

## 1. 信封与错误

### 1.1 信封

所有 JSON 响应（除 §2.8 裸流与 `/healthz`）统一为：

```ts
type ApiEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: ErrorCode; message: string; details?: unknown } };

type ErrorCode =
  | 'BAD_REQUEST' | 'UNAUTHORIZED' | 'FORBIDDEN' | 'NOT_FOUND'
  | 'CONFLICT' | 'UNAVAILABLE' | 'UPSTREAM_ERROR' | 'INTERNAL';

interface PageQuery { limit?: number; cursor?: string }

interface ListResult<T> {
  available: boolean;
  reason?: string;
  items: T[];
  nextCursor?: string | null;
  total?: number;
}
```

- 成功：HTTP 200（创建 201，异步作业 202）。
- 失败：HTTP 状态由 `code` 唯一决定；响应体必须是失败信封。
- `message` 面向人类，不含密钥/堆栈/SQL/命令原文；命令 stderr 截断后可放 `details.output`。
- 响应头：`X-MPanel-Request-Id`、`X-MPanel-Api-Version: 1`、`Cache-Control: no-store`；代理响应额外 `X-MPanel-Machine: <id>`。

### 1.2 错误码全集（封闭集合）

| code | HTTP | 语义 | 典型 details |
|---|---:|---|---|
| `BAD_REQUEST` | 400 | 参数/校验/路径/格式错误 | `{ issues?, hint?, stage?, output? }` |
| `UNAUTHORIZED` | 401 | 缺少/无效凭据、ticket 过期/已用、密码错误、redeem 限速 | `{ retryAfterSec? }` |
| `FORBIDDEN` | 403 | 已认证但策略禁止 | `{ required?, hint? }` |
| `NOT_FOUND` | 404 | 资源/路由不存在；handoff 无效/过期/已用 | `{ resource?, id? }` |
| `CONFLICT` | 409 | 唯一名冲突、并发 apply、运行中 job、乐观锁冲突 | `{ resource?, field?, retryAfterMs? }` |
| `UNAVAILABLE` | 503 | 能力/工具/机器不可用；**details.hint 必填** | `{ hint, capability?, reason?, machineId?, machineStatus? }` |
| `UPSTREAM_ERROR` | 502 | 目标 worker/数据库/Caddy reload 失败 | `{ machineId?, stage?, status?, output?, message? }` |
| `INTERNAL` | 500 | 未分类内部错误 | `{ requestId }`（不返回堆栈） |

- 不新增错误码；新语义用 `details.reason`，或开 v2。`429` 不使用：登录/redeem 限速以 `401` + `details.retryAfterSec` 表达。
- `UNAVAILABLE` 的 `details.hint` 在 shared error schema、`PanelError` 构造、`errorEnvelope` 三层强制；缺失时补默认 hint，绝不让前端拿不到提示。

### 1.3 示例

```json
{
  "ok": false,
  "error": {
    "code": "UNAVAILABLE",
    "message": "Caddy is not available",
    "details": {
      "capability": "caddy",
      "reason": "caddy binary not found: caddy",
      "hint": "Install Caddy or set MPANEL_CADDY_BIN to its absolute path, then retry."
    }
  }
}
```

```json
{
  "ok": false,
  "error": {
    "code": "BAD_REQUEST",
    "message": "Request validation failed",
    "details": {
      "issues": [{ "path": "config.handler.upstreams.0", "code": "custom", "message": "Invalid upstream" }]
    }
  }
}
```

## 2. 通用约定

### 2.1 认证矩阵

| 端点 | worker | core |
|---|---|---|
| `GET /healthz` | 无认证 | 无认证 |
| `POST /auth/login` | 不存在（404） | 无认证 |
| `POST /auth/ws-ticket` | Bearer token | session cookie 或 Bearer core token |
| 其余 `/api/v1/*` | Bearer token | session cookie 或 Bearer core token |
| `WS /ws/*` | `?ticket=` / `?token=` / `Authorization: Bearer <MPANEL_TOKEN>`（服务端到服务端） | `?ticket=` / `?token=` / `Authorization: Bearer <MPANEL_CORE_TOKEN>`（脚本）；**不接受仅 cookie** |
| `WS /ws/worker`（core 内部） | — | reverse-ws machine secret |
| `POST /databases/handoff/redeem`（worker） | **无**（JSON body 的 ticket 是凭据） | —（core 经 proxy 例外行） |
| `POST /api/v1/machines/:id/proxy/databases/handoff/redeem` | — | **无 session**（JSON body 的 ticket 是凭据；§8.4） |
| `/`、静态资源（core） | — | 无认证（SPA 自己登录） |

- worker REST 只接受 `Authorization: Bearer <MPANEL_TOKEN>`；cookie 无效。
- core 登录后用 HttpOnly cookie；脚本用 `Authorization: Bearer <MPANEL_CORE_TOKEN>`，两者都有时 Bearer 优先。
- 任何 WS 裸连（无 ticket/token/Bearer）在 upgrade 阶段直接 `401 UNAUTHORIZED`，不建立 socket。
- worker WS gateway 必须同时接受 Bearer、`?token=`、`?ticket=`；Bearer 用于 core http 传输/服务端直连，`?token=` 用于隧道 loopback，`?ticket=` 用于浏览器。
- `/ws/worker` 是机器注册通道，不属于用户 WS：用 machine secret 的 Bearer，禁止裸连。

### 2.1.1 鉴权作用域（实现必须按作用域注册 hook）

- 公开：`GET /healthz`、core `POST /api/v1/auth/login`、core 静态/SPA fallback。
- worker `/api/v1` 子作用域：Bearer token；仅精确放行 `POST /api/v1/databases/handoff/redeem`。
- core `/api/v1` 子作用域：session/Bearer；仅精确放行 `POST /api/v1/auth/login` 与 `POST /api/v1/machines/:id/proxy/databases/handoff/redeem`。
- WS 独立作用域：worker `/ws/*` 由 WS gateway 认证；core `/ws/worker` 由 machine secret 认证；core 代理 WS 由一次性 ticket/Bearer 认证。**WS 路径不挂 REST `onRequest` hook**，否则 ticket 会在 gateway 消费前被 401。
- core 代理路由放在独立封装插件（见 §2.7.1），不得用全局 JSON parser 消费原始 body。

### 2.1.2 端点归属

| 端点组 | worker | core |
|---|---|---|
| `/system/info` | 有 | 有（role=core，能力全 false） |
| `/system/overview` | 404 | 有 |
| `/machines*` | 404 | 有 |
| `/machines/:id/proxy/*` | 404 | 有 |
| `/auth/login`、`/auth/logout`、`/auth/password` | 404 | 有 |
| `/auth/me`、`/auth/ws-ticket` | 有（token） | 有（session/Bearer） |
| `/sites`、`/certs`、`/databases`、`/containers`、`/images`、`/stacks`、`/files`、`/terminal`、`/tasks` | 有 | 404（经 proxy 到具体机器） |

### 2.2 一次性 WS ticket

`POST /api/v1/auth/ws-ticket`

```ts
// 请求
{ path: string; machineId?: string }
// data
{ ticket: string; expiresAt: string; path: string; machineId?: string | null }
```

- TTL 60 秒；一次性；绑定认证身份、`machineId`（core 代理）和**规范化 path+业务 query**（剔除 `ticket`/`token`，其余参数排序后比较）。
- 客户端连接时可在同一业务 path 上追加 `?ticket=...`；业务参数必须与取票时一致（顺序无关，参数集合相同）。
- 失败/过期/已用 → upgrade 401，或已升级后 close `4401`。
- 示例：

```
# worker 直连
POST /api/v1/auth/ws-ticket  {"path":"/ws/terminal/term_abc"}
wss://worker/ws/terminal/term_abc?ticket=...

# core 代理
POST /api/v1/auth/ws-ticket  {"path":"/api/v1/machines/m_1/proxy/ws/terminal/term_abc","machineId":"m_1"}
wss://core/api/v1/machines/m_1/proxy/ws/terminal/term_abc?ticket=...
```

- 浏览器无法设置 WS header；前端调用 `connectWs(featurePath)`（如 `/terminal/term_abc`），`api/ws.ts` 用 `wsPathFor()` 生成完整 ticket path 与 wss URL，同一业务 query 取票后追加 ticket。
- `?token=` 供脚本使用，会进入访问日志；生产优先 ticket。
- 上面的 worker 直连示例仅用于脚本/第三方客户端；`web/panel` 只通过 core 代理取 ticket 与建连。

### 2.3 列表、可用性与分页

所有资源列表：

```ts
interface ListResult<T> {
  available: boolean;
  reason?: string;
  items: T[];
  nextCursor?: string | null;
  total?: number;
}
```

| 列表 | `available=true` 条件 | 不可用时写操作 |
|---|---|---|
| `/sites` | 站点 JSON 存储可读 | `apply`/`validate` 需 caddy；`preview` 仍生成片段（validation=null） |
| `/certs` | Caddy data 目录可读 | 只读 |
| `/databases/profiles` | 档案存储可读 | test/stats 需驱动+目标可达；backup/restore 需工具 |
| `/containers`、`/containers/networks`、`/images`、`/stacks` | docker CLI + daemon 可用 | 全部写操作 `UNAVAILABLE` |
| `/containers/config` | daemon 配置文件可读 | 写操作需文件可写；不依赖 docker daemon |
| `/files/*` | 至少一个文件根通过 realpath 校验 | 全部写操作 `UNAVAILABLE` |
| `/terminal/sessions` | 进程可 spawn（pty 可选） | `pty=false` 仍可创建管道会话 |
| `/tasks` | 内置 croner 可加载 | 无 |
| `/machines`（core） | 机器存储可读 | 连接/代理按机器状态 |

分页：

- `limit`：1–200，默认 50；`cursor` 是上一页 `nextCursor` 原样回传，客户端不得解析。
- 默认排序见各节；相同排序键以 `id` 升序稳定排序。
- 无效/过期 cursor → `BAD_REQUEST`。
- 不分页的列表（roots、shells、sessions 等）仍返回 `ListResult`，`nextCursor=null`。

### 2.4 能力与降级

- 列表在能力不可用时返回 `200` + `{available:false,reason,items:[]}`，不返回 503。
- 能力不可用时的写操作 → `503 UNAVAILABLE`，`details.hint` 必须可执行。
- 目标数据库/容器/机器本身不可达 ≠ 能力不可用：健康/测试返回业务结果（`ok:false`），统计返回 `UPSTREAM_ERROR`。
- 模块通过 request-time `CapabilityProvider` 判断；`requires` 只做诊断，不得阻止 worker 启动。
- `GET /system/info?refresh=1` 强制重新探测（worker）；core 忽略。

### 2.5 代理路径映射（core）

客户端：`/api/v1/machines/:machineId/proxy/<suffix>?<query>`。

| suffix | worker 收到 |
|---|---|
| `/ws/terminal/term_1` | `WS /ws/terminal/term_1` |
| `/ws/containers/abc/logs` | `WS /ws/containers/abc/logs` |
| `/system/info` | `GET /api/v1/system/info` |
| `/files/download?root=files&path=/a` | `GET /api/v1/files/download?...` |
| `/databases/handoff/redeem` | `POST /api/v1/databases/handoff/redeem` |

- core 删除 `cookie`、`authorization`、hop-by-hop 头，注入机器凭据、`x-mpanel-request-id`、`x-mpanel-user`；不透传 `set-cookie`。
- 兼容写法：`suffix` 也可以带 `/api/v1` 前缀（如 `GET /api/v1/machines/:id/proxy/api/v1/system/info`）；core 检测到后不再重复拼接，等价于 `/proxy/system/info`。这是加法兼容，不改变上表语义。
- 必须转发**原始 query 字符串**（保留重复参数/编码），不能用 Fastify 解析对象重建。
- worker 返回的 `UNAUTHORIZED`/`FORBIDDEN`（core 机器凭据错误）转为 `UPSTREAM_ERROR`；其他 envelope 原样透传状态码/body。
- 机器 offline/disabled/stopped → `503 UNAVAILABLE`，`details.machineStatus`。
- 大文件请求/响应流式转发，不整段缓冲。
- core 代理 WS 校验用户 ticket/token 后，从 query 移除 `ticket`/`token`，只保留业务参数，再连 worker；worker 用机器凭据认证。

### 2.6 前端连接模型（`web/panel`）

`web/panel` **只连接 core**，不提供 agent 直连。浏览器不保存任何 agent token / machine secret；所有特性请求都经 core 的机器代理。

```ts
// 每个工作台标签页独立绑定一台机器，不存在全局“当前机器”切换。
const machineId = route.params.machineId;
const basePath = `${connection.url}/api/v1/machines/${machineId}/proxy`;
```

- 页面只使用 `basePath + '/sites'` 等相对路径；auth、machines、edge、system/overview 固定走 core 根 `${connection.url}/api/v1`。
- WS 不直接用 basePath：core 代理 `<ws-url>/api/v1/machines/<machineId>/proxy/ws`；`api/ws.ts` 在其后拼 `/terminal/...`、`/containers/.../logs`。页面不自行拼 WS URL。
- 多机工作台：标签页保存 `machineId + 路由`，可以同时混合打开多台机器的不同页面；切换机器不会替换其它标签。
- `/api/v1` 的 agent 直连能力仍保留给脚本与第三方客户端（§2.1、§2.2），但 `web/panel` 不使用。

### 2.7 请求限制与超时

| 项 | 值 |
|---|---|
| JSON body | 8 MiB（`PUT /files/write` 20 MiB） |
| 文件上传 | 100 MiB（`MPANEL_MAX_UPLOAD_BYTES`） |
| 归档/Compose YAML | 1 MiB |
| 终端输入帧 | 1 MiB |
| 代理/隧道请求体 | 流式；单帧 16 MiB |
| 任务命令 | 64 KiB |
| 超时 | 普通 API 120 s；`images/pull` 620 s；`files/upload`、`files/download`、`files/archive`、`files/extract`、`databases/backups/:id/download` 620 s；备份/恢复异步 |

### 2.7.1 core 代理与 worker 请求体解析

- core 代理路由必须在独立封装插件中注册 catch-all no-op `content-type` parser（不消费 body），route `bodyLimit` 至少 110 MiB；handler 只用 `req.raw` 原始流转发。
- core 不得注册 `@fastify/multipart`；multipart 原样转发，由 worker 解析。
- worker 全局 JSON `bodyLimit=8 MiB`；`PUT /files/write` route `bodyLimit=20 MiB`；`POST /files/upload` 由 `@fastify/multipart` 限制 100 MiB。
- 统一错误映射：`FST_ERR_CTP_BODY_TOO_LARGE`、`FST_ERR_CTP_INVALID_MEDIA_TYPE`、multipart 超限 → `400 BAD_REQUEST`（带 hint）；未知路由 → `404 NOT_FOUND` 信封。不得把 413/415 原样漏给客户端。

### 2.8 裸响应例外（非信封）

1. `GET /healthz` → `{ "ok": true, "status": "ok", "version": "0.1.0", "role": "worker"|"core" }`（无认证）。
2. `GET /api/v1/files/download?...` → 文件字节流，`Content-Disposition: attachment`、`Cache-Control: no-store`；错误仍返回 JSON 信封。
3. `GET /api/v1/databases/backups/:backupId/download` → 同上。
4. 上传请求体是 `multipart/form-data`，响应仍是信封。

## 3. 认证端点

### 3.1 worker

#### `GET /auth/me`

- Auth：Bearer。
- data：`{ authenticated: true, role: 'worker', authType: 'token' }`。

#### `POST /auth/ws-ticket`

- Auth：Bearer。
- Body：`{ path: string }`（必须以 `/ws/` 开头）。
- data：`{ ticket, expiresAt, path }`。
- 错误：`BAD_REQUEST`（path）、`UNAUTHORIZED`。

worker 没有 login/logout/password。

### 3.2 core

#### `POST /auth/login`

- Auth：无。
- Body：`{ username: string; password: string }`。
- data：`{ user: AuthUser; expiresAt: string }`。
- 副作用：`Set-Cookie: <MPANEL_COOKIE_NAME>=<random>; HttpOnly; SameSite=<lax|none|strict>; Path=/; Max-Age=604800[; Secure]`（默认名 `mpanel_session`、`SameSite=Lax`；跨站前端必须 `SameSite=None; Secure` 并配置 CORS）。
- 错误：`BAD_REQUEST`、`UNAUTHORIZED`（`details.retryAfterSec`）。

#### `POST /auth/logout`

- Auth：session/Bearer。
- data：`{ ok: true }`；清除 cookie 与服务器 session（Bearer 为 no-op）。

#### `GET /auth/me`

- Auth：session/Bearer。
- data：`{ authenticated: true, role: 'core', authType: 'session' | 'token', user: AuthUser }`。

#### `POST /auth/ws-ticket`

- Auth：session/Bearer。
- Body：`{ path: string; machineId?: string }`。
- data：`{ ticket, expiresAt, path, machineId?: string | null }`。
- 规则：`path` 以 `/api/v1/machines/<id>/proxy/ws/` 开头时必须提供匹配的 `machineId`；`/ws/` 开头保留给 core 自身 WS；其他 `BAD_REQUEST`。

#### `POST /auth/password`

- Auth：session/Bearer。
- Body：`{ currentPassword: string; newPassword: string }`（new 至少 10 字符）。
- data：`{ ok: true }`；成功后使该用户其他 session 失效（当前 session 保留）。
- 错误：`UNAUTHORIZED`（当前密码错）、`BAD_REQUEST`；`MPANEL_CORE_TOKEN` 静态 Bearer 没有用户密码，返回 `FORBIDDEN`。

```ts
interface AuthUser {
  id: string;
  username: string;
  displayName: string | null;
  role: 'admin' | 'operator';   // v1 权限等价
}
```

## 4. 系统端点

### 4.1 `GET /system/info`

- Auth：需要。
- Query：`refresh?: boolean`（worker）。
- data：

```ts
interface SystemInfo {
  role: 'worker' | 'core';
  name: string;
  version: string;
  apiVersion: 1;
  protocolVersion: 1;
  nodeVersion: string;
  platform: string;
  arch: string;
  hostname: string;
  startedAt: string;
  uptimeSec: number;
  capabilities: Capabilities;
  worker?: WorkerDescriptor;
  features: { dbxHandoff: boolean; websocket: boolean; pty: boolean };
  paths?: {
    home: string;
    caddyConfig?: string;
    caddyData?: string;
    filesRoots?: string[];
    backups?: string;
    stacks?: string;
  };
}

interface CapabilityStatus {
  available: boolean;
  version?: string;
  reason?: string;
  details?: Record<string, unknown>;
}

interface Capabilities {
  caddy: CapabilityStatus;
  docker: CapabilityStatus;
  postgres: CapabilityStatus;
  redis: CapabilityStatus;
  pty: CapabilityStatus;
}

interface WorkerDescriptor {
  name: string;
  version: string;
  apiVersion: number;
  protocolVersion: number;
  nodeVersion: string;
  platform: string;
  arch: string;
  capabilities?: Record<string, unknown>;
}
```

- core 五个能力全 `available:false`，`reason: "feature capabilities are provided by workers"`；`features.pty=false`。
- worker `paths` 只给已认证属主；前端不要写日志。

### 4.2 `GET /system/overview`（仅 core）

- worker 上不存在 → `NOT_FOUND`。
- data：

```ts
interface SystemOverview {
  core: SystemInfo;
  machines: {
    total: number;
    online: number;
    offline: number;
    starting: number;
    degraded: number;
    error: number;
  };
  workers: Machine[];
  generatedAt: string;
}
```

## 5. 机器管理（仅 core）

### 5.1 模型

```ts
type MachineTransport = 'stdio' | 'http' | 'reverse-ws';
type MachineStatus = 'online' | 'offline' | 'starting' | 'degraded' | 'error';
type MachineDesiredState = 'running' | 'stopped';

interface Machine {
  id: string;
  name: string;
  transport: MachineTransport;
  status: MachineStatus;
  enabled: boolean;                    // 配置启用
  desiredState: MachineDesiredState;   // 运行时意图
  endpoint: string | null;             // http: worker URL；reverse-ws: core WS URL；stdio: null
  hasToken: boolean;
  worker: WorkerDescriptor | null;
  capabilities: Capabilities | null;
  lastSeenAt: string | null;
  lastError: string | null;
  reconnectAttempts?: number;
  createdAt: string;
  updatedAt: string;
}

interface MachineHealth {
  machineId: string;
  status: MachineStatus;
  lastSeenAt: string | null;
  latencyMs?: number | null;
  consecutiveFailures: number;
  lastError?: string | null;
  checkedAt: string;
}
```

- 凭据/命令/env/secret 永不返回；`endpoint` 对 stdio 为 null。
- effective running = `enabled && desiredState==='running'`。
- 状态：`starting` 启动/注册中；`online` 心跳/健康 ≤15s；`degraded` 心跳 15–30s 或 HTTP 1–2 次失败/能力部分失败；`offline` 心跳超时 30s、HTTP 连续 3 次失败或无连接；`error` spawn/认证/版本/连续错误。

### 5.2 端点

| 方法 | 路径 | Query / Body | data |
|---|---|---|---|
| GET | `/machines` | `status?`、`transport?`、`q?`、分页；默认 `createdAt asc` | `ListResult<Machine>`（`available:true`） |
| POST | `/machines` | `MachineCreateInput`，见下；201 | `MachineCreateResult` |
| GET | `/machines/:id` | — | `Machine` |
| PATCH | `/machines/:id` | `MachineUpdateInput`（至少一项） | `Machine` |
| DELETE | `/machines/:id` | — | `{ deleted: true }` |
| POST | `/machines/:id/connect` | — | `Machine`（desiredState=running） |
| POST | `/machines/:id/disconnect` | — | `Machine`（desiredState=stopped，隧道不自动重连） |
| POST | `/machines/:id/test` | — | `MachineTestResult`（失败也 200） |
| GET | `/machines/:id/health` | — | `MachineHealth` |
| POST | `/machines/:id/secret/rotate` | — | `{ secret: string, workerEnv: Record<string,string> }`（仅 reverse-ws） |

#### 创建

```ts
type MachineCreateInput =
  | { name: string; enabled?: boolean; transport: 'http'; url: string; token: string }
  | {
      name: string;
      enabled?: boolean;
      transport: 'stdio';
      command?: string;          // 默认 process.execPath
      args?: string[];           // 默认 [MPANEL_AGENT_ENTRY]
      env?: Record<string, string>;
      token: string;
    }
  | { name: string; enabled?: boolean; transport: 'reverse-ws' };

interface MachineCreateResult {
  machine: Machine;
  enrollment?: MachineEnrollment;   // 仅 reverse-ws，secret 只出现一次
}

interface MachineEnrollment {
  machineId: string;
  url: string;                       // wss://core/ws/worker
  secret: string;                    // mp_... 一次性
  workerEnv: Record<string, string>; // MPANEL_CORE_URL / MPANEL_MACHINE_ID / MPANEL_MACHINE_SECRET / MPANEL_TOKEN / MPANEL_AGENT_TRANSPORT
}
```

- 创建时 `desiredState` 默认 `running`。
- http：保存 URL + 加密 token；`enabled=true` 时立即探测，失败不阻止创建（status=error）。
- stdio：需 `MPANEL_ALLOW_STDIO=1`，否则 `FORBIDDEN`；core 强制注入 `MPANEL_AGENT_TRANSPORT=stdio`、`MPANEL_TOKEN`、`MPANEL_AGENT_BASE_DIR`（默认 `$CORE_HOME/machines/<id>`）；用户 env 不能覆盖保留键；未配置 `MPANEL_AGENT_ENTRY` 且未提供 args → `BAD_REQUEST`；`enabled=true` 时自动 spawn。
- reverse-ws：core 生成 machine secret（只存 SHA-256）和一个独立 `MPANEL_TOKEN`（加密存储，仅用于 worker loopback）；不主动连接，等待拨号；`enrollment.url` 由 `MPANEL_PUBLIC_URL` 推导，未配置时用请求 Host/`X-Forwarded-Proto`。

#### 更新

```ts
{
  name?: string;
  enabled?: boolean;
  url?: string;        // http
  token?: string;      // http/stdio，写后不回显
  command?: string;    // stdio
  args?: string[];     // stdio
  env?: Record<string,string>; // stdio
  group?: string | null;       // 分组（边缘与普通机器都可用；v1 加法字段）
}
```

- 不允许改变 `transport`；换传输请新建。
- `enabled=false` 强制停机；`enabled=true` 且 desiredState=running 时重连。
- `PATCH` 不修改 `desiredState`；connect/disconnect 才修改。

#### 连接/断开/测试

- `POST /connect`：`enabled=false` → `CONFLICT`；成功后 desiredState=running。
  - http：立即 `GET /api/v1/system/info` 探测。
  - stdio：spawn（未运行）并等待 hello，超时 15s → `UPSTREAM_ERROR`。
  - reverse-ws：不主动拨号；返回当前 Machine。
- `POST /disconnect`：desiredState=stopped 并关闭连接；stdio 终止后不自动重启；reverse-ws 关闭后 core 拒绝该机器重连（worker 重试得到 401/403），直到 `connect`。
- `POST /test` data：

```ts
interface MachineTestResult {
  reachable: boolean;
  latencyMs?: number | null;
  info?: SystemInfo | null;
  error?: string;
}
```

  测试失败仍 200；内部异常才 5xx。
- `GET /health` 返回快照，不主动探测。

#### secret 轮换

- 仅 reverse-ws；其他 `BAD_REQUEST`。
- data `{ secret, workerEnv }`（workerEnv 含新 `MPANEL_MACHINE_SECRET` 与现有 `MPANEL_TOKEN`）。
- 关闭现有 reverse 连接，旧 secret 立即失效；UI 提示只显示一次。

### 5.3 代理端点

#### `ANY /machines/:machineId/proxy/*`

- Auth：core session/Bearer（§8.4 handoff 例外）。
- 路径映射 §2.5；请求/响应流式；客户端断开取消上游。
- 机器不存在 → `NOT_FOUND`；disabled/offline/stopped → `503 UNAVAILABLE`；网络失败 → `502 UPSTREAM_ERROR`。
- 透传业务 envelope；worker 401/403 转 `UPSTREAM_ERROR`；worker 非 envelope 5xx 包装。

#### `WS /machines/:machineId/proxy/ws/*`

- 完整路径 `/api/v1/machines/:id/proxy/ws/...?ticket=...`。
- Auth：core ticket（machineId 匹配）或 core Bearer；升级前检查 online，否则 503/401 或 close `4502`。
- 消息按 worker 原生 WS 协议透传；关闭码透传；core 故障 close `1011`。

### 5.4 边缘节点（仅 core）

边缘节点是 **NAT/防火墙后主动外拨的 reverse-ws 机器**：不需要预建机器，用一个共享的
**入网密钥（edge key）** 自助注册，注册后与普通 reverse-ws 机器完全同构（同一套 `/ws/worker`
握手、同一套代理路径）。设计参考 Portainer 的 Edge Compute，但只保留入网、分组、快照、
离线异步作业四件事。

#### 模型

```ts
interface EdgeKey {
  id: string;
  name: string;
  group: string | null;        // 入网机器自动继承
  expiresAt: string | null;    // null = 不过期
  maxUses: number;             // 0 = 不限次数
  uses: number;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

type EdgeJobKind = 'snapshot' | 'run-task' | 'apply-site';
type EdgeJobStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'canceled';

interface EdgeJob {
  id: string;
  machineId: string;
  kind: EdgeJobKind;
  payload: Record<string, unknown>;
  status: EdgeJobStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  httpStatus: number | null;
  result: unknown;             // 响应 data 截断至 16KB
  error: string | null;
}

interface SystemSnapshot {
  collectedAt: string;
  hostname: string;
  platform: string;            // linux | win32 | darwin
  arch: string;
  release: string;
  nodeVersion: string;
  workerVersion: string;
  uptimeSec: number;
  cpuCount: number;
  loadavg: [number, number, number] | null;  // Windows 为 null
  memTotalBytes: number;
  memFreeBytes: number;
  diskTotalBytes: number | null;
  diskFreeBytes: number | null;
  ips: string[];
  transport: string;
  pty: boolean;
}
```

`Machine` 增加以下字段（向后兼容，缺省为 `false`/`null`）：

```ts
interface Machine {
  // …既有字段…
  edge: boolean;                       // 由 edge key 自助入网
  group: string | null;                // 边缘分组（普通机器也可打组）
  edgeKeyId: string | null;
  snapshot: SystemSnapshot | null;     // core 定期刷新的节点快照
}
```

#### 端点

| 方法 | 路径 | Query / Body | data |
|---|---|---|---|
| POST | `/edge/enroll` | `{ key, name?, platform, arch, version }` | `{ machine: Machine, secret, wsUrl }`（**免登录**，凭 key；限流 10 次/分钟/IP） |
| GET | `/edge/keys` | — | `ListResult<EdgeKey>` |
| POST | `/edge/keys` | `{ name, group?, ttlSec?, maxUses? }` | `{ key: EdgeKey, secret }`（secret 只出现一次） |
| DELETE | `/edge/keys/:id` | — | `{ revoked: true }` |
| GET | `/edge/jobs` | `machineId?`、`status?`、分页 | `ListResult<EdgeJob>` |
| POST | `/edge/jobs` | `{ machineId, kind, payload }` | `EdgeJob`（201） |
| GET | `/edge/jobs/:id` | — | `EdgeJob` |
| DELETE | `/edge/jobs/:id` | — | `{ deleted: true }`（仅 `pending`） |

#### 语义

- **入网**：key 必须存在、未吊销、未过期、`uses < maxUses`（`maxUses=0` 不限）。校验通过后
  自动创建 `transport='reverse-ws'` 的机器（`edge=true`、`group` 继承 key、`edgeKeyId` 记录来源、
  `name` 缺省 `<platform>-<6位>`），并返回一次性的 machine secret 与 ws 地址；worker 之后用
  `MPANEL_MACHINE_SECRET` 拨 `/ws/worker`，走既有握手，**不新增任何隧道帧**。
  审计追加 `edge.enroll`（含 keyId、machineId、IP）。同一 key 的入网机器数受 `maxUses`
  约束；达到上限返回 `FORBIDDEN`。
- **快照**：core 对 online 的边缘节点每 5 分钟请求 `GET /system/snapshot` 写入 `machine.snapshot`；
  节点上线时立即取一次。失败保留上一份快照并记 `lastError`。
- **作业**：三种 kind 固定映射到 worker 的既有端点——`snapshot` → `GET /system/snapshot`；
  `run-task` → `POST /tasks/:id/run`（`payload.taskId`）；`apply-site` → `POST /sites/apply`
  （`payload.siteId`，请求体 `{ siteIds: [siteId] }`；worker §6.2 没有 `/sites/:id/apply`）。
  节点离线时保持 `pending`，上线后按 `createdAt` 顺序**串行**执行；
  客户端断开或节点再次离线时置回 `pending`（不计入重试）；网络类失败最多重试 1 次，
  业务 4xx 直接 `failed`。`result` 为响应 `data` 的 JSON，超过 16KB 截断并标记
  `{ truncated: true }`。
- **列表**：沿用 §2.3 的 `{ available: true, items, total }`；边缘接口在 core 中恒可用。

### 5.5 边缘节点在 worker 侧的两个支撑端点

以下端点在 worker 上实现，core 通过代理或边缘作业调用：

| 方法 | 路径 | data |
|---|---|---|
| GET | `/system/snapshot` | `SystemSnapshot`（`transport` 为当前 worker 传输模式） |
| GET | `/system/metrics` | `{ collectedAt, cpuPercent, cpuCount, loadavg, memTotalBytes, memFreeBytes, diskTotalBytes, diskFreeBytes, uptimeSec }` |

- `cpuPercent` 为 200ms 采样的整机使用率（0–100），采样失败返回 `null`。
- `diskTotalBytes`/`diskFreeBytes` 取 `MPANEL_AGENT_BASE_DIR` 所在文件系统；不可得时 `null`。
- 两者都不得因缺少外部命令而失败。

## 6. 站点（Caddy）

### 6.1 模型

```ts
type SiteStatus = 'draft' | 'pending' | 'applied' | 'error' | 'disabled';

interface Site {
  id: string;
  name: string;
  enabled: boolean;
  config: SiteConfig;
  revision: number;              // 站点级版本，每次本站点写 +1
  appliedRevision: number | null; // 最近成功 apply 时的本站点 revision
  status: SiteStatus;
  lastApply: {
    at: string;
    ok: boolean;
    revision: number;            // 全局 apply 序号，不是站点 revision
    error?: string;
    caddyfileHash?: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}

interface SiteConfig {
  domains: string[];                 // 1..50，hostname/localhost/前导 *.
  listen?: string[];                 // Caddy bind 地址
  handler:
    | {
        type: 'reverse_proxy';
        upstreams: string[];        // 禁止空白、引号、花括号、控制字符
        loadBalance?: 'round_robin' | 'random' | 'least_conn' | 'uri_hash';
        headers?: Record<string, string>;  // RFC token 名；值禁止控制字符
        websocket?: boolean;
        tlsSkipVerify?: boolean;
        healthUri?: string;          // 禁止空白/引号/花括号/控制字符
      }
    | {
        type: 'file_server';
        root: string;               // 绝对宿主路径，必须在 MPANEL_SITES_ROOTS 内
        indexNames?: string[];
        browse?: boolean;
        spa?: boolean;
        precompressed?: ('gzip' | 'zstd')[];
      }
    | {
        type: 'redirect';
        to: string;
        permanent?: boolean;
        preserveQuery?: boolean;
      };
  tls?: { mode: 'auto' | 'internal' | 'off'; email?: string };
  headers?: Record<string, string>;   // RFC token 名；值禁止控制字符
  encode?: ('gzip' | 'zstd')[];
  log?: boolean;
}
```

状态（worker 每次返回时计算）：

| status | 条件 |
|---|---|
| `disabled` | `enabled=false` |
| `error` | `lastApply.ok=false` |
| `draft` | `appliedRevision=null` 且从未尝试 apply |
| `pending` | `appliedRevision !== revision` |
| `applied` | `appliedRevision === revision` 且最近 apply 成功 |

所有进入 Caddyfile 的字符串必须通过 shared zod schema，并在生成器内再次经 `quoteCaddyToken()`：拒绝所有控制字符、未校验的空白/引号/花括号；preview 与 apply 必须走同一生成/校验路径。原始 Caddyfile 导入不支持。

### 6.2 端点

| 方法 | 路径 | Query / Body | data |
|---|---|---|---|
| GET | `/sites` | `enabled?`, `q?`, 分页 | `ListResult<Site>`，默认 `updatedAt desc` |
| POST | `/sites` | `{ name, enabled?, config }` | `Site`，201 |
| GET | `/sites/:id` | — | `Site` |
| PUT | `/sites/:id` | `{ name?, enabled?, config? }`（至少一项） | `Site`（revision+1；不自动 apply） |
| DELETE | `/sites/:id` | — | `{ deleted: true, pendingApply: true }` |
| POST | `/sites/preview` | `{ site?, siteId?, validate? }` 恰好一个 | `SitePreviewResult` |
| POST | `/sites/apply` | `{ siteIds?, force? }` | `SiteApplyResult` |
| GET | `/sites/export` | — | `SiteExportBundle` |
| POST | `/sites/import` | `{ bundle, mode?: 'merge'\|'replace' }` | `SiteImportResult` |

- 名称唯一 → `CONFLICT`；站点内域名重复 `BAD_REQUEST`。
- 修改只改 JSON 草稿；删除已应用站点需全量 apply 才从 Caddy 移除。
- 根目录若不在 `MPANEL_SITES_ROOTS` → `BAD_REQUEST`。

### 6.3 Preview

```ts
{ site?: SiteConfig; siteId?: string; validate?: boolean }
```

```ts
interface SitePreviewResult {
  caddyfile: string;
  warnings: string[];
  validation: { ok: boolean; output: string } | null;
  validationUnavailableReason?: string;
}
```

- `siteId` 不存在 → `NOT_FOUND`；同时给 site/siteId → `BAD_REQUEST`。
- caddy 不可用：仍返回片段，validation=null + reason，不返回 503。
- 不写线上目录、不改 revision。

### 6.4 Apply

```ts
// 请求
{ siteIds?: string[]; force?: boolean }
// siteIds 省略 = 全量：渲染所有 enabled 站点，删除 sites.d 中已不存在站点的片段。
// siteIds 给定 = 只把这些站点的当前草稿渲染进 staging；未选中站点保留现有 sites.d 片段；
//               未选中站点的 revision/appliedRevision 不变；删除站点清理必须全量 apply。
// force=true 即使无 revision 变化也重写。
```

```ts
interface SiteApplyResult {
  revision: number;             // 全局 apply 序号
  appliedAt: string;
  caddyfilePath: string;
  backupPath: string | null;
  reloaded: boolean;
  rolledBack: boolean;
  sites: { id: string; name: string; status: SiteStatus }[]; // 本次实际渲染/尝试的站点
  warnings: string[];
  caddyOutput: string;
}
```

流程/错误：

1. 已有 apply → `409 CONFLICT`（`details.retryAfterMs`）。
2. staging 生成失败 → `400 BAD_REQUEST`（`stage='render'`）。
3. `caddy validate` 失败 → `400 BAD_REQUEST`（`stage='validate'`、`output`）；线上不变。
4. 备份/替换/`caddy reload` 失败 → 恢复备份并重载；`502 UPSTREAM_ERROR`（`stage='reload'`、`rolledBack=true`）；恢复也失败 → `500 INTERNAL`。
5. 成功：每个本次渲染站点 `appliedRevision=当前站点 revision`、`lastApply.revision=全局 apply 序号`、`lastApply.ok=true`。
6. caddy 不可用 → `503 UNAVAILABLE`；不生成 staging。
7. `siteIds` 不存在 → `NOT_FOUND`。

### 6.5 Export / Import

```ts
interface SiteExportBundle {
  version: 1;
  exportedAt: string;
  sites: { name: string; enabled: boolean; config: SiteConfig }[];
}
```

- 导出全部站点（含 disabled），不含 id/revision/运行状态。
- 导入先整体 zod 校验；任何无效 → `400 BAD_REQUEST`，不写入（原子）。
- `merge`（默认）：同名跳过计 `skipped`，其余创建；不修改同名。
- `replace`：删除全部现有站点（仅 JSON）再创建。
- 不自动 apply；运行中的 Caddy 不变。

## 7. 证书（只读）

```ts
type CertificateStatus = 'valid' | 'expiring' | 'expired' | 'unknown';

interface CertificateInfo {
  id: string;                    // SHA-256 指纹 hex
  domains: string[];
  commonName: string | null;
  issuer: string;
  subject: string;
  notBefore: string;
  notAfter: string;
  daysRemaining: number;         // floor((notAfter-now)/86400000)，可为负
  serialNumber: string;
  fingerprintSha256: string;
  keyType: string | null;
  source: 'local' | 'acme' | 'unknown';
  path: string;
  status: CertificateStatus;     // expired <0；expiring <=14；其余 valid
}
```

| 方法 | 路径 | Query | data |
|---|---|---|---|
| GET | `/certs` | `domain?`, `status?`, `includeExpired?`(默认 true), 分页 | `ListResult<CertificateInfo>`，默认 `notAfter asc` |
| GET | `/certs/:id` | — | `CertificateInfo` |

- 可用性：`MPANEL_CADDY_DATA_DIR` 可读；不存在/不可读 → `available=false`。caddy 二进制缺失不影响。
- 扫描 `certificates/**/*.{crt,pem}`，只解析 X509，不读私钥；解析失败跳过并 warning。
- 不提供手动续期/删除。

## 8. 数据库档案

### 8.1 模型

```ts
type DatabaseKind = 'postgres' | 'redis';

interface DatabaseProfile {
  id: string;
  name: string;
  kind: DatabaseKind;
  host: string;
  port: number;                 // pg 默认 5432；redis 默认 6379
  username: string | null;
  database: string | null;
  tls: boolean;                 // pg sslmode=require；redis TLS
  redisDb: number | null;       // 0..15；postgres 为 null
  hasPassword: boolean;
  lastCheck: {
    at: string; ok: boolean; latencyMs: number;
    serverVersion?: string; message?: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}
```

- 密码只写不读；API 永不返回密码/密文（handoff redeem 是唯一例外）。
- 档案可先创建；列表始终可用（JSON 存储）。

### 8.2 档案端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/databases/profiles` | `kind?`、`q?`、分页；`ListResult<DatabaseProfile>`，默认 `name asc` |
| POST | `/databases/profiles` | 创建，201，body 见下 |
| GET | `/databases/profiles/:id` | 详情 |
| PATCH | `/databases/profiles/:id` | 更新（password `null` 清除） |
| DELETE | `/databases/profiles/:id` | 删除；运行中 job → `CONFLICT`；备份保留 |

```ts
// POST
{
  name: string;
  kind: 'postgres' | 'redis';
  host: string;
  port?: number;
  username?: string;
  password?: string;        // 写-only
  database?: string;        // postgres
  tls?: boolean;
  redisDb?: number;         // redis
}
```

- 名称唯一 → `CONFLICT`；`redisDb` 仅 redis、`database` 仅 postgres，否则 `BAD_REQUEST`。

### 8.3 测试与统计

#### `POST /databases/profiles/:id/test`

```ts
interface DatabaseTestResult {
  ok: boolean;
  latencyMs: number;
  serverVersion?: string;
  message?: string;
}
```

- 连接失败返回 200 + ok:false，并更新 `lastCheck`。
- 驱动/工具缺失 → `503 UNAVAILABLE`；目标不可达不是能力问题。

#### `GET /databases/profiles/:id/stats`

```ts
type DatabaseStats = PostgresStats | RedisStats;

interface PostgresStats {
  kind: 'postgres';
  version: string;
  uptimeSec: number;
  connections: { total: number; active: number; idle: number; idleInTransaction: number };
  databaseSizeBytes: number;
  cacheHitRatio: number | null;
  transactionsPerSec?: number | null;
}

interface RedisStats {
  kind: 'redis';
  version: string;
  uptimeSec: number;
  role: 'master' | 'replica' | 'sentinel' | 'unknown';
  connectedClients: number;
  usedMemoryBytes: number;
  maxMemoryBytes: number | null;
  opsPerSec: number | null;
  keyspace: { db: number; keys: number; expires: number }[];
}
```

- 目标不可达/查询失败 → `502 UPSTREAM_ERROR`；不更新 `lastCheck`。

### 8.4 dbx handoff

#### `POST /databases/profiles/:id/handoff`

- Auth：需要。
- Body：`{ ttlSec?: number }`（10–300，默认 60）。
- data：

```ts
interface HandoffTicket {
  ticket: string;          // 32 字节随机 base64url；只放请求体，不放 URL
  expiresAt: string;
  redeemUrl: string;       // 固定 "/databases/handoff/redeem"（相对 API feature base）
  kind: 'postgres' | 'redis';
}
```

- ticket 存在 worker 内存 Map；一次性、绑定 profile、TTL 清理；worker 重启失效。
- 前端解析：`redeemUrl` 以 `http` 开头直接用；否则 `basePath + redeemUrl`。直连 worker `/api/v1/databases/handoff/redeem`；core `/api/v1/machines/<id>/proxy/databases/handoff/redeem`。
- 给 dbx 的 iframe 建议把 ticket 放 URL fragment（`#handoff=<ticket>&endpoint=<encodeURIComponent(redeemUrl)>`），fragment 不进服务器 access log；dbx 读取后 POST JSON body。不要把 ticket 拼进 path/query。

#### `POST /databases/handoff/redeem`

- Auth：**无**；body ticket 是凭据（256-bit、一次性、60s）。
- CORS：仅 `MPANEL_DBX_ORIGIN`；无 credentials。
- Body：`{ ticket: string }`。
- data：

```ts
interface HandoffRedeemRequest { ticket: string; }

interface HandoffPayload {
  profileId: string;
  name: string;
  kind: 'postgres' | 'redis';
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  database: string | null;
  tls: boolean;
  redisDb: number | null;
  connectionString?: string;   // 含密码，仅此响应
}
```

- 统一信封；`Cache-Control: no-store`、`Pragma: no-cache`。
- 无效/过期/已用 → `404 NOT_FOUND`；原子消费。
- 限速：默认 10/min（`MPANEL_REDEEM_RATE_LIMIT`），超限 `401 UNAUTHORIZED` + `details.retryAfterSec`。worker 与 core 代理都启用。
- 日志/审计禁止记录 body、ticket 原文、带 secret 的 URL；只允许 ticket SHA-256 前 8 位、profileId、结果、来源 IP。
- core 只对精确 `POST /api/v1/machines/:id/proxy/databases/handoff/redeem` 跳过 session；其余代理仍需认证。
- worker 不执行 SQL/Redis 查询；dbx 负责 UI。

### 8.5 备份与恢复

```ts
type BackupFormat = 'custom' | 'plain' | 'rdb' | 'logical';

interface BackupRecord {
  id: string;
  profileId: string;
  kind: DatabaseKind;
  format: BackupFormat;
  label?: string | null;
  fileName: string;
  sizeBytes: number;
  status: 'running' | 'success' | 'failed';
  createdAt: string;
  finishedAt?: string | null;
  error?: string | null;
}

interface DatabaseJob {
  id: string;
  profileId: string;
  type: 'backup' | 'restore';
  status: 'queued' | 'running' | 'success' | 'failed';
  backupId?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  progress?: string | null;
  error?: string | null;
}
```

| 方法 | 路径 | Body / Query | 状态 | data |
|---|---|---|---|---|
| POST | `/databases/profiles/:id/backup` | `{ format?, label? }` | 202 | `{ job: DatabaseJob }` |
| GET | `/databases/profiles/:id/backups` | 分页 | 200 | `ListResult<BackupRecord>`，默认 `createdAt desc` |
| POST | `/databases/profiles/:id/restore` | `{ backupId, confirm: true }` | 202 | `{ job: DatabaseJob }` |
| GET | `/databases/backups/:backupId` | — | 200 | `BackupRecord` |
| DELETE | `/databases/backups/:backupId` | — | 200 | `{ deleted: true }` |
| GET | `/databases/backups/:backupId/download` | — | 200 | 裸二进制 |
| GET | `/databases/jobs` | `profileId?`, `status?`, 分页 | 200 | `ListResult<DatabaseJob>` |
| GET | `/databases/jobs/:jobId` | — | 200 | `DatabaseJob` |

- 格式：postgres 默认 `custom`（可选 `plain`）；redis 默认 `logical`（ioredis SCAN/DUMP + RESTORE，可在线恢复），可选 `rdb`（redis-cli --rdb，只能离线恢复）。不匹配 → `BAD_REQUEST`。
- 同 profile 同时只允许一个 job → `409 CONFLICT`。
- postgres：`pg_dump --format=custom|plain --no-password`，密码走 `PGPASSWORD`；恢复 `pg_restore --clean --if-exists --no-owner` 或 `psql -f`。
- redis `logical`：逐 key DUMP/RESTORE，特殊模块 key 跳过并 warning。`rdb` 的 restore → `503 UNAVAILABLE` + hint。
- 文件在 `$MPANEL_AGENT_BASE_DIR/backups/databases/<profileId>/`；下载校验记录与路径前缀。
- restore 只接受属于该 profile 且 success 的备份；`confirm:true` 必填。
- 作业异步；worker 重启把遗留 queued/running 标 failed（`worker restarted`），不续跑。

## 9. 容器、镜像与编排

### 9.1 模型

```ts
interface ContainerPort {
  ip?: string;
  privatePort: number;
  publicPort?: number;
  type: 'tcp' | 'udp' | 'sctp';
}

interface ContainerSummary {
  id: string;
  names: string[];
  image: string;
  imageId?: string;
  command?: string;
  created: string;
  state: string;
  status: string;
  ports: ContainerPort[];
  labels: Record<string, string>;
  composeProject?: string | null;
  composeService?: string | null;
}

interface ContainerDetail extends ContainerSummary {
  env: string[];
  mounts: { type: string; source?: string; destination: string; mode?: string; rw: boolean }[];
  restartPolicy?: string;
  platform?: string;
  networkMode?: string;
  health?: string | null;
}

interface ContainerStats {
  cpuPercent: number;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  memoryPercent: number;
  networkRxBytes: number;
  networkTxBytes: number;
  blockReadBytes: number;
  blockWriteBytes: number;
  pids: number;
  readAt: string;
}

interface ImageSummary {
  id: string;
  repoTags: string[];
  repoDigests: string[];
  sizeBytes: number;
  createdAt: string;
  labels: Record<string, string>;
  dangling: boolean;
}

interface StackSummary {
  name: string;                 // ^[a-z0-9][a-z0-9_-]{0,62}$
  status: string;
  configFiles: string[];
  containerCount: number;
  runningCount: number;
  updatedAt?: string | null;
}

interface StackDetail extends StackSummary {
  composePath: string;
  composeYaml: string;
  containers: ContainerSummary[];
}
```

### 9.2 容器端点

| 方法 | 路径 | Query / Body | data |
|---|---|---|---|
| GET | `/containers` | `all?`(默认 false)、`status?`、`q?`、分页 | `ListResult<ContainerSummary>`，默认 `created desc` |
| GET | `/containers/:id` | — | `ContainerDetail` |
| POST | `/containers/:id/start` | — | `{ ok:true, action:'start', id }` |
| POST | `/containers/:id/stop` | `{ timeoutSec?: 0..600 }` | `{ ok:true, action:'stop', id }` |
| POST | `/containers/:id/restart` | `{ timeoutSec?: 0..600 }` | `{ ok:true, action:'restart', id }` |
| DELETE | `/containers/:id` | `force?`, `removeVolumes?` | `{ removed:true, id }` |
| GET | `/containers/:id/logs` | `tail?`(0..10000), `since?`, `timestamps?`, `stdout?`, `stderr?` | `{ logs: string, truncated: boolean }` |
| GET | `/containers/:id/stats` | — | `{ stats: ContainerStats }` |
| POST | `/containers/:id/exec` | `{ command: string[], timeoutMs?, workdir?, user? }` | `ExecResult` |

```ts
interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
}
```

- 容器 id/name 校验 `^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`；`docker exec` 参数数组，不经 shell。
- exec 每流 1 MiB、默认 30s（最大 300s）；超时 kill 返回 exitCode:null + truncated。
- logs 非流最多 1 MiB；docker 不可用 → `UNAVAILABLE`。

#### 容器日志流 WS

`WS /ws/containers/:id/logs?ticket=...&tail=200&follow=1&timestamps=1&stdout=1&stderr=1`

- 客户端→服务器：`{ "type": "close" }`。
- 服务器→客户端：

```ts
| { type: 'log'; stream: 'stdout' | 'stderr'; data: string; ts?: string }
| { type: 'end' }
| { type: 'error'; code: string; message: string }
```

- `follow=0` 发完 tail 后 `end` 并 close 1000；`follow=1` 持续到容器退出/客户端 close。
- 不存在 → close `4404`；docker 不可用 → `4502`。

### 9.3 镜像端点

| 方法 | 路径 | Query / Body | data |
|---|---|---|---|
| GET | `/images` | `all?`、`dangling?`、`q?`、分页 | `ListResult<ImageSummary>` |
| POST | `/images/pull` | `{ reference }` | `{ image: ImageSummary }`，同步 620s |
| DELETE | `/images/:id` | `force?` | `{ deleted:true, id }` |
| POST | `/images/prune` | `{ danglingOnly? }` | `{ deleted:number, reclaimedBytes:number }` |

- reference 不允许空白/以 `-` 开头；pull 同步，core/web 对该路由 620s 超时。

### 9.4 编排端点

| 方法 | 路径 | Query / Body | data |
|---|---|---|---|
| GET | `/stacks` | 分页 | `ListResult<StackSummary>`，默认 `name asc` |
| POST | `/stacks` | `{ name, composeYaml }` | `StackDetail`，201；只写文件 |
| GET | `/stacks/:name` | — | `StackDetail` |
| PUT | `/stacks/:name` | `{ composeYaml }` | `StackDetail`；只写文件 |
| POST | `/stacks/:name/up` | `{ build?, forceRecreate? }` | `{ ok:true, output:string }` |
| POST | `/stacks/:name/down` | `{ removeVolumes?, removeImages? }` | `{ ok:true, output:string }` |
| POST | `/stacks/:name/restart` | `{}` | `{ ok:true, output:string }` |
| DELETE | `/stacks/:name` | `force?` | `{ deleted:true, name }` |

- 文件固定在 `$MPANEL_AGENT_BASE_DIR/stacks/<name>/compose.yaml`；名称正则防穿越。
- 创建/更新先 `docker compose -f <tmp> config` 校验；失败 `400 BAD_REQUEST`（`output`）。
- 运行中的栈删除需先 down 或 `force=true`（force 只删文件不停止容器）。
- Compose YAML 是可信属主功能（可挂载宿主/privileged），不向非属主开放。

### 9.5 网络与守护进程配置

```ts
interface ContainerNetwork {
  id: string;
  name: string;
  driver: string;
  scope: string;
  internal: boolean;
  attachable: boolean;
  ipv6: boolean;
  labels: Record<string, string>;
  createdAt?: string | null;
}

interface ContainerNetworkMember {
  id: string;
  name: string;
  ipv4Address?: string;
  ipv6Address?: string;
}

interface ContainerNetworkDetail extends ContainerNetwork {
  subnet?: string | null;
  gateway?: string | null;
  ipRange?: string | null;
  containers: ContainerNetworkMember[];
}

interface RegistryAuth {
  registry: string;      // 如 https://index.docker.io/v1/
  username: string;      // 只回显用户名，绝不返回凭据
}

interface ContainerDaemonConfig {
  daemonPath: string;            // 默认 /etc/docker/daemon.json
  daemonJson: string;            // 文件原文；不存在时为 "{}"
  registryMirrors: string[];     // daemon.json 的 registry-mirrors
  insecureRegistries: string[];  // daemon.json 的 insecure-registries
  auths: RegistryAuth[];         // 运行用户 docker config 中的登录项
  dockerConfigPath?: string | null;
  credentialStore?: string | null;
}
```

| 方法 | 路径 | Query / Body | data |
|---|---|---|---|
| GET | `/containers/networks` | 分页 | `ListResult<ContainerNetwork>`，默认 `name asc` |
| POST | `/containers/networks` | `{ name, driver?, subnet?, gateway?, internal?, attachable? }` | `ContainerNetworkDetail`，201 |
| GET | `/containers/networks/:name/inspect` | — | `ContainerNetworkDetail` |
| DELETE | `/containers/networks/:name` | — | `{ deleted:true, name }` |
| GET | `/containers/config` | — | `ContainerDaemonConfig` |
| PUT | `/containers/config` | `{ daemonJson }` | `ContainerDaemonConfig` |

- 网络名称沿用容器引用正则 `^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`；`driver` 只允许
  `bridge|overlay|macvlan|ipvlan`（缺省 `bridge`）；`subnet` 必须是 CIDR，`gateway` 必须落在
  `subnet` 内。预定义网络 `bridge|host|none` 不可删除；仍有容器接入时删除 → `CONFLICT`，
  `details.hint` 提示先断开容器。
- 网络列表与写操作依赖 docker daemon：列表不可用返回 `{available:false,reason,items:[]}`，
  写操作 → `503 UNAVAILABLE`。
- daemon 配置路径由 agent 配置 `docker_config`（`MPANEL_DOCKER_CONFIG`）指定，默认
  `/etc/docker/daemon.json`。文件不存在视为 `{}`；读失败 → `UNAVAILABLE`。
- `PUT /containers/config`：`daemonJson` 上限 1 MiB，必须是 JSON 对象；对已知键做类型校验
  （`registry-mirrors`/`insecure-registries` 为字符串数组，`data-root`/`log-driver`/`storage-driver`
  为字符串），不合法 → `BAD_REQUEST`。写入用同目录 tmp + rename，权限 `0644`，拒绝符号链接目标；
  不重启 Docker，需在守护进程重启后生效。
- `auths` 读取运行用户的 `$DOCKER_CONFIG/config.json` 或 `~/.docker/config.json`，只返回
  registry 与用户名；凭据本身永不进入响应、日志或审计。

## 10. 文件

### 10.1 模型

```ts
interface FileRoot {
  name: string;        // ^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$
  path: string;        // 绝对宿主路径
  writable: boolean;
  freeBytes?: number | null;
  totalBytes?: number | null;
}

interface FileItem {
  name: string;
  root: string;
  path: string;        // 根内 POSIX 虚拟路径，以 / 开头
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  mtime: string;
  ctime: string;
  mode: string;
  readonly: boolean;
  isSymlink: boolean;
  targetType?: 'file' | 'directory' | 'symlink' | 'other' | null;
}

interface FileReadResult {
  content: string;
  encoding: 'utf8' | 'base64';
  size: number;
  truncated: boolean;
  mtime: string;
  isBinary: boolean;
}
```

路径规则：

- `root` 必填，来自 `/files/roots`。
- `path` 为根内虚拟路径（可带前导 `/`，POSIX 分隔符）；拒绝 NUL/控制字符、反斜杠、盘符、UNC、`..` 段。
- 所有访问先 realpath 根，再解析目标；最终路径必须在根内。符号链接用于写操作 → `BAD_REQUEST`。
- 终端 cwd、任务 cwd、Caddy root 使用独立的 `hostPathSchema`（宿主路径），不得混用文件虚拟路径。
- 不可读/不存在 → `NOT_FOUND`；权限 → `FORBIDDEN`。

### 10.2 端点

| 方法 | 路径 | Query / Body | data |
|---|---|---|---|
| GET | `/files/roots` | — | `ListResult<FileRoot>` |
| GET | `/files/list` | `root`, `path?`, `showHidden?`, `limit`, `cursor` | `FileListResult` |
| GET | `/files/stat` | `root`, `path` | `FileItem` |
| GET | `/files/read` | `root`, `path`, `encoding?`, `maxBytes?`(1..8MiB，默认 1MiB) | `FileReadResult` |
| PUT | `/files/write` | `{ root,path,content,encoding?,create?,overwrite?,expectedMtime? }` | `FileItem` |
| POST | `/files/mkdir` | `{ root,path,recursive?,mode? }` | `FileItem` |
| POST | `/files/rename` | `{ root,from,to,overwrite? }` | `FileItem` |
| POST | `/files/copy` | `{ root,from,to,overwrite? }` | `FileItem` |
| POST | `/files/chmod` | `{ root,path,mode }` | `FileItem` |
| DELETE | `/files` | `root`, `path`, `permanent?`(默认 false) | `{ trashed:boolean, trashId?:string, path:string }` |
| GET | `/files/trash` | 分页 | `ListResult<TrashEntry>` |
| POST | `/files/trash/restore` | `{ trashId, overwrite? }` | `{ restored:true, path:string }` |
| POST | `/files/trash/empty` | `{ trashIds?, all? }` | `{ deleted:number }` |
| POST | `/files/upload` | multipart `file`；query `root,path,overwrite?` | `FileItem`，201 |
| GET | `/files/download` | `root`, `path` | 裸流 |
| POST | `/files/archive` | `{ root,paths,destination,format }` | `FileArchiveResult` |
| POST | `/files/extract` | `{ root,path,destination,format? }` | `FileExtractResult` |
| GET | `/files/search` | `root,path?,q,mode?,caseSensitive?,includeHidden?,limit?` | `FileSearchResult` |

```ts
interface FileListResult extends ListResult<FileItem> { root: string; path: string; }
interface FileSearchResult extends ListResult<FileItem> { query: string; truncated: boolean; }
interface TrashEntry { id: string; root: string; originalPath: string; trashedAt: string; sizeBytes: number; type: FileType; }
interface FileArchiveResult { path: string; format: 'zip'|'tar'|'tar.gz'; sizeBytes: number; entries: number; }
interface FileExtractResult { destination: string; entries: number; }
```

细节：

- list：目录优先、名称升序；`showHidden=false` 过滤 `.` 开头；limit 默认 100（最大 200）。
- read：默认 utf8；二进制返回 `400 BAD_REQUEST`（hint 用 base64）；`truncated` 表示超 maxBytes。
- write：默认 create/overwrite=true；overwrite=false 且存在 → CONFLICT；expectedMtime 不符 → CONFLICT；tmp+rename，不跟随符号链接。
- mkdir：recursive 默认 false；已存在 → CONFLICT（recursive=true 幂等）。
- rename/copy：同 root；目标冲突 → CONFLICT；目录复制上限 10 万文件/5 GiB。
- chmod：3/4 位八进制；Windows 只映射只读位。
- delete：默认移入 `$MPANEL_AGENT_BASE_DIR/trash/<id>`（目录递归）；permanent 直接删除；根目录不可删。
- trash restore：目标仍在根内；冲突按 overwrite；跨 root 不允许。
- upload：path 是已存在目录；filename basename 清洗；临时文件+rename；>100 MiB → BAD_REQUEST。
- download：仅 file；RFC 5987 Content-Disposition；不返回目录。
- archive：destination 在 root 内且不能在源路径内；tar/tar.gz 用 tar，zip 需 bsdtar/zip，缺失 UNAVAILABLE；临时文件+rename。
- extract：先 `tar -tvf` 拒绝绝对/`..`/链接；目标在 root 内；冲突 → CONFLICT；上限 10 万条目/5 GiB。
- search：mode=name 默认；content 只搜文本（≤5 MiB/文件），最多 200 条，truncated 表示上限。

## 11. 终端

```ts
interface TerminalSession {
  id: string;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  pty: boolean;                 // false = spawn 管道降级，resize 无效
  status: 'running' | 'exited';
  exitCode: number | null;
  createdAt: string;
  lastActivityAt: string;
}
```

| 方法 | 路径 | Query / Body | data |
|---|---|---|---|
| GET | `/terminal/shells` | — | `ListResult<{ path:string; name:string }>` |
| GET | `/terminal/sessions` | 分页 | `ListResult<TerminalSession>` |
| POST | `/terminal/sessions` | `{ shell?, cwd?, cols?, rows?, env? }` | `TerminalSession`，201 |
| GET | `/terminal/sessions/:id` | — | `TerminalSession` |
| DELETE | `/terminal/sessions/:id` | — | `{ closed:true, id }` |

- 默认 shell：Windows `powershell.exe`，POSIX `$SHELL` 或 `/bin/bash`；shell 必须存在/可执行。
- cols 默认 80，rows 默认 24；PTY 可用时生效。
- cwd 默认 `$MPANEL_AGENT_BASE_DIR`；终端是可信属主功能，允许宿主绝对路径，必须存在/目录。
- env 合并但强制删除 `MPANEL_TOKEN`、`MPANEL_SECRET_KEY`、`MPANEL_CORE_TOKEN`、`MPANEL_MACHINE_SECRET`。
- 会话上限 20/worker；空闲 30 分钟关闭；WS 断开不杀会话；DELETE 才杀。

### 11.1 `WS /ws/terminal/:id`

- Auth：ticket/token（worker 或 core 代理）。
- 服务器立即发：

```ts
{ type: 'ready', session: TerminalSession }
```

- 客户端→服务器：

```ts
| { type: 'input'; data: string }          // ≤1 MiB/帧
| { type: 'resize'; cols: number; rows: number }
| { type: 'ping' }
```

- 服务器→客户端：

```ts
| { type: 'output'; data: string }
| { type: 'exit'; code: number | null; signal?: string | null }
| { type: 'error'; code: string; message: string }
| { type: 'pong' }
```

- 会话不存在 → close `4404`；ticket 无效 `4401`；背压/帧上限 close `1013`；进程退出 `exit` 后 close 1000。
- 输出 UTF-8 文本；xterm 直接 write。WS 断开只销毁桥接，不杀 PTY。

## 12. 计划任务

```ts
type TaskOverlap = 'skip' | 'allow';
type TaskRunStatus = 'running' | 'success' | 'failed' | 'timeout' | 'skipped';

interface Task {
  id: string;
  name: string;
  description: string | null;
  schedule: string;                 // croner 表达式
  timezone: string | null;          // IANA
  command: string;                  // shell 字符串（可信属主）
  cwd: string | null;
  env: Record<string, string>;
  enabled: boolean;
  timeoutSec: number;               // 1..86400，默认 300
  overlap: TaskOverlap;             // 默认 skip
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
  lastRun: TaskRunSummary | null;
}

interface TaskRunSummary {
  id: string;
  taskId: string;
  status: TaskRunStatus;
  triggeredBy: 'schedule' | 'manual';
  startedAt: string;
  finishedAt?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
}

interface TaskRun extends TaskRunSummary {
  stdoutTail: string;               // ≤16 KiB
  stderrTail: string;               // ≤16 KiB
  truncated: boolean;
  logPath?: string | null;
}
```

| 方法 | 路径 | Query / Body | data |
|---|---|---|---|
| GET | `/tasks` | `enabled?`, `q?`, 分页 | `ListResult<Task>`，默认 `name asc` |
| POST | `/tasks` | `TaskCreateInput` | `Task`，201 |
| GET | `/tasks/:id` | — | `Task` |
| PUT | `/tasks/:id` | `TaskUpdateInput`（至少一项） | `Task` |
| DELETE | `/tasks/:id` | — | `{ deleted:true, id, killedRun?: string }` |
| POST | `/tasks/:id/run` | `{}` | `{ run: TaskRun }`（status=running，异步） |
| GET | `/tasks/:id/history` | 分页，`status?` | `ListResult<TaskRun>` |
| GET | `/tasks/:id/next-runs` | `count?`(1..10，默认 5) | `{ nextRuns: { at:string }[] }` |
| GET | `/tasks/runs` | `status?`, `taskId?`, 分页 | `ListResult<TaskRun>` |

```ts
interface TaskCreateInput {
  name: string;
  description?: string;
  schedule: string;
  timezone?: string;
  command: string;
  cwd?: string;
  env?: Record<string,string>;
  enabled?: boolean;
  timeoutSec?: number;
  overlap?: TaskOverlap;
}
```

- 无效 cron/timezone → `400 BAD_REQUEST`。
- run-now 即使 disabled 也允许；overlap=skip 且有 running → 创建 skipped run 返回 200。
- 任务命令由 ShellRunner 执行（POSIX sh -c / PowerShell -Command / cmd /c）；可信属主例外。
- 运行时强制删除面板凭据；cwd 必须存在；超时 kill 进程树；worker 重启把 running 标 failed。
- 删除任务停止调度并 kill 当前 run；历史保留。
- 历史保留最近 1000 条或 30 天；完整日志按任务保留最近 50 次。

## 13. 健康检查

`GET /healthz`（无认证、非信封）：

```json
{ "ok": true, "status": "ok", "version": "0.1.0", "role": "worker" }
```

- 只表示进程可响应；能力看 `/system/info`。

## 14. 前端运行时配置与多连接

### 14.1 `/config.json`

前端启动时 `GET ${import.meta.env.BASE_URL}config.json`（默认 `/config.json`；`cache:'no-store'`；404 不致命）。不要用相对 `./config.json`，否则深链路由会解析到错误目录。

```ts
interface RuntimeConfig {
  appName?: string;
  dbxUrl?: string;
  /** kind 仅为兼容旧 config.json；面板忽略非 core 条目。 */
  defaultBackend?: { url: string; kind?: 'core'; label?: string };
  backends?: { id?: string; url: string; kind?: 'core'; label?: string }[];
  allowUserConnections?: boolean;   // 默认 true
}
```

优先级：`config.json`（运行时）→ `VITE_*` 编译期 → 内置默认。

| 环境变量 | 用途 |
|---|---|
| `VITE_DEFAULT_BACKEND` | 默认后端 URL |
| `VITE_DEFAULT_BACKEND_KIND` | `worker` 或 `core` |
| `VITE_DEFAULT_BACKEND_LABEL` | 显示名 |
| `VITE_DBX_URL` | dbx iframe 基础地址 |
| `VITE_API_TIMEOUT_MS` | 普通请求超时，默认 120000 |
| `VITE_BASE_PATH` | 构建期静态基路径，默认 `/` |

- `config.json` 是公开静态文件，**不得**包含 token/密码/secret。
- 面板只保存 core 连接（`localStorage: mpanel.core-connections.v1`）；切换连接清空 Query 缓存、关闭 WS 并重置工作台。
- 工作台标签存 `localStorage: mpanel.workspace.v1`：每个标签独立绑定 `machineId + 路由`，支持同时混合打开多台机器的页面。

### 14.2 连接与 secret 分离

```ts
interface BackendConnection {          // 仅此对象进入 localStorage
  id: string;
  name: string;
  baseUrl: string;                     // core 服务根地址
  username?: string;
  createdAt?: string;
}
```

- `useConnectionStore` 只持久化 core 连接元数据；**不持久化任何 token / 密码 / agent secret**。
- core 使用 HttpOnly cookie 会话，不存密码；登录态按 connection id 记录在内存。
- 可选的 core Bearer token 只来自编译期环境变量，存在内存中，供无 cookie 的脚本式访问。
- 面板没有“选中机器”全局状态：机器由路由 `:machineId` 绑定到具体标签页，多机页面可同时存在。
- `config.json` / 环境变量里的旧 `kind: "worker"` 条目会被面板忽略。

### 14.3 dbx iframe

- `VITE_DBX_URL` 或 `config.dbxUrl`；未配置时数据库页仍可管理档案/备份，只禁用查询 iframe。
- 前端把 ticket 放 iframe URL fragment，endpoint 放同一 fragment；dbx POST JSON body。密码永不进 URL。
- iframe 使用最小 `sandbox`/`allow`，CSP `frame-src` 允许 dbx 源。

## 15. 数据模型汇总（`web/src/api/types.ts` 必须镜像）

本节列出前端必须镜像的完整类型；字段与上文一致。`web` **不得** import `@mpanel/shared`。`pnpm check` 解析下列 `// TypeName`，逐名校验 `web/src/api/types.ts` 有 `export type`/`export interface`。

```ts
// ApiEnvelope
// ErrorCode
// ListResult
// PageQuery
// SystemInfo
// CapabilityStatus
// Capabilities
// WorkerDescriptor
// SystemOverview
// MachineCounts
// Machine
// MachineStatus
// MachineTransport
// MachineDesiredState
// MachineCreateInput
// MachineCreateResult
// MachineEnrollment
// MachineUpdateInput
// MachineTestResult
// MachineHealth
// SystemSnapshot
// SystemMetrics
// EdgeKey
// EdgeJob
// EdgeJobKind
// EdgeJobStatus
// EdgeEnrollRequest
// EdgeEnrollResult
// EdgeKeyCreateInput
// EdgeKeyCreateResult
// EdgeJobCreateInput
// Site
// SiteStatus
// SiteConfig
// SiteHandler
// ReverseProxyHandler
// FileServerHandler
// RedirectHandler
// SitePreviewResult
// SiteApplyResult
// SiteExportBundle
// SiteImportResult
// CertificateInfo
// CertificateStatus
// DatabaseProfile
// DatabaseProfileCreateInput
// DatabaseProfileUpdateInput
// DatabaseTestResult
// PostgresStats
// RedisStats
// DatabaseStats
// HandoffTicket
// HandoffRedeemRequest
// HandoffPayload
// BackupFormat
// BackupRecord
// DatabaseJob
// ContainerSummary
// ContainerDetail
// ContainerPort
// ContainerActionInput
// ContainerStats
// ExecRequest
// ExecResult
// ImageSummary
// ImagePullRequest
// ImagePruneRequest
// StackSummary
// StackDetail
// StackCreateInput
// StackUpdateInput
// StackActionInput
// FileRoot
// FileItem
// FileType
// FileListResult
// FileSearchResult
// FileReadResult
// FileWriteRequest
// FileMkdirRequest
// FileRenameRequest
// FileCopyRequest
// FileChmodRequest
// FileDeleteQuery
// FileUploadQuery
// FileDownloadQuery
// FileSearchQuery
// TrashEntry
// FileArchiveResult
// FileExtractResult
// TerminalSession
// TerminalCreateInput
// ShellInfo
// TerminalClientMessage
// TerminalServerMessage
// ContainerLogsQuery
// ContainerLogsClientMessage
// ContainerLogsServerMessage
// Task
// TaskRun
// TaskRunSummary
// TaskCreateInput
// TaskUpdateInput
// TaskRunNowResult
// TaskNextRunsResult
// AuthUser
// AuthMe
// LoginInput
// LoginResult
// ChangePasswordInput
// WsTicket
// WsTicketRequest
// BackendConnection
// ConnectionSecret
// RuntimeConfig
```

- 前端可对 `details` 使用 `unknown`；只对已知 `reason/hint` 展示。
- 手写镜像必须包含本文件 §4–§12 的字段；类型只能定义在 `web/src/api/types.ts`，页面轨道不得复制/改写。

## 16. 错误码速查（按端点组）

所有端点还可能返回 `BAD_REQUEST`、`UNAUTHORIZED`、`FORBIDDEN`、`INTERNAL`。下表只列额外/高概率错误。

| 端点组 | 额外/典型错误 |
|---|---|
| `/auth/login` | `UNAUTHORIZED`（retryAfterSec）、`BAD_REQUEST` |
| `/auth/me`、`/auth/ws-ticket`、`/auth/password` | `UNAUTHORIZED`、`FORBIDDEN`、`BAD_REQUEST` |
| `/system/info`、`/system/overview` | `NOT_FOUND`（worker overview）、`UNAUTHORIZED` |
| `/machines` CRUD | `NOT_FOUND`、`CONFLICT`（重名）、`FORBIDDEN`（stdio 未开启）、`BAD_REQUEST`（transport/entry） |
| `/machines/:id/connect`、`/disconnect`、`/test`、`/health` | `NOT_FOUND`、`CONFLICT`（disabled）、`UPSTREAM_ERROR`、`UNAVAILABLE` |
| `/machines/:id/secret/rotate` | `BAD_REQUEST`（非 reverse-ws）、`NOT_FOUND` |
| `/machines/:id/proxy/*` | `UNAVAILABLE`（offline/stopped）、`UPSTREAM_ERROR`、`NOT_FOUND`；业务 envelope 透传 |
| `WS /machines/:id/proxy/ws/*` | `UNAUTHORIZED`、`UNAVAILABLE`/`4502`、`4404` |
| `/sites` CRUD | `CONFLICT`、`NOT_FOUND`、`BAD_REQUEST`（配置/根目录） |
| `/sites/preview` | `NOT_FOUND`（siteId）、`BAD_REQUEST` |
| `/sites/apply` | `CONFLICT`、`BAD_REQUEST`（render/validate）、`UPSTREAM_ERROR`（reload）、`UNAVAILABLE`（caddy）、`NOT_FOUND` |
| `/sites/import`、`/sites/export` | `BAD_REQUEST`（bundle） |
| `/certs` | `NOT_FOUND`；列表不可用用 `available=false` |
| `/databases/profiles` CRUD | `CONFLICT`、`NOT_FOUND`、`BAD_REQUEST`（kind/port） |
| `/databases/profiles/:id/test` | `UNAVAILABLE`；连接失败 200 ok:false |
| `/databases/profiles/:id/stats` | `UPSTREAM_ERROR` |
| `/databases/profiles/:id/handoff`、`/databases/handoff/redeem` | `NOT_FOUND`、`BAD_REQUEST`、`UNAUTHORIZED`（限速） |
| `/databases/profiles/:id/backup`、`/restore` | `CONFLICT`、`BAD_REQUEST`、`UNAVAILABLE`、`NOT_FOUND` |
| `/databases/backups/:id`、`/download`、`/jobs*` | `NOT_FOUND`、`UPSTREAM_ERROR`（下载） |
| `/containers*` | `UNAVAILABLE`、`NOT_FOUND`、`BAD_REQUEST`、`UPSTREAM_ERROR` |
| `/containers/networks*` | `UNAVAILABLE`、`NOT_FOUND`、`BAD_REQUEST`、`CONFLICT` |
| `/containers/config` | `BAD_REQUEST`（JSON/已知键）、`UNAVAILABLE`（读写失败） |
| `/containers/:id/logs`、WS logs | `UNAVAILABLE`、`NOT_FOUND`、`4502`/`4404` |
| `/images*` | `UNAVAILABLE`、`NOT_FOUND`、`BAD_REQUEST`、`UPSTREAM_ERROR` |
| `/stacks*` | `UNAVAILABLE`、`NOT_FOUND`、`CONFLICT`、`BAD_REQUEST`、`UPSTREAM_ERROR` |
| `/files*` | `BAD_REQUEST`（路径/链接/二进制/大小）、`NOT_FOUND`、`CONFLICT`、`UNAVAILABLE`、`FORBIDDEN` |
| `/terminal/*` | `NOT_FOUND`、`BAD_REQUEST`、`UNAUTHORIZED`（WS） |
| `/tasks*` | `BAD_REQUEST`（cron/命令）、`NOT_FOUND`、`UPSTREAM_ERROR`（spawn） |

## 17. 版本与变更

- 当前 `apiVersion=1`，`protocolVersion=1`。
- v1 只允许新增可选字段/端点/details 键、放宽校验；删除/改义/收紧必填 → v2。
- 弃用使用 `Deprecation`/`Sunset` 头；至少保留一个 minor。
- 客户端对未知 code 显示通用错误但保留原始 code；`UNAVAILABLE` 始终展示 `details.hint`。

## 18. 覆盖检查表

| 要求路径组 | 本文位置 |
|---|---|
| `/system/info`、`/system/overview`（仅 core） | §4 |
| `/sites`（preview/apply/import） | §6 |
| `/certs` | §7 |
| `/databases/profiles`（test/handoff/backup/restore/pg+redis stats） | §8 |
| `/containers`（logs 流/stats/exec/start/stop/restart/remove） | §9.2 |
| `/containers/networks`、`/containers/config` | §9.5 |
| `/stacks`、`/images` | §9.3、§9.4 |
| `/files`（list/stat/read/write/mkdir/rename/copy/chmod/delete/trash/upload/download/archive/extract/search） | §10 |
| `/terminal/sessions`、`WS /ws/terminal/:id` | §11 |
| `/tasks`（run-now/history/next-runs） | §12 |
| `/machines*`、proxy | §5 |
| `/auth/*` | §3 |
| WS ticket | §2.2 |
