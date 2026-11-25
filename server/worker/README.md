# MPanel Worker

worker 是 MPanel 的宿主代理：在本机执行站点/Caddy、证书、数据库、容器、文件、终端与计划任务操作。它只信任 **一个静态访问令牌**，所有 REST/WS 都必须认证；外部依赖缺失时降级为 `UNAVAILABLE`，不会让进程启动失败。

本文件覆盖运行时骨架与传输层（`src/{index,config,http,auth,registry,capabilities,exec,paths,store,logger,ws}.ts`、`src/transports/*`）。业务模块在 `src/modules/*`，由各模块轨道实现。

## 快速开始

```bash
# 在仓库根目录
pnpm install
node node_modules/typescript/bin/tsc -b server/worker

# 生成令牌（只打印到 stdout；--write 写入 $MPANEL_HOME/config.json）
node server/worker/dist/index.js token generate --length 32 --write

# 启动（默认 http 传输）
MPANEL_HOME=./mpanel-home MPANEL_TOKEN=<token> node server/worker/dist/index.js
```

`serve` 是默认命令。常用命令：

```text
mpanel-worker [serve] [--transport http|stdio|reverse-ws] [--home DIR] [--listen HOST:PORT]
mpanel-worker doctor [--home DIR]
mpanel-worker token generate [--length N] [--write] [--home DIR]
mpanel-worker --version | --help
```

- `doctor` 打印配置与 caddy/docker/postgres/redis/pty 能力表；能力缺失不视为失败，退出码仍为 0。
- `--transport` 覆盖 `MPANEL_TRANSPORT`；`--listen` 覆盖 `MPANEL_LISTEN`。
- 配置错误（非法端口、transport、URL、文件根等）打印中文清单并以退出码 **2** 退出；运行期错误退出码 1。
- 同一 `MPANEL_HOME` 只允许一个 worker（`state/.worker.lock`）。残留锁在 PID 不存在时自动接管。

## 配置

优先级：**命令行参数 > 环境变量 > `$MPANEL_HOME/config.json` > 默认值**。
`MPANEL_HOME` 默认 `~/.mpanel`；`MPANEL_LISTEN` 默认 `127.0.0.1:8787`。`MPANEL_HOST`/`MPANEL_PORT` 可单独覆盖监听地址的字段，`MPANEL_PORT=0` 表示随机端口。

关键环境变量：

| 变量 | 说明 |
|---|---|
| `MPANEL_HOME` | 状态根目录（JSON 存储、日志、Caddy、备份、trash、stacks） |
| `MPANEL_TRANSPORT` | `http`（默认）/ `stdio` / `reverse-ws` |
| `MPANEL_LISTEN` | `host:port`；也支持 `MPANEL_HOST` + `MPANEL_PORT` |
| `MPANEL_TOKEN` | serve 必需；REST `Authorization: Bearer` / `X-MPanel-Token`，WS `?token=` |
| `MPANEL_CORE_URL` | reverse-ws 的 core 地址（支持 `http(s)://`、`ws(s)://`、带路径前缀） |
| `MPANEL_MACHINE_ID` / `MPANEL_MACHINE_SECRET` | reverse-ws 机器身份；secret 只用于升级请求的 Bearer |
| `MPANEL_LOG_LEVEL` | `debug/info/warn/error/fatal/silent`，默认 `info` |
| `MPANEL_FILES_ROOTS` | `name=absolutePath[,name=absolutePath]`，默认 `files=$MPANEL_HOME/files` |
| `MPANEL_FILE_ROOTS` | `MPANEL_FILES_ROOTS` 的兼容别名 |
| `MPANEL_CADDY_BIN` / `CADDY_BIN` | caddy 可执行文件，默认 `caddy` |
| `MPANEL_CADDY_CONFIG_DIR` / `MPANEL_CADDY_CONFIG` / `CADDY_CONFIG` | Caddy 配置目录，默认 `$MPANEL_HOME/caddy` |
| `MPANEL_CADDY_DATA_DIR` / `MPANEL_CADDY_ADMIN` | 证书数据目录 / admin 地址 |
| `MPANEL_DOCKER_BIN` / `DOCKER_BIN` | docker CLI，默认 `docker` |
| `MPANEL_PG_DUMP_BIN` / `PSQL_BIN` / `MPANEL_PSQL_BIN` | PostgreSQL 工具 |
| `MPANEL_CORS_ORIGINS` | 允许的浏览器 origin（逗号/空格分隔；`*` 仅配合无 cookie 的 Bearer 模式） |
| `MPANEL_MAX_UPLOAD_BYTES` | multipart 上传上限，默认 100 MiB |
| `MPANEL_SECRET_KEY` | 32 字节密钥（base64 或 64 位 hex），用于数据库密码加密 |
| `MPANEL_CORE_INSECURE` | `1` 时跳过 core TLS 证书校验（仅开发） |

`config.json` 接受与 `WorkerConfig` 同形的嵌套字段（`transport`、`token`、`listen`、`host`、`port`、`corsOrigins`、`caddy`、`docker`、`databases`、`files`、`tasks`、`security`、`redeemRateLimit`、`coreUrl`、`machineId`、`machineSecret`、`insecureCoreTls`），也接受 `caddyBin`、`filesRoots` 等扁平别名。示例：

```json
{
  "transport": "reverse-ws",
  "listen": "127.0.0.1:8787",
  "token": "由 token generate 生成",
  "corsOrigins": ["https://panel.example.com"],
  "files": { "roots": [{ "name": "www", "path": "/srv/www" }] },
  "coreUrl": "https://core.example.com",
  "machineId": "m_1",
  "machineSecret": "core 下发的一次性 secret"
}
```

## 三种传输

### http（默认）

Fastify 按 `host:port` 真实监听，浏览器或 core 直接访问。启动时 stdout 输出一行供冒烟脚本发现端口：

```json
{"event":"listening","host":"127.0.0.1","port":8787,"transport":"http"}
```

其余日志固定写 stderr（JSON 行）。`/ws/*` 由 `@fastify/websocket` 接入同一个网关。

### stdio

由 core spawn。worker 先在本机 `127.0.0.1:0` 启动同一个 Fastify 实例，然后把 stdin/stdout 的 **NDJSON 帧**翻译成对该 loopback 的 HTTP/WS 调用：

- stdout 从启动到退出只允许协议帧；日志一律 stderr。
- 启动后立即发送 `hello`（含 `token`、worker 描述与协议上限），等待 core 的 `hello{accepted:true}`（10 秒超时）。
- 支持 `http-request` / `http-response` / `ws-open` / `ws-frame` / `ws-close` / `ping` / `pong`；`http-response` 按 512 KiB 流式分块。
- stdin EOF 视为 core 要求退出：优雅关闭 loopback 与 Fastify，退出码 0。
- 30 秒没有任何入站帧视为心跳超时，主动退出等待 core 重启。

### reverse-ws

worker 主动拨号 `MPANEL_CORE_URL` 规范化为 `/ws/worker`，携带：

- `Authorization: Bearer <MPANEL_MACHINE_SECRET>`
- 子协议 `mpanel.tunnel.v1`
- `hello`（machineId、worker 版本、capabilities 快照、协议上限）

指数退避重连 1s→30s（±20% jitter，上限 30s）；每次成功 hello 后重置。心跳 10s / 30s 超时。断线期间 core 侧请求以 `UPSTREAM_ERROR` 失败；worker 侧通过关闭 loopback 上所有 inflight 请求清理。loopback 仍强制绑定 `127.0.0.1:0`。

### 为什么隧道用 loopback 而不是 `fastify.inject`

`inject` 会把响应缓冲进内存且不能执行 WebSocket upgrade，无法满足大文件流式下载/上传和终端/日志 WS。三种传输因此共享同一个 Fastify 应用，隧道桥只通过 loopback HTTP/WS + worker token 访问（不绕过鉴权）。这符合 `docs/architecture.md` §4.3 与 `docs/file-layout.md` §10.4。`fastify.inject` 仅用于进程内测试。

## 安全要点

- 静态 token 比较先 SHA-256 再 `timingSafeEqual`；REST 只接受 `Authorization: Bearer` 或 `X-MPanel-Token`，不接受 cookie。
- `/ws/*` 必须携带 `?ticket=`（一次性，60 秒，绑定 pathname + 排序后的业务 query）、`?token=` 或 `Authorization: Bearer`；裸连在升级前返回 401。
- WS ticket 的 `ticket`/`token` 参数在传给模块前被剔除；模块看到的 `rawQuery` 只含业务参数。
- `/api/v1` 仅有一个无认证例外：`POST /api/v1/databases/handoff/redeem`（body ticket 即凭据）。
- 请求日志不记录 header/body；URL 中 `token`/`ticket`/`secret`/`password` 与 `Bearer ...` 被替换为 `[redacted]`；未知异常只在 stderr 记录堆栈，响应只含 `INTERNAL` + requestId。
- 文件访问先 realpath 再 `path.relative` 校验；拒绝 `..`、反斜杠、盘符、UNC、控制字符与路径中的符号链接。
- 所有外部命令通过 `CommandRunner`（argv 数组，无 shell）执行；环境变量默认只保留 PATH/HOME/TMP 等白名单，绝不继承 `MPANEL_*`。`ShellRunner` 仅限可信属主的计划任务。
- `MPANEL_CORE_INSECURE=1` 会让 reverse-ws 跳过 TLS 校验，只能用于本地开发。

## 目录与状态

```text
$MPANEL_HOME/
├─ config.json           # 可选配置
├─ state/.worker.lock    # 单实例锁
├─ state/*.json          # 模块 JSON 存储（原子写 + .bak）
├─ state/*.jsonl         # 追加历史（>5 MiB 轮转，保留 3 份）
├─ logs/worker.log       # stderr 同步写入的文件日志
├─ caddy/{Caddyfile,sites.d,staging,data}
├─ files/                # 默认文件根
├─ sites/                # 默认站点根
├─ backups/{caddy,databases}
├─ trash/
└─ stacks/
```

## 能力探测

`GET /api/v1/system/info` 返回 `capabilities`（caddy/docker/postgres/redis/pty）。探测 5 秒超时、30 秒缓存；`?refresh=1` 强制刷新。探测失败只把 `available` 置为 `false` 并给出中文 `reason` 与可执行 `details.hint`，绝不会抛到全局错误处理器，也不会阻止启动。`hello` 帧携带启动时的快照。

- `redis` 只要 `ioredis` 可加载即为可用；缺少 `redis-cli` 时 `details.rdbAvailable=false`。
- `postgres` 需要 `pg` 驱动 + `pg_dump` + `psql`；`pg_restore` 缺失体现在 `details.tools.pgRestore`。
- `pty` 不可用时终端模块降级为管道会话（`pty=false`，resize 无效）。

## 开发与自检

```bash
# 只构建 worker（同时构建 shared 依赖）
node node_modules/typescript/bin/tsc -b server/worker

# 静态契约/所有权检查（会检查整个仓库）
node scripts/check.mjs

# 诊断真实宿主
node server/worker/dist/index.js doctor
```

Windows 注意：`SIGTERM` 由 `process.kill` 发送时无法被 PowerShell/任务计划优雅捕获（系统直接终止进程）；请用 `SIGINT`/Ctrl+C 或 `taskkill` 之前先 STOP 服务。残留的 `state/.worker.lock` 会在下次启动时按 PID 自动清理。
