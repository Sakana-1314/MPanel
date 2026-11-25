# 部署 MPanel

MPanel 有三个发布物：

| 发布物 | 内容 | 运行方式 |
|---|---|---|
| `core` | `dist` + 生产 `node_modules`（`@mpanel/shared`、fastify 等） | `node dist/index.js serve` |
| `worker` | `dist` + 生产 `node_modules`（含可选 `node-pty`） | `node dist/index.js serve` |
| `web` | `web/dist` 静态文件（可含运行时 `config.json`） | core 托管，或 Caddy/nginx 直接托管 |

> **验证状态**：`pnpm deploy:core` / `pnpm deploy:worker` 已在本机实际运行并生成 `out/core`、`out/worker`（dist + 生产依赖，直接可执行）。**本目录的 Dockerfile、docker-compose.yml 与 systemd 单元未在本机验证**（本机没有 Docker 与 systemd）；首次上线前请在预发环境构建/启动并检查日志。本文中的 Docker/systemd 命令按 Linux 生产环境编写。

## 文件清单

```text
deploy/
├─ Dockerfile.core              # 多阶段、非 root、只装生产依赖、健康检查
├─ Dockerfile.worker            # 同上；镜像不含 Caddy/Docker/DB CLI
├─ docker-compose.yml           # core + http worker + reverse-ws worker（profile）
├─ compose.env.example          # Compose 插值变量示例
├─ systemd/
│  ├─ mpanel-core.service       # hardening + StateDirectory
│  └─ mpanel-worker.service     # hardening + ReadWritePaths + Docker/PTY 注意事项
├─ env/
│  ├─ core.env.example          # /etc/mpanel/core.env
│  └─ worker.env.example        # /etc/mpanel/worker.env
├─ nginx.conf.example           # 反代 core，透传 WS
├─ Caddyfile.example            # 反代 core，透传 WS
└─ windows/README.md            # NSSM 与 Windows 语义说明
```

## 1. 构建发布物

在仓库根目录：

```bash
pnpm install --frozen-lockfile
node scripts/check.mjs        # 可选门禁
node scripts/smoke.mjs        # 可选端到端冒烟（临时目录/随机端口）
pnpm build

pnpm deploy:core              # -> out/core
pnpm deploy:worker            # -> out/worker
# web: web/dist（pnpm build 已产出）
```

**不要只复制 `dist`**：core/worker 通过包 exports 解析 `@mpanel/shared` 与 `zod`，生产依赖必须在同目录 `node_modules` 中；`pnpm deploy` 负责这件事。systemd 的 `WorkingDirectory` 与 Docker 的构建目标都指向该输出。

推荐发布目录：

```text
/opt/mpanel/releases/<version>/{core,worker,web}
/opt/mpanel/core   -> releases/<version>/core
/opt/mpanel/worker -> releases/<version>/worker
/opt/mpanel/web    -> releases/<version>/web
```

## 2. Docker

### 2.1 构建镜像

从仓库根目录构建（Dockerfile 需要看到整个 workspace 的 package manifests 与源码）：

```bash
docker build -f deploy/Dockerfile.core   -t mpanel-core:0.1.0 .
docker build -f deploy/Dockerfile.worker -t mpanel-worker:0.1.0 .
```

两个镜像都是多阶段构建：

- builder：启用 corepack/pnpm 12.10.1，安装 workspace 依赖（含 `node-pty` 原生构建所需的 python3/make/g++）；core 镜像构建 shared/core/web，worker 镜像构建 shared/worker；最后 `pnpm deploy --prod`；
- runtime：`node:24-bookworm-slim`，只复制 deploy 产物，非 root（UID/GID `10001`），`HEALTHCHECK` 调 `/healthz`，`STOPSIGNAL SIGTERM`。
- core 镜像额外复制 `web/dist` 到 `/app/web`，设置 `MPANEL_WEB_DIST=/app/web`。
- worker 镜像不包含 Caddy、Docker CLI、psql/pg_dump/redis-cli；对应能力会显示 `available=false`，除非你扩展镜像或挂载宿主工具。

> 构建上下文没有根 `.dockerignore`，Docker 会把 `node_modules/`、`out/` 等发送给 daemon。Dockerfile 只 `COPY` 明确的源码路径，不会把宿主 `node_modules` 带进镜像；但建议在仓库根添加 `.dockerignore`（`node_modules`、`dist`、`out`、`.git`、`.env*`）以加快构建。

### 2.2 Compose

```bash
cp deploy/compose.env.example deploy/compose.env
# 编辑：MPANEL_PUBLIC_URL、WORKER_HTTP_TOKEN，按需设置管理员/密钥/dbx
docker compose -f deploy/docker-compose.yml --env-file deploy/compose.env up -d --build
```

默认启动 `core` 与 `worker-http`：

- core 发布到 `127.0.0.1:8790`（`MPANEL_BIND_ADDRESS` 可改），由宿主 Caddy/nginx 终止 TLS；
- core 托管前端；`MPANEL_PUBLIC_URL` 用于 reverse 注册地址与 Cookie 默认值。core 会优先原样提供 `web/dist/config.json`（构建产物里有一个最小配置）；要在容器里预置 core 连接，挂载自定义 `config.json` 到 `/app/web/config.json`，或直接在 UI 新增连接。只有该文件不存在时，core 才按 `MPANEL_PUBLIC_URL`/`MPANEL_DBX_ORIGIN` 生成回退配置；
- `worker-http` 只在 Compose 网络内暴露 `8787`。在 core 的 **机器** 页添加 http 机器时，地址填 `http://worker-http:8787`，token 填 `WORKER_HTTP_TOKEN`；
- `worker-reverse` 默认不启动。先在 core 创建 reverse-ws 机器，把一次性 `workerEnv` 填进 `compose.env`，然后：

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/compose.env \
  --profile reverse-ws up -d worker-reverse
```

### 2.3 卷与只读挂载

- `core-data` → `/var/lib/mpanel/core`
- `worker-http-data` → `/var/lib/mpanel/worker`
- `worker-reverse-data` → `/var/lib/mpanel/worker`
- 只读站点根示例写在 compose 注释里（`/srv/www:/srv/www:ro`）；需要上传/编辑时改成可写，并设置 `MPANEL_FILES_ROOTS` / `MPANEL_SITES_ROOTS`。
- 绑定挂载的宿主目录必须让 UID `10001` 可读写。

### 2.4 容器内操作宿主的边界

容器只能看到自己的文件系统。要让 worker 管理宿主机：

- **Docker**：挂载 `/var/run/docker.sock`。这等于把宿主 root 权限交给容器；且容器内路径与宿主路径不同，`-v`/Compose 的宿主路径会失效。
- **Caddy**：挂载宿主 `caddy` 二进制、`/etc/caddy`、`/var/lib/caddy`，并设置 `MPANEL_CADDY_BIN`/`MPANEL_CADDY_CONFIG_DIR`/`MPANEL_CADDY_DATA_DIR`。宿主 Caddy 的 admin 地址不能用 `127.0.0.1`，要指向容器可达的宿主网关（Linux 常见 `172.17.0.1:2019`，Docker Desktop 用 `host.docker.internal:2019`），并确保 Caddy admin 只监听可信网络。
- **文件/站点根**：绑定挂载宿主目录并调整权限。
- 更安全的替代：**worker 直接跑在宿主（systemd）**，容器只跑 core。此时 worker 镜像里的 `/bin/sh` 等不影响宿主命令，但没有宿主 Caddy/Docker 权限。

### 2.5 健康检查

- core：`GET /healthz`（镜像内置）。
- http worker：`GET /healthz`（镜像内置）。
- reverse-ws/stdio worker：不监听固定端口，镜像健康检查直接通过；真实可用性以 core 的机器状态/健康轮询为准。

## 3. systemd

> 未在本机验证；请先在预发主机执行 `systemd-analyze verify` 并启动观察。

1. 创建用户与目录：

```bash
sudo useradd --system --home /var/lib/mpanel --shell /usr/sbin/nologin mpanel
sudo install -d -o mpanel -g mpanel /opt/mpanel/core /opt/mpanel/worker /opt/mpanel/web
sudo install -d -o mpanel -g mpanel -m 700 /var/lib/mpanel/core /var/lib/mpanel/worker
sudo install -d -o root -g mpanel -m 750 /etc/mpanel
```

2. 把 `out/core`、`out/worker`、`web/dist` 发布到 `/opt/mpanel/{core,worker,web}`。
3. 复制并填写环境文件：

```bash
sudo cp deploy/env/core.env.example /etc/mpanel/core.env
sudo cp deploy/env/worker.env.example /etc/mpanel/worker.env
sudo chmod 600 /etc/mpanel/*.env
sudo chown root:mpanel /etc/mpanel/*.env
# 编辑 token、MPANEL_PUBLIC_URL、CORS、Caddy 路径等
```

4. 安装单元：

```bash
sudo cp deploy/systemd/mpanel-core.service deploy/systemd/mpanel-worker.service /etc/systemd/system/
sudo systemd-analyze verify /etc/systemd/system/mpanel-core.service /etc/systemd/system/mpanel-worker.service
sudo systemctl daemon-reload
sudo systemctl enable --now mpanel-core mpanel-worker
sudo journalctl -u mpanel-core -u mpanel-worker -f
```

### 3.1 单元假设与 hardening

- `WorkingDirectory=/opt/mpanel/{core,worker}` 必须是 `pnpm deploy` 输出；`node dist/index.js serve` 依赖同目录 `node_modules`。
- `StateDirectory=mpanel/{core,worker}` 创建 `/var/lib/mpanel/{core,worker}`；env 里的 `MPANEL_CORE_HOME`/`MPANEL_HOME` 必须指向同一路径。
- `ProtectSystem=strict` 把整个文件系统设为只读，只放开 `ReadWritePaths`。worker 默认放开 `/var/lib/mpanel/worker`、`/etc/caddy`、`/var/lib/caddy`、`/srv/www`（不存在的路径用 `-` 前缀忽略）。自定义站点/文件根时必须补进 `ReadWritePaths`。
- core 使用 `ProtectHome=true`、`PrivateDevices=true`；worker 使用 `ProtectHome=read-only` 且**不**启用 `PrivateDevices`（PTY/Docker 需要设备）。
- worker 的 `SystemCallFilter` 默认注释掉：任务/终端会执行任意用户命令，过滤器可能误伤；测试后再开。
- `CapabilityBoundingSet=` 为空、`NoNewPrivileges=true`、`RestrictSUIDSGID=true` 等；不要设置 `MemoryDenyWriteExecute=yes`（Node JIT 需要可写可执行内存）。
- Docker 访问：把 `mpanel` 加入 `docker` 组（单元中 `SupplementaryGroups=docker` 已注释），或配置 rootless Docker。注意这等价于 root 权限。
- Caddy：面板不管理 Caddy 进程。Caddy 服务应 `--config /var/lib/mpanel/worker/caddy/Caddyfile --adapter caddyfile`，否则重启 Caddy 会丢掉面板 apply 的配置。
- stdio：`MPANEL_ALLOW_STDIO=1` 只在需要时开；`MPANEL_WORKER_ENTRY` 指向 `/opt/mpanel/worker/dist/index.js`。

## 4. 反向代理

- 多机模式：反代 **core**（示例 `127.0.0.1:8790`），静态文件也由 core 提供。
- 单机模式：反代 **worker**（`127.0.0.1:8787`），静态文件由反代/独立静态服务器提供。
- 必须透传 `Upgrade`/`Connection`，并覆盖 `/ws/worker`（reverse-ws）与 `/api/v1/machines/:id/proxy/ws/*`（代理 WS）。
- 超时 ≥620s；请求体 ≥128m；core 设 `MPANEL_TRUST_PROXY=true`。
- 示例：[`nginx.conf.example`](nginx.conf.example)、[`Caddyfile.example`](Caddyfile.example)。

## 5. TLS、Cookie 与 CORS

- 在反代终止 TLS；core/worker 默认只监听 loopback。
- 设置 `MPANEL_PUBLIC_URL=https://…`；`MPANEL_COOKIE_SECURE=true`（或留空自动）。
- 同源部署（core 托管 web）用 `SameSite=Lax`；跨站前端才用 `SameSite=None; Secure` 并配置 `MPANEL_CORS_ORIGINS`。
- worker 直连模式：把 web 的 origin 加入 worker `MPANEL_CORS_ORIGINS`；worker token 由用户在连接页输入。
- 不要叠加第二个 CSP：core 的 CSP 已包含 dbx `frame-src`，叠加会取交集。

## 6. 权限、备份与升级

- worker 需要读写 `MPANEL_HOME`、Caddy 配置目录、站点/文件根、数据库备份目录；管理 Docker 还需 socket 权限。
- 备份 `$MPANEL_HOME/state/`、`$MPANEL_CORE_HOME/state/`、两边的 `secrets.key`/`session.secret`、Caddy `Caddyfile`/`sites.d/`/`data/`。`secrets.key` 丢失后已存凭据无法解密。
- 升级顺序：备份 → 构建/部署新版本 → core → 逐台 worker → web。先 core 后 worker（协议仅加法时）；破坏性协议变更按发布说明先停 worker。
- Docker 升级：重建镜像并 `docker compose up -d --no-deps <service>`；状态在卷中。
- 详见 [`../docs/operations.md`](../docs/operations.md)。

## 7. Windows

worker 可原生运行在 Windows（ConPTY 可选）；core 可原生或 Linux。NSSM 示例见 [`windows/README.md`](windows/README.md)。Windows 上 `chmod`/0600 是尽力而为，目录替换不是原子的；生产建议 core 在 Linux、worker 在目标 Windows 主机。
