# @mpanel/core — 机器管理与代理

core 是多机面板的网关：负责用户名密码/静态 token 认证、机器档案与凭据保管、健康轮询、
`/api/v1/machines*` 管理 API，以及把 `/api/v1/machines/:machineId/proxy/*` 的 HTTP/WS
流式转发到对应 worker。本目录下的实现范围：

```
src/machines/     机器档案、凭据加密、健康轮询、MachineService、/machines 路由
src/transports/   stdio / http / reverse-ws 三种传输驱动，统一 TunnelChannel 帧协议
src/proxy/        /machines/:id/proxy/* 与 /proxy/ws/* 的转发
src/store.ts      原子 JSON 存储、JSONL 追加、state/.core.lock、id 生成
src/index.ts       CLI/启动（依赖 auth 与 app 轨道）
src/auth/         认证、会话、一次性 WS ticket（见认证轨道）
src/app.ts        路由装配、鉴权作用域、错误信封（见网关轨道）
```

## 快速开始

```bash
# 1. 构建 shared 与 core
node node_modules/typescript/bin/tsc -b server/shared server/core

# 2. 启动 core（示例：随机端口 + 静态 Bearer，便于脚本调用）
MPANEL_HOME=~/.mpanel \
MPANEL_LISTEN=127.0.0.1:8790 \
MPANEL_CORE_TOKEN=<至少 16 字符的随机串> \
node server/core/dist/index.js serve

# 3. 创建一台 http 机器
curl -sS -X POST http://127.0.0.1:8790/api/v1/machines \
  -H "authorization: Bearer $MPANEL_CORE_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"worker-a","transport":"http","url":"http://127.0.0.1:8787","token":"<worker MPANEL_TOKEN>"}'

# 4. 经 core 代理 worker 的 system/info
curl -sS http://127.0.0.1:8790/api/v1/machines/<machineId>/proxy/system/info \
  -H "authorization: Bearer $MPANEL_CORE_TOKEN"
```

首次启动且没有账号时，core 会生成一次性 bootstrap token（`$MPANEL_HOME/state/bootstrap-token`），
用 `POST /api/v1/auth/setup` 创建管理员；也可以设置 `MPANEL_ADMIN_USER`/`MPANEL_ADMIN_PASSWORD`
或使用 `mpanel-core user add`。脚本场景优先用 `MPANEL_CORE_TOKEN`。

> 注意：core 默认端口以 `server/core/src/config.ts` 为准（当前默认 `8788`）。文档历史值 `8790`
> 仅作示例；部署时以 `MPANEL_LISTEN` 显式配置为准。

## 三种传输

| 传输 | 连接方向 | 认证 | 何时使用 |
|---|---|---|---|
| `http` | core → worker（fetch/ws 直连） | core 注入 `Authorization: Bearer <worker token>` | worker 已有可达地址、内网或容器 |
| `stdio` | core spawn worker 子进程 | 子进程 env `MPANEL_TOKEN` + hello 帧 token 双重校验 | 同机强隔离，worker 不监听公网 |
| `reverse-ws` | worker → core 的 `GET /ws/worker` | machine secret（`Authorization: Bearer`，只存 SHA-256） | worker 在 NAT/防火墙后 |

### stdio

- 仅当 core 设置 `MPANEL_ALLOW_STDIO=1` 时可创建；等价于在 core 主机执行命令，只应给可信管理员。
- 机器记录保存 `command`（默认 `process.execPath`）与 `args`（默认 `[MPANEL_WORKER_ENTRY]`）。
  未配置 `MPANEL_WORKER_ENTRY` 且未提供 args 时创建返回 `BAD_REQUEST`。
- core 强制注入 `MPANEL_TRANSPORT=stdio`、`MPANEL_TOKEN`、`MPANEL_HOME=$CORE_HOME/workers/<id>`、
  `MPANEL_LOG_LEVEL`；用户的 `env` 不能覆盖这些保留键。
- stdout 只解析 NDJSON 帧；非法帧/超过 16 MiB 会终止子进程。stderr 进入环形缓冲（1000 行 /
  10 MiB）并追加到 `$CORE_HOME/logs/workers/<id>.log`。
- 子进程退出后按 1s→2s→4s…（上限 30s，±20% jitter）自动重启；连续 5 次失败进入 `error`，
  需要手动 `POST /machines/:id/connect`。

### reverse-ws

- core 在 `GET /ws/worker` 接受升级：`Authorization: Bearer <machine secret>`。secret 只在创建/
  轮换响应中出现一次；`?machineId=&secret=` 兼容形式仅在 `MPANEL_ALLOW_WS_QUERY_SECRET=1` 时启用。
- 升级后 5 秒内必须收到 hello；版本不符关闭 `4002`，machineId/secret 不匹配关闭 `4403`。
- 心跳 10s/30s；30 秒无入站帧判定离线并关闭。同一机器新连接优先，旧连接以 `4001` 关闭。
- `POST /machines/:id/disconnect` 后 core 以 `403 FORBIDDEN` 拒绝该机器重连，直到再次 `connect`。
- `POST /machines/:id/secret/rotate` 关闭当前连接并返回新的 `workerEnv`（含 `MPANEL_CORE_URL`、
  `MPANEL_MACHINE_ID`、`MPANEL_MACHINE_SECRET`、`MPANEL_TOKEN`）。

### http

- 直连 worker，不经过隧道帧；转发前剥离 `cookie`、`authorization`、`host`、逐跳头与
  `x-mpanel-*`（再注入 `x-mpanel-request-id`），并强制 `accept-encoding: identity` 以便流式响应
  的字节与 `content-length` 一致。
- 请求体流式转发，响应体流式返回；不跟随重定向。
- 健康探测 `GET /api/v1/system/info`；worker 返回 `401/403` 视为机器凭据错误（机器 `error`）。

## 健康轮询

- 默认每 15 秒探测一次；每台机器连续失败按 2^n 退避，最长 60 秒；并发上限 4。
- 可用环境变量覆盖（读取 `process.env`，不需要改 `CoreConfig`）：

| 变量 | 默认 | 范围 |
|---|---:|---:|
| `MPANEL_MACHINE_HEALTH_INTERVAL_MS` | `15000` | 1000–300000 |
| `MPANEL_MACHINE_HEALTH_MAX_INTERVAL_MS` | `60000` | ≥ interval，≤900000 |
| `MPANEL_MACHINE_HEALTH_CONCURRENCY` | `4` | 1–32 |

- 状态语义：`starting` 启动/握手；`online` 探测成功；`degraded` 1–2 次失败；`offline` ≥3 次失败或
  已知无连接；`error` worker 凭据/协议/连续重启失败。`error` 需要一次成功探测才会清除。
- 健康快照保存在内存（`lastSeenAt`/`latencyMs`/`capabilities`/`worker`），每 30 秒及 shutdown 时
  落盘到 `machines.json`；机器存储损坏时从 `.bak` 恢复，仍失败则以空档案启动（不阻断 core）。
- 任何机器故障都不会阻断 core 启动；首次 `healthz` 可用不依赖 worker。

## 代理

| 客户端 | worker 收到 |
|---|---|
| `ANY /api/v1/machines/:id/proxy/<suffix>?query` | `/api/v1<suffix>?query`（原始 query 字节保留） |
| `WS /api/v1/machines/:id/proxy/ws/<path>?query` | `WS /ws/<path>?query`（剔除 ticket/token） |

- 代理层**不重复鉴权**：`/api/v1` 的网关 hook 已注入 `req.mpanelAuth`，代理只调用 MachineService。
  唯一无 session 例外是精确路径 `POST /machines/:id/proxy/databases/handoff/redeem`（ticket 在 body，
  由网关 hook 放行、worker 校验）。
- handoff redeem 在代理层按**真实客户端 IP** 独立限速（`MPANEL_REDEEM_RATE_LIMIT`，默认 10/min）：
  超限返回 `401 UNAUTHORIZED` + `details.retryAfterSec` 与 `Retry-After` 头。worker 侧也有限速，
  但其看到的源地址是 core；core 这一层保证单个客户端无法刷 ticket。经反向代理部署时需设置
  `MPANEL_TRUST_PROXY=1`（或正确的 trustProxy 配置），否则 `req.ip` 会是反代地址、所有客户端共用桶。
- 代理插件使用 catch-all no-op content-type parser、`bodyLimit=110 MiB`，只读 `req.raw`，不注册
  `@fastify/multipart`；multipart 上传原样转发给 worker 解析。
- 头：不透传 `cookie`/`authorization`/`set-cookie`/逐跳头；保留 `content-disposition`、
  `x-mpanel-request-id`。
- 错误映射：
  - 未知机器 → `404 NOT_FOUND`
  - 禁用/断开/已知离线 → `503 UNAVAILABLE`（带 `details.machineStatus` 与 `hint`）
  - worker 返回 `401/403` → `502 UPSTREAM_ERROR`（`details.stage="auth"`）
  - worker 非信封 5xx → `502 UPSTREAM_ERROR`；worker 的 JSON 信封原样透传
  - 上游 `413/415` → `400 BAD_REQUEST`（带 hint）
  - 网络失败/超时 → `502 UPSTREAM_ERROR`
- 超时：普通 API 120 秒；`/images/pull`、`/files/{upload,download,archive,extract}`、
  `/databases/backups/:id/download` 620 秒。
- 代理 WS 自行认证（不挂 REST hook）：一次性 ticket（绑定身份/机器/规范化 path+业务 query）或
  `MPANEL_CORE_TOKEN`（`?token=` / `Authorization: Bearer`，脚本用）。裸连 close `4401`；机器未知
  `4404`；离线/上游不可用 `4502`；内部错误 `1011`。业务消息与关闭码双向透传，超过 8 MiB
  `bufferedAmount` 以 `1013` 关闭。
- 隧道并发：每机器 128 inflight，排队上限 256（排队超 30 秒 → `UNAVAILABLE`）；每机器 64 条 WS 流。

## 存储与凭据

- 机器档案：`$MPANEL_HOME/state/machines.json`，根对象 `schemaVersion: 1`；tmp + fsync + rename
  原子写，写前保留 `.bak`，所有写入串行化。
- worker token（http/stdio 与 reverse-ws 的 loopback token）使用 AES-256-GCM 加密，格式
  `v1:<iv>:<tag>:<ciphertext>`（base64url）。密钥来自 `MPANEL_SECRET_KEY`（base64 32 字节），
  否则 `$MPANEL_HOME/secrets.key`（0600，`open(...,'wx')` 原子创建）。
- reverse-ws machine secret 只保存 SHA-256；API 永不返回密文或明文（创建/轮换响应中的一次性
  secret/workerEnv 除外）。
- `server/core/src/store.ts` 提供通用原子 JSON（`createJsonStore`）、`writeFileAtomic`、
  `appendJsonl`（单行 ≤256 KiB，5 MiB 轮转保留 3 份）、`readJsonlTail`、`acquireStateLock`
  （`state/.core.lock`，pid 存活检测 + stale 接管；文件锁不可用时降级为进程内锁）与 `newId`。

## 已知限制

1. **可信属主模型**：stdio 启动命令、终端、任务等本质是宿主 RCE，core 只应部署给可信管理员。
2. **stdio/reverse-ws 的 loopback**：worker 仍会在 `127.0.0.1` 开随机端口并由 worker token 保护；
   同机其他用户可扫描到端口，威胁模型假设同机用户可信。
3. **reverse-ws 需要 TLS**（生产用 `wss://`）；隧道不是加密层。
4. **单 core**：session/ticket/机器健康状态在内存与本地 JSON，不能多副本；同 `MPANEL_HOME`
   同时只允许一个 core（`.core.lock`）。
5. **secret 一次性**：machine secret 只显示一次；遗失只能 rotate（会断开现有连接）。
6. **Windows**：`chmod`/0600 尽力而为；进程树终止使用 `child.kill()`（stdio 单进程）。
7. **健康状态是尽力而为**：`overview` 的机器计数以最后一次探测/心跳为准，不主动阻塞汇总。

## 验证

本仓库约定的检查：

```bash
node node_modules/typescript/bin/tsc -b server/core     # strict 类型检查 + 构建
node scripts/check.mjs                                  # 所有权/静态禁令/类型/构建
node scripts/smoke.mjs                                  # 端到端冒烟（需要 worker 轨道完成）
```

无 worker 时也可只验证 core 的传输驱动：stdio 与 reverse-ws 不需要外部依赖，可使用一个最小
NDJSON/WS 假 worker 走 hello、HTTP、流式上传/下载与 WS echo（见本次运行 notes 中的本地 harness）。
