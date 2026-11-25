# MPanel 运维手册

面向把 MPanel 部署到生产并长期维护它的人。内容包括：状态目录、备份恢复、密钥与 token 轮换、升级、日志、端口与反向代理、systemd/Docker 注意事项，以及故障排查表。

> **验证状态**：本文的代码路径、默认值与环境变量来自本仓库源码；`node scripts/check.mjs`、`node scripts/smoke.mjs`、`pnpm deploy:core`、`pnpm deploy:worker` 已在本机（Windows，Node 24.21.0 / pnpm 12.10.1）实际运行。**systemd 单元与 Docker 镜像/Compose 未在本机验证**（本机没有 systemctl、Docker），相关命令按 Linux 生产环境编写，首次上线前请在预发环境演练。

## 1. 进程、端口与状态根

| 进程 | 默认监听 | 状态根 | 说明 |
|---|---|---|---|
| worker | `127.0.0.1:8787` | `MPANEL_HOME`，默认 `~/.mpanel` | 每台被管主机一个；单实例锁 `state/.worker.lock` |
| core | `127.0.0.1:8788`（示例统一写 `8790`） | `MPANEL_CORE_HOME`，默认 `~/.mpanel-core` | 单实例；锁 `state/.core.lock`；会话/票据在内存 + 本地 JSON |
| web dev | `127.0.0.1:5173` | 无 | 仅开发；生产由 core 或独立静态服务器托管 `web/dist` |
| Caddy admin | `127.0.0.1:2019` | Caddy 自己的 data dir | 面板不管理 Caddy 进程，只写配置并 validate/reload |

要点：

- **worker 与 core 不能共用同一个状态目录**。两者都会写 `state/`、`secrets.key`、`session.secret`，且锁文件名不同但目录会互相干扰；`MPANEL_HOME` 同名变量也会让 core 误读 worker 的端口。生产使用独立 env 文件。
- core 不能多副本：session/ticket/机器健康状态在内存与本地 JSON，JSON 存储是单写者。
- worker 同一 `MPANEL_HOME` 只允许一个进程；残留锁在 PID 不存在时会自动接管。

## 2. `$MPANEL_HOME` 布局

### 2.1 worker（默认 `~/.mpanel`）

```text
$MPANEL_HOME/
├─ config.json                    # 可选；token 等配置，权限应 0600
├─ state/
│  ├─ .worker.lock                # 单实例锁
│  ├─ sites.json                  # 站点草稿与 apply 状态
│  ├─ databases.json              # 数据库档案（密码为 AES-256-GCM 密文）
│  ├─ tasks.json                  # 计划任务
│  └─ task-runs.jsonl             # 运行历史（>5 MiB 轮转 .1…​.3）
├─ secrets.key                    # 未设置 MPANEL_SECRET_KEY 时自动生成（0600）
├─ logs/
│  ├─ worker.log                  # stderr 同内容的 JSON 行日志（追加写）
│  └─ tasks/<taskId>/<runId>.log  # 计划任务输出
├─ caddy/
│  ├─ Caddyfile                   # 受管根配置：import sites.d/*.caddy
│  ├─ sites.d/<siteId>.caddy      # 每站点片段
│  ├─ staging/                    # 生成与 caddy validate 的临时目录
│  └─ data/                       # Caddy 数据/证书（可用 MPANEL_CADDY_DATA_DIR 覆盖）
├─ sites/                         # 默认站点根（白名单）
├─ files/                         # 默认文件管理根（白名单）
├─ stacks/<name>/compose.yaml     # Compose stack 草稿
├─ backups/
│  ├─ caddy/<timestamp>/          # apply 前的 Caddyfile + sites.d 回滚副本
│  └─ databases/<profileId>/...   # 数据库备份
└─ trash/<YYYY-MM-DD>/<trashId>/{meta.json,payload}  # 回收站（日期分桶）
```

### 2.2 core（默认 `~/.mpanel-core`）

```text
$MPANEL_CORE_HOME/
├─ state/
│  ├─ .core.lock
│  ├─ machines.json               # 机器档案；同目录 .bak 为上一版
│  ├─ users.json                  # scrypt 密码哈希
│  ├─ sessions.json               # 会话（只存 cookie 值的 SHA-256）
│  ├─ api-tokens.json             # 脚本用 API token 摘要
│  └─ bootstrap-token             # 首次初始化用；完成后删除
├─ session.secret                 # 未设置 MPANEL_SESSION_SECRET 时自动生成（0600）
├─ secrets.key                    # 未设置 MPANEL_SECRET_KEY 时自动生成（0600）
├─ audit.jsonl                    # 审计日志（>5 MiB 轮转 .1…​.3）
├─ workers/<machineId>/           # stdio 机器的 worker 状态根
└─ logs/workers/<machineId>.log   # stdio worker 的 stderr 环形缓冲落盘
```

**core 没有 `logs/core.log`**：core 日志只写 stderr，由 systemd/journald 或 Docker 日志驱动收集。`docs/architecture.md` §7.2 的历史目录图包含 `logs/core.log`，以本节与 `server/core/src/index.ts` 的实现为准。

### 2.3 权限

- 两个目录都应为运行用户所有，目录 `0700`、密钥文件 `0600`。
- worker 还需要：Caddy 配置目录可写（默认在 home 内；生产常用 `/etc/caddy`）、Caddy data 目录可读（证书扫描）、站点/文件根可读写、Docker socket 可访问。
- Docker 容器内运行用户是 UID/GID `10001`（见 `deploy/Dockerfile.*`）；绑定挂载的宿主目录必须让该 UID 可写。

## 3. 备份与恢复

### 3.1 备份什么

| 对象 | 是否必须 | 说明 |
|---|---|---|
| core `state/` + `session.secret` + `secrets.key` | **必须** | 机器档案、用户、会话、API token、加密密钥；丢失 `secrets.key` 后机器 token 无法解密 |
| worker `state/` + `secrets.key` + `config.json` | **必须** | 站点/数据库/任务、数据库密码密文、token |
| worker `caddy/`（至少 `Caddyfile`、`sites.d/`；建议含 `data/`） | **必须** | 当前生效配置；`data/` 含 Caddy 证书，丢了会重新签发/需要 DNS 验证 |
| worker `files/`、`sites/`、`stacks/`、`trash/`、`backups/` | 按需 | 用户数据；`files/` 常是业务站点根 |
| core `audit.jsonl` | 合规需要时 | 审计，只追加；轮转文件 `.1`…​.3` 一并备份 |
| `web/dist` / `out/*` / Docker 镜像 | 可重建 | 由版本与构建流程恢复，不必作为状态备份 |

### 3.2 一致性

- JSON 存储使用 tmp + fsync + rename 原子替换，并有 `.bak`；但**多个文件之间不是事务**。
- 最稳妥：停服务或做文件系统快照后再打包。运行中热拷贝通常可接受（单文件原子），但 `state/` 与 `secrets.key` 必须来自同一时间点，否则密文无法解密。
- Caddy apply 自己有回滚副本：`backups/caddy/<timestamp>/`；数据库备份在 `backups/databases/`，不能替代整机备份。

### 3.3 systemd 主机备份示例

```bash
sudo systemctl stop mpanel-worker mpanel-core

STAMP="$(date +%F-%H%M)"
sudo tar --numeric-owner -czf "/var/backups/mpanel-state-${STAMP}.tgz" \
  -C /var/lib/mpanel core worker
# 如果 Caddy 配置/证书在 home 之外，分别打包：
# sudo tar --numeric-owner -czf "/var/backups/mpanel-caddy-${STAMP}.tgz" -C / etc/caddy
# sudo tar --numeric-owner -czf "/var/backups/mpanel-caddy-data-${STAMP}.tgz" -C /var/lib caddy

sudo systemctl start mpanel-core mpanel-worker
```

恢复：

```bash
sudo systemctl stop mpanel-worker mpanel-core
sudo tar --numeric-owner -xzf /var/backups/mpanel-state-YYYY-MM-DD-HHMM.tgz -C /var/lib/mpanel
sudo chown -R mpanel:mpanel /var/lib/mpanel/core /var/lib/mpanel/worker
sudo systemctl start mpanel-core mpanel-worker
```

恢复后检查：core `/healthz`、登录、机器列表与健康、worker `doctor`、站点 apply 状态、数据库档案 `hasPassword`、任务历史。

### 3.4 Docker 卷备份示例（未在本机验证）

先确认卷名：`docker volume ls`。Compose 项目名默认为目录名（本仓库示例为 `mpanel`），卷名形如 `mpanel_core-data`。

```bash
docker compose -f deploy/docker-compose.yml stop

docker run --rm \
  -v mpanel_core-data:/data:ro \
  -v "$PWD/backups":/backup \
  alpine:3.20 tar czf /backup/core-$(date +%F).tgz -C /data .

docker run --rm \
  -v mpanel_worker-http-data:/data:ro \
  -v "$PWD/backups":/backup \
  alpine:3.20 tar czf /backup/worker-http-$(date +%F).tgz -C /data .

docker compose -f deploy/docker-compose.yml start
```

恢复时把归档解到卷、`chown -R 10001:10001`，再启动 core、worker。`alpine` 镜像与卷名需按实际环境调整。

### 3.5 只恢复了部分文件

- **只丢 `secrets.key`**：已加密的机器 token、reverse secret、数据库密码都无法解密。core 需要在 UI/API 重新录入每台机器的 token（或重建机器）；worker 需要重新录入数据库密码。不能通过改 key “恢复”。
- **只丢 `session.secret`**：所有登录会话与 API token 失效，用户重新登录即可；不需要恢复旧值。
- **只丢 `sites.json` 但 Caddy 还在跑**：Caddy 继续用旧配置；面板看不到草稿。可从 `caddy/sites.d/` 了解当前生效片段，但反向导入不保证完整（`sites.json` 才有 revision/状态）。
- **只丢 `machines.json`**：core 机器列表为空，但 worker 仍在运行；重新创建机器并填入相同 token/secret 即可。

## 4. 密钥与 token 轮换

| 凭据 | 位置 | 轮换方式 | 影响 |
|---|---|---|---|
| worker `MPANEL_TOKEN` | worker env / `$MPANEL_HOME/config.json`；core `machines.json` 中加密保存 | `node dist/index.js token generate --length 32`；更新 worker，再逐台 `PATCH /api/v1/machines/:id {token}` 或 UI 编辑；直连连接在 UI 更新 token | 旧 token 立即失效；该 worker 的 WS 会话断开；core 机器会短暂 `error`/`offline` 后恢复 |
| core 保存的机器 token | `machines.json`（AES-GCM） | 随 worker token 轮换一起 PATCH；无需改 core 密钥 | 同上 |
| reverse-ws machine secret | core 只存 SHA-256；worker env | `POST /api/v1/machines/:id/secret/rotate`（仅 reverse-ws），响应含一次性 `workerEnv`；更新 worker 并重启 | 现有 reverse 连接被关闭；旧 secret 立即失效 |
| core 登录会话 | `sessions.json` + cookie | 改用户密码会吊销该用户全部会话；或轮换 `MPANEL_SESSION_SECRET` 并重启 core | 所有用户重新登录；API token 也失效 |
| `MPANEL_SESSION_SECRET` | env 或 `session.secret` | 生成新值写入 env/文件，重启 core | 所有会话/API token 失效；不影响机器凭据 |
| `MPANEL_CORE_TOKEN` | core env | 改值并重启 core，更新脚本 | 旧脚本 Bearer 立即失效 |
| 管理员密码 | `users.json` | UI **设置 → 修改密码**，或 `node dist/index.js user passwd <user> --password-stdin` | 该用户全部会话被吊销 |
| `MPANEL_SECRET_KEY` | env 或 `secrets.key` | **没有自动 rekey**。换 key 后旧密文不可解密；需重新录入数据库密码、重新下发/录入机器 token | 计划停机 + 人工重录；务必先备份旧 key |
| bootstrap token | `$CORE_HOME/state/bootstrap-token` | 仅首次初始化有效；初始化成功后自动失效并删除；过期/泄漏时删除文件并重启 core 会重新生成（前提是仍无用户） | 只影响首次初始化 |

生成随机值：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

建议：

- `MPANEL_SECRET_KEY` 用 32 字节随机（base64 或 64 位 hex），与状态分开保管；不要把它写进镜像或 Compose 文件明文提交。
- 轮换 worker token 前先准备新值；worker 只有一个 token，旧 token 没有并行有效期。
- 轮换后立即验证：core 机器 `online`、直连连接 `测试连接` 成功、`/system/info` 可读。

## 5. 升级

### 5.1 升级前

1. 阅读目标版本的变更；协议只做加法时 core 可先升级，破坏性变更按发布说明先停 worker。
2. 完整备份 core/worker 状态与密钥（见 §3）。
3. 在预发环境跑门禁与冒烟：

```bash
pnpm install --frozen-lockfile
node scripts/check.mjs
node scripts/smoke.mjs
pnpm build
```

`smoke.mjs` 使用临时 `MPANEL_HOME` 与随机端口，不会碰生产状态。

### 5.2 构建发布物

```bash
pnpm deploy:core     # out/core：dist + 生产 node_modules
pnpm deploy:worker   # out/worker：dist + 生产 node_modules
# web：web/dist（pnpm build 已产出）
```

**不要只复制 `dist`**：core/worker 通过包 exports 解析 `@mpanel/shared` 与 `zod`，生产依赖必须在同目录 `node_modules` 中。`pnpm deploy` 已在本机验证会生成 `dist`、`node_modules`、`package.json`，可直接作为 systemd `WorkingDirectory`。

推荐版本化目录 + 符号链接，便于回滚：

```text
/opt/mpanel/releases/0.1.0/{core,worker,web}
/opt/mpanel/core   -> releases/0.1.0/core
/opt/mpanel/worker -> releases/0.1.0/worker
/opt/mpanel/web    -> releases/0.1.0/web
```

### 5.3 升级顺序（systemd）

```text
1. core（协议仅加法时）：停 core → 切换 /opt/mpanel/core → 起 core → /healthz + 登录 + 机器列表
2. worker 逐台：停一台 → 切换 /opt/mpanel/worker → 起 → 等 core 标记 online → 下一台
3. web：切换 /opt/mpanel/web（静态文件，无需重启 core；index.html 为 no-store）
4. 观察 15 分钟：机器健康、审计、任务、Caddy apply
```

破坏性协议升级（发布说明会标注）必须先停所有 worker，再升 core，再升 worker；v1 不支持自动降级。

### 5.4 Docker 升级（未在本机验证）

```bash
# 新版本打新 tag，避免覆盖正在运行的镜像
docker build -f deploy/Dockerfile.core   -t mpanel-core:0.2.0 .
docker build -f deploy/Dockerfile.worker -t mpanel-worker:0.2.0 .

# 先 core，再 worker（reverse-ws 服务用 profile 单独起）
docker compose -f deploy/docker-compose.yml up -d --no-deps core
docker compose -f deploy/docker-compose.yml up -d --no-deps worker-http
docker compose -f deploy/docker-compose.yml --profile reverse-ws up -d --no-deps worker-reverse
```

镜像 tag、服务名以 `deploy/docker-compose.yml` 为准。

### 5.5 降级

- 应用层不保证自动降级。恢复旧二进制 + 升级前备份的 `state/`。
- JSON 读取时会按 `schemaVersion` 迁移；迁移后的文件旧版本可能无法读取，所以升级前的整目录备份是唯一可靠回滚点。

## 6. 日志位置与排查

| 日志 | 位置 | 说明 |
|---|---|---|
| worker 运行日志 | stderr + `$MPANEL_HOME/logs/worker.log` | JSON 行；`MPANEL_LOG_LEVEL`；stdio 模式 stdout 只允许帧 |
| 计划任务输出 | `$MPANEL_HOME/logs/tasks/<taskId>/<runId>.log` | 运行历史 JSONL 在 `state/task-runs.jsonl` |
| core 运行日志 | 仅 stderr | systemd → journald；Docker → `docker compose logs core` |
| stdio worker stderr | `$MPANEL_CORE_HOME/logs/workers/<machineId>.log` | core 捕获的子进程 stderr（环形缓冲落盘） |
| 审计 | `$MPANEL_CORE_HOME/audit.jsonl`（轮转 `.1`…​.3`） | 登录、用户、机器创建/删除/轮换、代理写请求；API `GET /api/v1/system/audit` 查尾部 |
| Caddy | Caddy 自己的日志 | 面板只记录 `caddyOutput`（validate/reload 输出摘要） |

常用命令：

```bash
# systemd
sudo journalctl -u mpanel-core -f
sudo journalctl -u mpanel-worker -f --since "30 min ago"

# Docker
docker compose -f deploy/docker-compose.yml logs -f core worker-http

# worker 自检（配置 + 能力）
node /opt/mpanel/worker/dist/index.js doctor --home /var/lib/mpanel/worker

# core / worker 存活
curl -s http://127.0.0.1:8790/healthz
curl -s http://127.0.0.1:8787/healthz
```

`worker.log` 由进程持有文件描述符追加写；用 logrotate 时选 `copytruncate`，否则进程会继续写旧 inode：

```text
/var/lib/mpanel/worker/logs/*.log {
  weekly
  rotate 8
  compress
  missingok
  notifempty
  copytruncate
}
```

排查时优先看：

- 请求 id：响应头 `x-mpanel-request-id`；core 生成后经代理传给 worker。
- 机器 `lastError` 与 `GET /api/v1/machines/:id/health`。
- 能力快照：`GET /api/v1/system/info`（worker）与 `doctor`。
- 审计：谁在什么时候改了什么。

## 7. 端口与反向代理

### 7.1 暴露面

| 端口 | 建议 |
|---|---|
| core `8790`（或代码默认 `8788`） | 反代到 443；只暴露 core |
| worker `8787` | 仅内网/core 可达；单机模式才由反代暴露，并且必须 TLS |
| Caddy admin `2019` | 仅 loopback；不要暴露公网 |
| Docker socket | 不要通过网络暴露；容器挂载 socket 等于给容器宿主 root 能力 |
| `5173` | 仅开发 |

### 7.2 反向代理要求

- WebSocket：透传 `Upgrade` 与 `Connection`；nginx 需 `proxy_http_version 1.1` + `map $http_upgrade $connection_upgrade`；Caddy 的 `reverse_proxy` 默认支持。
- 必须代理的路径：`/`（静态）、`/api/v1/*`、`/ws/worker`（reverse-ws 注册）、`/api/v1/machines/:id/proxy/ws/*`（代理 WS）。
- 超时：普通 API 120 秒；镜像拉取、上传/下载、备份下载等约 620 秒。反代 `read_timeout`/`proxy_read_timeout` 至少 620s。
- 请求体：worker 默认上传上限 100 MiB；core 代理 `bodyLimit` 110 MiB；nginx `client_max_body_size` 建议 ≥ 128m。core 普通 JSON body 8 MiB。
- 真实 IP：设置 `MPANEL_TRUST_PROXY=true`（core），否则 rate limit 会把所有客户端看成反代地址。
- HTTPS：设置 `MPANEL_PUBLIC_URL=https://…`；Cookie 自动 `Secure`。同站部署用 `SameSite=Lax`；跨站前端才用 `SameSite=None; Secure` 并配置 CORS。
- 安全头：由 core 静态托管负责 CSP/nosniff/Referrer-Policy；反代不要再叠加一个更严格的 CSP（多个 CSP 会取交集，可能把 dbx iframe 拦掉）。

示例见 [`../deploy/nginx.conf.example`](../deploy/nginx.conf.example) 与 [`../deploy/Caddyfile.example`](../deploy/Caddyfile.example)。

### 7.3 单机直连模式

没有 core 时，静态服务器同时托管 `web/dist`，并把 `/api/v1`、`/ws` 反代到 worker。浏览器连接类型选 `worker`，输入 worker token。此模式没有 `/machines*` 与 `/system/overview`，这是预期行为。

## 8. systemd 部署注意事项

> 本节与 `deploy/systemd/*.service` 未在本机验证（无 systemd），首次上线前请在预发演练。

1. 创建运行用户与目录：

```bash
sudo useradd --system --home /var/lib/mpanel --shell /usr/sbin/nologin mpanel
sudo install -d -o mpanel -g mpanel /opt/mpanel/core /opt/mpanel/worker /opt/mpanel/web
sudo install -d -o mpanel -g mpanel -m 700 /var/lib/mpanel/core /var/lib/mpanel/worker
sudo install -d -o root -g mpanel -m 750 /etc/mpanel
```

2. 发布物：`/opt/mpanel/core`、`/opt/mpanel/worker` 必须是 `pnpm deploy` 输出（`dist` + 生产 `node_modules`）；`/opt/mpanel/web` 是 `web/dist`。
3. 环境文件：`/etc/mpanel/core.env`、`/etc/mpanel/worker.env`，`chmod 600`，属主 root:mpanel；systemd 以 `mpanel` 读取时需可读。
4. 安装单元：

```bash
sudo cp deploy/systemd/mpanel-core.service deploy/systemd/mpanel-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mpanel-core mpanel-worker
```

5. 单元里的 hardening（`ProtectSystem=strict`、`NoNewPrivileges`、`CapabilityBoundingSet=`、`RestrictAddressFamilies` 等）会限制可写路径：
   - core 只需写 `$MPANEL_CORE_HOME`；stdio 机器的 `state/`、`workers/` 也在其中。
   - worker 需要写 `$MPANEL_HOME`、Caddy 配置目录、站点/文件根、数据库备份目录；用 `ReadWritePaths=` 显式放开。
   - 如果站点/文件根在 `/home` 下，注意 `ProtectHome=read-only` 的影响，必要时调整或去掉。
6. Docker 管理：worker 用户需能访问 `/var/run/docker.sock`。可把用户加入 `docker` 组（`SupplementaryGroups=docker`），但注意这等价于 root 权限；也可以配置 rootless Docker。
7. Caddy：面板不启动/守护 Caddy。Caddy 的 systemd 单元应 `--config` 指向 worker 的 `$MPANEL_HOME/caddy/Caddyfile`，并允许 worker 用户写该目录；否则重启 Caddy 会丢失面板刚 apply 的配置。
8. stdio：`MPANEL_ALLOW_STDIO=1` 只在确实需要时开启；stdio 机器等于在 core 主机执行命令，`MPANEL_WORKER_ENTRY` 必须指向可读的 worker 入口。stdio worker 继承 core 单元的命名空间/`ReadWritePaths`/设备策略；如果它需要 Docker、Caddy 配置目录或额外可写路径，优先把 worker 作为独立 systemd 服务运行，而不是 stdio。
9. 日志：core 只有 stderr，所以 systemd 下用 `journalctl`；worker 另有 `logs/worker.log`。若要保留 journal，配置 `SystemMaxUse=` 或 logrotate。
10. 重启顺序：先 core 后 worker；停止时先 worker 后 core（减少 core 记录离线噪声）。

## 9. Docker 部署注意事项

> `deploy/Dockerfile.core`、`deploy/Dockerfile.worker`、`deploy/docker-compose.yml` 未在本机构建/运行验证（无 Docker）。以下为设计与运维要点。

- 镜像多阶段构建：builder 安装全部 workspace 依赖并构建，`pnpm deploy --prod` 产出 core/worker 运行目录；runtime 只复制产物，非 root（UID/GID 10001），只保留生产依赖。
- core 镜像同时复制 `web/dist`，设置 `MPANEL_WEB_DIST=/app/web`，自己托管前端。
- worker 镜像**不包含** Caddy、Docker CLI、PostgreSQL/Redis 客户端；`capabilities` 会显示不可用。要管理这些能力，需自定义镜像或在容器内挂载宿主工具（见下）。
- **容器只能操作容器内文件系统**。要让 worker 管理宿主机 Caddy/Docker：
  - Docker：挂载 `/var/run/docker.sock`。这等于把宿主 root 权限交给容器，且容器内路径与宿主路径不一致，`-v`/Compose 的宿主路径会失效；更安全的做法是把 worker 直接跑在宿主（systemd），或使用 Docker-in-Docker/独立 socket proxy 并接受相应限制。
  - Caddy：把宿主 `caddy` 二进制、`/etc/caddy`、`/var/lib/caddy` 挂进容器，设置 `MPANEL_CADDY_BIN`/`MPANEL_CADDY_CONFIG_DIR`/`MPANEL_CADDY_DATA_DIR`；Caddy 进程在宿主运行时，`MPANEL_CADDY_ADMIN` 不能用 `127.0.0.1`，要指向宿主网关（Linux 常用 `172.17.0.1:2019`，Docker Desktop 用 `host.docker.internal:2019`），并让 Caddy admin 监听该地址（仅可信网络）。
  - 文件/站点根：把宿主目录绑定挂载到容器，且确保 UID 10001 可读写；只读场景加 `:ro`。
- 卷：core 与每个 worker 的 `MPANEL_HOME` 用独立卷；不要把两个 worker 指向同一个卷（锁冲突）。
- 健康检查：core 与 http worker 用 `GET /healthz`；reverse-ws worker 不监听固定端口，镜像的健康检查在非 http 传输下直接通过（见 Dockerfile 注释），实际可用性以 core 机器状态为准。
- 端口：compose 默认只把 core 发布到 `127.0.0.1:8790`；worker 只在 compose 网络内暴露。生产由宿主反向代理终止 TLS。
- 反向代理到 core 时同样需要 WS 透传、620s 超时、≥128m 请求体、`MPANEL_TRUST_PROXY=true`。
- 升级：重建镜像并 `docker compose up -d --no-deps`；先 core 后 worker；状态在卷中，重建容器不丢。
- `docker compose exec core node dist/index.js user add ...` 可以在容器内管理账号；环境变量必须已在 compose 中注入。

## 10. 故障排查表

### 10.1 机器离线

| 检查 | 命令/位置 | 处理 |
|---|---|---|
| core 是否存活 | `curl -s http://127.0.0.1:8790/healthz` | 起 core；看 journald/Docker 日志 |
| 机器状态与 lastError | UI 机器页；`curl -H "authorization: Bearer $CORE_TOKEN" .../api/v1/machines/<id>/health` | 按错误分支处理 |
| 主动测试 | `POST /api/v1/machines/<id>/test`（失败也 200，看 `reachable`/`error`） | 确认网络/凭据 |
| http 传输 | worker 进程；`curl worker /healthz`；core 到 worker 的 URL 是否可达 | 防火墙、端口、容器网络；worker 重启后 token 是否变化 |
| 401/403 | core 日志 `details.stage="auth"`；worker 日志 401 | core 机器档案里的 token 与 worker 的 `MPANEL_TOKEN` 不一致；PATCH 更新 token |
| reverse-ws | worker 日志重连；core `lastError`；`MPANEL_CORE_URL` 是否以 `/ws/worker` 结尾（会自动补）；machineId/secret 是否匹配 | 反代必须透传 `/ws/worker` 的 WS；生产用 `wss://`；secret 轮换后更新 worker；`MPANEL_CORE_INSECURE` 仅调试 |
| reverse-ws 被断开 | core 关闭码 `4001`（新连接优先）、`4002`（协议版本）、`4403`（身份不符） | 检查是否重复启动同一 machineId；版本是否匹配；secret 是否旧 |
| stdio | `MPANEL_ALLOW_STDIO=1`；`MPANEL_WORKER_ENTRY` 是否可读；`$CORE_HOME/logs/workers/<id>.log` | 修复入口路径/权限；连续 5 次失败后需手动 `POST /connect` |
| 全部机器 | `MPANEL_MACHINE_HEALTH_*` 是否被改得过大；core 是否刚重启 | 等待一轮轮询；必要时 `POST /connect` |

### 10.2 Caddy apply 失败

| 现象 | 检查 | 处理 |
|---|---|---|
| `503 UNAVAILABLE`，`stage` 无 | `doctor` 的 caddy 行；`MPANEL_CADDY_BIN`；worker 是否重启过 | 安装 Caddy，设置绝对路径，重启 worker；确认运行用户可执行 |
| `400 stage=validate` | 响应 `details.output`；站点预览；根目录是否在白名单 | 修正域名/upstream/root/header；`file_server.root` 必须在 `MPANEL_SITES_ROOTS` 或文件根内 |
| `502 stage=reload`，`rolledBack=true` | Caddy 进程；`MPANEL_CADDY_ADMIN`；`caddyOutput`；`backups/caddy/` | 启动 Caddy；admin 地址可达；权限；修正后重试 |
| `500`，`rolledBack=false` | 文件系统权限/磁盘满/备份目录不可写 | 修复 `$MPANEL_HOME` 与 caddy 目录权限；磁盘空间；从备份恢复 |
| `409 CONFLICT` | 已有 apply 在进行 | 等 `details.retryAfterMs` 后重试 |
| apply 成功但站点不生效 | Caddy 是否用面板的 Caddyfile 启动；是否 reload 到另一个实例；端口/防火墙；DNS | 让 Caddy `--config $MPANEL_HOME/caddy/Caddyfile`；检查 `caddyOutput`；用配置的域名访问 |
| 重启 Caddy 后配置回退 | Caddy 服务用了自己的静态配置 | 把服务 `ExecStart` 指向面板 Caddyfile，或每次 apply 后 reload 同一个实例 |

手工验证：

```bash
caddy validate --config /var/lib/mpanel/worker/caddy/Caddyfile --adapter caddyfile
caddy reload  --config /var/lib/mpanel/worker/caddy/Caddyfile --adapter caddyfile
```

### 10.3 PTY 不可用

| 检查 | 处理 |
|---|---|
| `doctor` 的 pty 行；`GET /api/v1/system/info` 的 `capabilities.pty` | 看 `reason` 与 `hint` |
| `node-pty` 是可选原生依赖，安装失败不影响 worker | 安装 Python 3、make、C++ 编译器后重装依赖；Docker 构建阶段已包含工具链 |
| 终端仍可创建，但 `pty=false`、resize 无效 | 这是设计好的降级（管道会话）；需要真 PTY 时修复 `node-pty` |
| Windows | 需要 ConPTY（Windows 10 1809+）；旧系统只能管道模式 |
| 容器内 | 使用包含 `node-pty` 构建产物的镜像；不要用 `--ignore-scripts` 安装 |

### 10.4 dbx 未配置 / 打不开

| 检查 | 处理 |
|---|---|
| 数据库页提示“dbx 未配置” | 设置 `VITE_DBX_URL`（构建期）或 `web/dist/config.json` 的 `dbxUrl`（运行时优先）；重新构建/刷新 |
| iframe 被 CSP 拦截 | core 设置 `MPANEL_DBX_ORIGIN=https://dbx.example.com`（纯 origin，不带路径），重启 core；或自定义 `MPANEL_CSP` 的 `frame-src` |
| handoff redeem CORS 失败 | `MPANEL_DBX_ORIGIN` 必须与 dbx 实际 origin 完全一致；redeem 只允许该 origin，且不带 cookie |
| 票据过期/已被消费 | ticket TTL 60 秒、一次性；重新点“打开 dbx”生成新票据 |
| dbx 不支持跨域 | 把 dbx 反代到面板同源路径（如 `/dbx`），`dbxUrl` 填该路径 |
| 查询控制台不可用但档案/备份正常 | 这是预期：dbx 只影响查询 iframe，不影响数据库档案、测试、备份恢复 |

### 10.5 其他常见问题

| 现象 | 检查 | 处理 |
|---|---|---|
| worker/core 启动退出码 2 | stderr 中文配置清单 | 修正非法端口/transport/URL/非绝对路径/密钥长度 |
| `EADDRINUSE` | 端口占用 | 改端口；确认没有重复实例（锁文件） |
| 登录后立刻掉线 | `MPANEL_SESSION_SECRET` 是否每次启动变化；`session.secret` 是否可写；Cookie Secure/SameSite；反代 HTTPS | 固定密钥文件；HTTPS 下 `MPANEL_COOKIE_SECURE=true`；跨站用 `SameSite=None; Secure` |
| 登录 401 且无锁定提示 | 用户不存在/密码错；bootstrap 是否已完成 | `user list`；重新初始化或 `user passwd` |
| 上传 413 | 反代 body 上限；worker `MPANEL_MAX_UPLOAD_BYTES`；core 代理 110 MiB | 提高 nginx `client_max_body_size`；确认不超过 worker 配置 |
| 文件操作 `FORBIDDEN`/`UNAVAILABLE` | 文件根是否存在、UID 权限、是否符号链接 | 修正目录权限；不要用符号链接逃逸；把根加入 `MPANEL_FILES_ROOTS` |
| 任务不执行 | 任务是否 enabled；cron 时区；worker 是否在跑；`logs/tasks/` | 看运行历史与日志；`next-runs` 校验 cron；检查 shell 路径 |
| 审计缺失 | `MPANEL_CORE_HOME/audit.jsonl` 权限/磁盘；审计写入失败只记录不阻断请求 | 修复目录/磁盘；`GET /api/v1/system/audit` 验证 |

## 11. 与历史设计文档的已知差异（以代码为准）

维护旧部署脚本或阅读 `docs/architecture.md` / `docs/file-layout.md` 时，注意以下差异。本手册与根 README 按**当前代码**描述；历史设计文档未在本任务范围内修改。

| 主题 | 历史文档写法 | 当前代码/本手册 |
|---|---|---|
| core 默认端口 | `architecture.md` §3.4、`file-layout.md` §4.2 写 `8790` | `server/core/src/config.ts` 在未设置 `MPANEL_LISTEN`/`MPANEL_PORT`/`MPANEL_CORE_PORT` 时回退 `8788`；示例统一显式设 `8790` |
| core 日志文件 | `architecture.md` §7.2 列 `logs/core.log` | core 只写 stderr（systemd→journald，Docker→日志驱动）；没有 `core.log` |
| 回收站布局 | `architecture.md` §7.2 写 `trash/<trashId>/{manifest.json,data/}` | `server/worker/src/modules/files/sandbox.ts` 实际为 `trash/<YYYY-MM-DD>/<trashId>/{meta.json,payload}` |
| root scripts | `file-layout.md` §5.1 的 `build:shared`/`typecheck` 写法 | 以根 `package.json` 为准：`build:shared` 直接调用 `node node_modules/typescript/bin/tsc -b server/shared`；`typecheck` 用 `tsc -b` |
| pnpm 构建白名单 | `file-layout.md` §5.1 写 `onlyBuiltDependencies` | `pnpm-workspace.yaml` 实际用 `allowBuilds` |
| 登录限流 | `architecture.md` §6.1 写“连续 5 次失败锁定 30 秒” | `server/core/src/auth/index.ts` 使用 5 次/60 秒滑动窗口，超限返回 `retryAfterSec` |
| 会话 Cookie 有效期 | 历史文档写 7 天 | `MPANEL_TOKEN_TTL` 默认 12h，会话默认跟随；`MPANEL_SESSION_TTL_HOURS` 可覆盖（部署模板用 168） |
| core `/config.json` | 旧部署说明称由 `MPANEL_PUBLIC_URL` 自动生成 | 若 `web/dist/config.json` 存在（默认构建产物就有），core 原样提供；仅文件不存在时才按 env 生成回退配置 |
| worker `MPANEL_PUBLIC_URL` | `server/worker/src/config.ts` 注释称用于 ticket/redeem 绝对地址 | 当前 handoff redeem 固定相对路径，该值仅保留兼容/预留 |
| 项目状态 | 旧根 README 写 “skeleton / stubs” | 当前实现可端到端运行，`scripts/check.mjs` 与 `scripts/smoke.mjs` 通过 |

## 12. 边缘节点

边缘节点是「用入网密钥自助注册的 reverse-ws 机器」，运维上等价于 reverse-ws，只是不需要预建机器。

### 12.1 接入排查

| 现象 | 检查 |
|---|---|
| worker 启动即退出，提示入网失败 | `MPANEL_CORE_URL` 必须是 **HTTP(S) 基地址**（如 `https://panel.example.com`），不是 `ws://…/ws/worker`；worker 会自行派生 enroll 地址与 WS 地址 |
| 403 / FORBIDDEN | 密钥已吊销、已过期、`uses >= maxUses`，或 core 拒绝创建（`MPANEL_ALLOW_STDIO` 与此无关） |
| core 看不到节点 | 审计里应有 `edge.enroll`；没有则请求没到 core，查反代是否放行 `POST /api/v1/edge/enroll` |
| 节点反复离线 | 反代必须支持 `Upgrade`/`Connection` 头；worker 日志有指数退避重连；确认 `MPANEL_TRUST_PROXY` 与 WS 超时配置 |

### 12.2 身份与轮换

- 身份在 `$MPANEL_HOME/edge.json`（0600）：`machineId`、`secret`、`coreUrl`、`keyFingerprint`（只存前缀）。
- 删除该文件并保留 `MPANEL_EDGE_KEY` 会重新入网，**生成一台新机器**（旧机器记录需手工删除）。
- 吊销入网密钥不影响已入网节点——它们用各自的 machine secret；要踢掉节点用「断开/删除机器」或
  `POST /machines/:id/secret/rotate`（旧连接立即失效）。

### 12.3 快照与作业

- 快照：节点上线立即取一次，之后每 5 分钟刷新；失败只记 `lastError`，不改变在线状态。
- 作业：`pending` 表示节点离线或排队中；重连后按 `createdAt` 串行补跑；网络失败最多重试 1 次，
  业务 4xx 直接 `failed`。结果超过 16KB 会被截断并标 `truncated`。
- core 单点：作业队列在 core 的本地 JSON 里，core 不可用期间不会执行；迁移 core 主机请连同
  `$MPANEL_CORE_HOME` 一起备份恢复。
