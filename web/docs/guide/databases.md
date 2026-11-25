# 数据库与 dbx

MPanel 的数据库能力分两层：

- **档案与运维**：agent 保存 PostgreSQL / Redis 连接档案，提供连通性测试、运行统计、备份与恢复。
- **查询界面**：不在面板内实现 SQL/Redis 控制台，而是把一次性凭据交给外部 dbx，通过 iframe 嵌入。

::: tip 实现状态
数据库档案、测试、统计、备份恢复与 handoff 的接口契约已冻结（见 [REST API 契约](/api/contract)）；Go 版数据库模块仍在移植。`pg_dump_bin`、`psql_bin`、`redis_cli_bin` 配置字段已实现。
:::

## 1. 档案模型

```ts
type DatabaseKind = 'postgres' | 'redis';

interface DatabaseProfile {
  id: string;
  name: string;
  kind: DatabaseKind;
  host: string;
  port: number;                 // postgres 默认 5432；redis 默认 6379
  username: string | null;
  database: string | null;      // 仅 postgres
  tls: boolean;                 // postgres sslmode=require；redis TLS
  redisDb: number | null;       // 0..15，仅 redis
  hasPassword: boolean;
  lastCheck: {
    at: string;
    ok: boolean;
    latencyMs: number;
    serverVersion?: string;
    message?: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}
```

- 密码只写不读：API 永不返回密码或密文，只返回 `hasPassword`。唯一例外是 handoff redeem，它会向 dbx 返回一次性明文连接信息。
- 档案可以先创建，即使目标数据库暂时不可达；列表始终可用（JSON 存储）。
- 名称唯一；`redisDb` 只能用于 Redis，`database` 只能用于 PostgreSQL，否则 `BAD_REQUEST`。

## 2. 档案端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/databases/profiles` | `kind?`、`q?`、分页；默认 `name asc` |
| `POST` | `/databases/profiles` | 创建，`201` |
| `GET` | `/databases/profiles/:id` | 详情 |
| `PATCH` | `/databases/profiles/:id` | 更新；`password: null` 表示清除密码 |
| `DELETE` | `/databases/profiles/:id` | 删除；有运行中 job → `CONFLICT`；已有备份保留 |

创建示例：

```bash
curl -sS -X POST http://127.0.0.1:10087/api/v1/databases/profiles \
  -H 'authorization: Bearer <agent-token>' \
  -H 'content-type: application/json' \
  -d '{
    "name": "业务库",
    "kind": "postgres",
    "host": "10.0.0.12",
    "port": 5432,
    "username": "mpanel",
    "password": "<密码>",
    "database": "app",
    "tls": false
  }'
```

## 3. 测试与统计

### 3.1 连通性测试

```http
POST /api/v1/databases/profiles/:id/test
```

```ts
interface DatabaseTestResult {
  ok: boolean;
  latencyMs: number;
  serverVersion?: string;
  message?: string;
}
```

- 连接失败返回 `200` + `ok:false`，并更新 `lastCheck`；这属于业务结果，不是能力缺失。
- 驱动或客户端工具缺失才返回 `503 UNAVAILABLE`。

### 3.2 运行统计

```http
GET /api/v1/databases/profiles/:id/stats
```

| 类型 | 主要字段 |
|---|---|
| PostgreSQL | `version`、`uptimeSec`、连接数（total/active/idle/idleInTransaction）、`databaseSizeBytes`、`cacheHitRatio`、`transactionsPerSec` |
| Redis | `version`、`uptimeSec`、`role`、`connectedClients`、`usedMemoryBytes`、`maxMemoryBytes`、`opsPerSec`、`keyspace[]` |

目标不可达或查询失败返回 `502 UPSTREAM_ERROR`，不更新 `lastCheck`。统计不会因为缺少外部命令而让整个页面失败。

## 4. 备份与恢复

### 4.1 格式

| 类型 | 默认格式 | 可选格式 | 工具 | 恢复方式 |
|---|---|---|---|---|
| PostgreSQL | `custom` | `plain` | `pg_dump`、`pg_restore`、`psql` | 自定义格式用 `pg_restore --clean --if-exists --no-owner`；plain 用 `psql -f` |
| Redis | `logical` | `rdb` | go-redis（SCAN/DUMP + RESTORE）、`redis-cli --rdb` | `logical` 可在线恢复；`rdb` 只能离线恢复，API 恢复请求返回 `503 UNAVAILABLE` |

- PostgreSQL 密码通过环境变量 `PGPASSWORD` 传递，不放在命令行参数里。
- Redis `logical` 逐 key DUMP/RESTORE，特殊模块 key 会跳过并产生 warning。
- 备份文件位于 `${agent.data_dir}/backups/databases/<profileId>/`，下载前校验记录与路径前缀。

### 4.2 作业与记录

```ts
interface BackupRecord {
  id: string;
  profileId: string;
  kind: 'postgres' | 'redis';
  format: 'custom' | 'plain' | 'rdb' | 'logical';
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

| 方法 | 路径 | Body / Query | 状态码 | data |
|---|---|---|---|---|
| `POST` | `/databases/profiles/:id/backup` | `{ format?, label? }` | `202` | `{ job }` |
| `GET` | `/databases/profiles/:id/backups` | 分页 | `200` | `ListResult<BackupRecord>` |
| `POST` | `/databases/profiles/:id/restore` | `{ backupId, confirm: true }` | `202` | `{ job }` |
| `GET` | `/databases/backups/:backupId` | — | `200` | `BackupRecord` |
| `DELETE` | `/databases/backups/:backupId` | — | `200` | `{ deleted: true }` |
| `GET` | `/databases/backups/:backupId/download` | — | `200` | 裸二进制流 |
| `GET` | `/databases/jobs` | `profileId?`、`status?`、分页 | `200` | `ListResult<DatabaseJob>` |
| `GET` | `/databases/jobs/:jobId` | — | `200` | `DatabaseJob` |

规则：

- 同一 profile 同时只允许一个 job，冲突返回 `409 CONFLICT`。
- 恢复只接受属于该 profile 且状态为 `success` 的备份；`confirm: true` 必填。
- 作业异步执行；agent 重启会把遗留的 `queued`/`running` 标为 `failed`（`agent restarted`），不会自动续跑。
- 备份下载是裸流，错误仍返回 JSON 信封。

## 5. dbx iframe

面板不内置查询器。数据库页的查询控制台是一个 iframe，地址来自 dbx：

| 配置方式 | 优先级 | 说明 |
|---|---|---|
| `config.json` 的 `dbxUrl` | 高（运行时） | 部署目录下的静态文件，改完刷新页面即可 |
| `VITE_DBX_URL` | 低（构建期） | 打包进前端产物，修改需重新构建 |
| 都不配置 | — | 档案、测试、备份恢复仍可用，只禁用查询 iframe |

`config.json` 示例：

```json
{
  "appName": "MPanel",
  "dbxUrl": "https://dbx.example.com"
}
```

注意事项：

- `config.json` 是公开静态文件，**不得**包含 token、密码或 secret。
- iframe 会被 CSP 的 `frame-src` 限制。core 需要把 dbx 的 origin 加入允许列表（`MPANEL_DBX_ORIGIN=https://dbx.example.com`，纯 origin，不带路径），然后重启 core。
- 如果 dbx 不支持跨域，把它反向代理到面板同源路径（例如 `/dbx`），再把 `dbxUrl` 设为 `/dbx`。
- iframe 使用最小 `sandbox` 与 `allow`，不要把面板的完整权限传给它。

## 6. handoff：把凭据一次性交给 dbx

### 6.1 申请票据

```http
POST /api/v1/databases/profiles/:id/handoff
{ "ttlSec": 60 }
```

```ts
interface HandoffTicket {
  ticket: string;          // 32 字节随机 base64url，只放请求体/片段
  expiresAt: string;
  redeemUrl: string;       // 固定 /databases/handoff/redeem（相对 API feature base）
  kind: 'postgres' | 'redis';
}
```

- TTL 10–300 秒，默认 60 秒。
- ticket 存在 agent 内存中，一次性、绑定 profile、过期清理；agent 重启即失效。
- 前端解析 `redeemUrl`：以 `http` 开头直接用；否则 `basePath + redeemUrl`。直连 agent 是 `/api/v1/databases/handoff/redeem`；经 core 是 `/api/v1/machines/<id>/proxy/databases/handoff/redeem`。

### 6.2 交给 iframe

推荐的 iframe URL 形态（由 dbx 决定具体解析）：

```text
https://dbx.example.com/#handoff=<ticket>&endpoint=<encodeURIComponent(redeemUrl)>
```

- ticket 放在 URL fragment，fragment 不会进入服务器访问日志；dbx 读取后自行 `POST` JSON body。
- 不要把 ticket 拼进 path 或 query，也不要放进 referrer 可见的位置。
- 密码永不进 URL。

### 6.3 redeem

```http
POST /api/v1/databases/handoff/redeem
{ "ticket": "<ticket>" }
```

- **无认证**：body 中的 ticket 就是凭据（256-bit、一次性、60 秒）。
- CORS 仅允许 `MPANEL_DBX_ORIGIN`，不带 credentials。
- 响应是 `HandoffPayload`，包含 `profileId`、`name`、`kind`、`host`、`port`、`username`、`password`、`database`、`tls`、`redisDb`，以及含密码的 `connectionString`；仅此一次响应。
- 响应头 `Cache-Control: no-store`、`Pragma: no-cache`。
- 无效/过期/已用 → `404 NOT_FOUND`；原子消费，重复请求不会成功。
- 限速默认 10 次/分钟（`MPANEL_REDEEM_RATE_LIMIT`），超限 `401 UNAUTHORIZED` + `details.retryAfterSec`；agent 与 core 代理都启用。
- 经 core 时，仅精确的 `POST /api/v1/machines/:id/proxy/databases/handoff/redeem` 跳过 session；其他代理路径仍要求认证。

### 6.4 审计与脱敏

- 日志与审计不记录 body、ticket 原文或带 secret 的 URL；只允许 ticket SHA-256 前 8 位、profileId、结果与来源 IP。
- 连接失败信息可以记录，但不得包含密码。
- agent 不执行 SQL/Redis 查询；查询行为与结果由 dbx 负责。

## 7. 排障

- 数据库页提示「dbx 未配置」：检查 `config.json` 的 `dbxUrl` 或构建期 `VITE_DBX_URL`。
- iframe 空白或被 CSP 拦截：核对 `MPANEL_DBX_ORIGIN` 与 CSP `frame-src`，注意 origin 必须完全一致。
- redeem CORS 失败：dbx 实际 origin 与 `MPANEL_DBX_ORIGIN` 不一致，或使用了带路径的值。
- 票据过期：TTL 只有 60 秒且一次性，重新点「打开 dbx」生成新票据。
- 备份失败：确认 `pg_dump`/`pg_restore`/`psql`/`redis-cli` 在 PATH 或配置了绝对路径，且 agent 用户对备份目录可写。

更多见[故障排查](/ops/troubleshooting#dbx-未配置或打不开)。
