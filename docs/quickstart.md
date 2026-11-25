# 快速开始：从零到第一个站点

本文只做一件事：在一台机器上把 MPanel 跑起来，连上 worker，创建并看到一个静态站点。生产部署、备份、升级与排障见 [`operations.md`](operations.md)。

命令以 POSIX shell 书写，已在 Windows Git Bash 下验证；Linux/macOS 同理。PowerShell 用户请把 `export X=Y` 换成 `$env:X="Y"`。所有路径示例都以仓库根目录为当前目录。

## 0. 前置检查

```bash
node -v     # 需要 >= 24
pnpm -v     # 需要 12.10.1；没有就用 corepack enable && corepack prepare pnpm@12.10.1 --activate
```

如果你是第一次运行仓库：

```bash
pnpm install
pnpm build
```

`pnpm build` 会构建 `server/shared`、`server/core`、`server/worker` 的 `dist` 和 `web/dist`。后续命令都使用构建产物；只跑源码 watcher 时可用 `pnpm dev`，但首次上手建议按本文分步启动。

可选的自检（不需要外部服务）：

```bash
node scripts/check.mjs
node scripts/smoke.mjs
```

## 1. 生成 worker token 并启动 worker

worker 没有匿名模式，`serve` 必须有 `MPANEL_TOKEN`。最简单的做法是让 CLI 生成并写入 `$MPANEL_HOME/config.json`：

```bash
node server/worker/dist/index.js token generate --length 32 --write --home ./mpanel-home
```

输出示例（token 只显示一次，请保存好）：

```text
DCk5fWyUQqu-44EZRp7cKYWMikuE1rmDc_YPCN_FPz8
已写入 /…/mpanel-home/config.json
```

启动 worker（http 传输）：

```bash
export MPANEL_HOME=./mpanel-home
export MPANEL_CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
node server/worker/dist/index.js serve
```

看到类似 `worker 已就绪` 的 JSON 日志即启动成功（日志写 stderr，stdout 只输出端口发现事件）。另开终端验证：

```bash
curl -s http://127.0.0.1:8787/healthz
# {"ok":true,"status":"ok","version":"0.1.0","role":"worker"}
```

### 没有写 token 就启动会怎样

`serve` 会以退出码 2 拒绝启动，并打印中文配置错误：

```text
配置无效：
  - MPANEL_TOKEN 未配置：serve 需要静态访问令牌，可运行 `mpanel-worker token generate --write` 生成并写入配置
```

这是有意设计：worker 不会静默降级为无认证。

### 诊断当前主机

```bash
node server/worker/dist/index.js doctor --home ./mpanel-home
```

`doctor` 打印配置与 `caddy / docker / postgres / redis / pty` 能力表。能力不可用**不算失败**，退出码仍为 0；它只影响对应模块的写操作。

## 2. 启动 web 开发服务器并连接

另开一个终端：

```bash
pnpm --filter @mpanel/web dev
```

Vite 默认监听 <http://localhost:5173>。浏览器打开后：

1. 点 **新增连接**；
2. 类型选 `worker · 直连（Bearer token）`；
3. 名称随意，地址填 `http://127.0.0.1:8787`（服务根地址，不要带 `/api/v1`）；
4. token 填第 1 步打印的值，或打开 `mpanel-home/config.json` 复制 `token`；
5. 点 **测试连接**，应显示 `连接成功 · mpanel-worker v0.1.0 · N ms`；
6. **添加连接**，进入面板。

> 为什么需要 CORS：Vite 在 `localhost:5173`，worker 在 `127.0.0.1:8787`，浏览器把两者视为不同 origin。上面的 `MPANEL_CORS_ORIGINS` 同时列了 `localhost:5173` 和 `127.0.0.1:5173`，所以两种打开方式都能用。生产环境只列真实的面板域名。

## 3. 创建第一个文件

左侧进入 **文件**：

1. 文件根选择默认的 `files`（对应 `mpanel-home/files`）；
2. 新建目录 `demo`；
3. 进入 `demo`，新建/编辑 `index.html`，内容例如：

```html
<!doctype html>
<meta charset="utf-8" />
<title>MPanel demo</title>
<h1>Hello from MPanel</h1>
```

4. 保存后应能在文件列表里看到该文件。

这一步不需要 Caddy 或 Docker。

## 4. 创建第一个站点（需要 Caddy 才能 apply）

左侧进入 **站点** → **新建站点**，按下表填写：

| 字段 | 值 |
|---|---|
| 站点名称 | `demo` |
| 域名 | `localhost` |
| 监听地址（可选） | `127.0.0.1:8080` |
| 处理方式 | `静态文件` |
| 根目录 | `mpanel-home/files/demo` 的**绝对路径**（例如 `/home/me/MPanel/mpanel-home/files/demo`） |
| TLS | `off`（本机演示不签证书） |
| 启用 | 开 |

说明：

- 默认文件根会自动加入 `MPANEL_SITES_ROOTS` 白名单，因此 `files/demo` 可以直接作为站点根；也可以用 `MPANEL_SITES_ROOTS` 显式配置其他目录。
- 根目录必须是绝对路径；不在白名单内会返回 `BAD_REQUEST`，提示把目录加入 `MPANEL_SITES_ROOTS` 或 `MPANEL_FILES_ROOTS`。
- 站点只接受结构化配置，不支持粘贴原始 Caddyfile 片段。

### 4.1 没有安装 Caddy 时会发生什么

这是正常降级，不是崩溃：

- **站点** 页仍能创建/编辑/删除草稿；
- **预览** 仍生成 Caddyfile 片段，但 `validation` 为 `null`，并带 `validationUnavailableReason`；
- **应用** 返回 `503 UNAVAILABLE`，`details.hint` 为“安装 Caddy 或设置 `MPANEL_CADDY_BIN` 指向 caddy 可执行文件后重试”；
- `doctor` 的 `caddy` 一行显示“不可用 未找到可执行文件：caddy”。

安装 Caddy（任选其一）：

- 按官方文档安装：<https://caddyserver.com/docs/install>（Linux 包管理器、macOS Homebrew、Windows 下载 zip 均可）；
- 或下载单个二进制，放到 PATH，或设置绝对路径：

```bash
export MPANEL_CADDY_BIN=/opt/caddy/caddy
```

改完环境变量后**重启 worker**（配置在启动时读取）。再运行 `doctor`，`caddy` 应显示版本。

### 4.2 让 Caddy 使用面板生成的配置

面板不负责启动/守护 Caddy；它只写 `$MPANEL_HOME/caddy/Caddyfile` 与 `sites.d/`，然后执行 `caddy validate` 与 `caddy reload`（或 admin API）。

首次 apply 前，先给 Caddy 一个可运行的根配置，否则 reload 无处可去：

```bash
mkdir -p mpanel-home/caddy/sites.d
cat > mpanel-home/caddy/Caddyfile <<'EOF'
import sites.d/*.caddy
EOF
printf '# 等待 MPanel 写入站点\n' > mpanel-home/caddy/sites.d/placeholder.caddy

# 前台运行，保持这个终端不关；生产应改成 systemd/服务
caddy run --config "$PWD/mpanel-home/caddy/Caddyfile" --adapter caddyfile
```

`caddy reload` 默认通过 `127.0.0.1:2019` 的 admin API 生效。如果 Caddy 在容器/另一个命名空间，设置 `MPANEL_CADDY_ADMIN=host:port` 让 worker 能访问；也可以让 Caddy 的启动配置直接指向面板的 Caddyfile，这样重启后仍然是面板的配置。

### 4.3 预览并应用

1. 站点编辑页点 **预览**：确认生成的 `localhost { bind ... root * ... file_server }` 片段；
2. 点 **应用**（或站点列表的“全量应用”）；
3. 成功后面板显示 `applied`，并返回 `caddyfilePath`、`backupPath`（首次 apply 可能为 `null`）和 `caddyOutput`；
4. 浏览器访问 <http://localhost:8080>，应看到 `Hello from MPanel`。

如果 `apply` 失败：

- `validate` 阶段失败：返回 `400 BAD_REQUEST`，线上配置不变；按提示修正域名/根目录/上游；
- `reload` 阶段失败：返回 `502 UPSTREAM_ERROR` 并回滚；检查 Caddy 是否在运行、admin 地址是否可达、`MPANEL_CADDY_ADMIN` 是否正确；
- Caddy 不存在：返回 `503 UNAVAILABLE`，先完成 4.1。

## 5. 可选：启动 core（多机模式）

单机直连已经可用。要体验多机，再启动 core（**另开终端**，不要与 worker 共用 `MPANEL_HOME`）：

```bash
export MPANEL_CORE_HOME=./mpanel-core
export MPANEL_LISTEN=127.0.0.1:8790
export MPANEL_PUBLIC_URL=http://127.0.0.1:8790
export MPANEL_ADMIN_USER=admin
export MPANEL_ADMIN_PASSWORD='change-this-password'   # 至少 10 个字符
pnpm start:core
```

打开 <http://127.0.0.1:8790>（core 直接托管 `web/dist`）。构建产物自带的 `config.json` 没有预置后端，所以先新增连接：类型 `core`、地址 `http://127.0.0.1:8790`、名称随意，保存后用上面的账号登录。然后：

1. **机器** → **添加机器**；
2. 类型 `http`；
3. 地址填 `http://127.0.0.1:8787`，token 填 worker 的 `MPANEL_TOKEN`；
4. 保存/连接。健康轮询成功后状态为 `online`，在顶部机器切换器选中它，站点/文件/容器等页面就会通过 core 的 `/api/v1/machines/<id>/proxy/*` 访问。

### reverse-ws（worker 在 NAT/防火墙后）

1. 在 core 的 **机器** 页新建 `reverse-ws` 机器；
2. 创建响应里的 `enrollment.workerEnv` 只显示一次，包含 `MPANEL_TRANSPORT=reverse-ws`、`MPANEL_CORE_URL`、`MPANEL_MACHINE_ID`、`MPANEL_MACHINE_SECRET`、`MPANEL_TOKEN`；
3. 在目标主机用这些变量启动 worker：

```bash
export MPANEL_TRANSPORT=reverse-ws
export MPANEL_CORE_URL=wss://panel.example.com/ws/worker
export MPANEL_MACHINE_ID=m_xxx
export MPANEL_MACHINE_SECRET=mp_xxx
export MPANEL_TOKEN=<enrollment 里的 loopback token>
export MPANEL_HOME=/var/lib/mpanel/worker
node dist/index.js serve
```

worker 主动拨号 core，不需要开放入站端口；反代必须为 `/ws/worker` 透传 WebSocket。生产使用 `wss://`，`MPANEL_CORE_INSECURE=1` 只用于本地自签证书调试。

### 边缘节点（不预建机器，用入网密钥自助注册）

1. core 的 **边缘节点** 页新建入网密钥（可设分组、有效期、最大使用次数），密钥只显示一次；
2. 在目标主机启动 worker，只需要出站网络：

```bash
export MPANEL_TRANSPORT=reverse-ws
# 注意：填 HTTP(S) 基地址，不是 ws://.../ws/worker
export MPANEL_CORE_URL=https://panel.example.com
export MPANEL_EDGE_KEY=mpedge_xxx
export MPANEL_HOME=/var/lib/mpanel/worker
node dist/index.js serve
```

3. worker 先 `POST /api/v1/edge/enroll` 换取机器身份，写入 `$MPANEL_HOME/edge.json`（0600），随后拨 `/ws/worker`；节点会自动出现在列表里。
4. 节点离线时可以在 **边缘节点 → 作业** 里排队 `snapshot` / `run-task` / `apply-site`，重连后串行补跑。

### stdio（仅同机，危险开关）

core 设置 `MPANEL_ALLOW_STDIO=1` 后可创建 stdio 机器；core 会 spawn worker 子进程，等价于在 core 主机执行命令。只应给可信管理员使用。`MPANEL_WORKER_ENTRY` 需指向 worker 的 `dist/index.js`。

## 6. 没有 Docker / dbx 时会怎样

### Docker 未安装或 daemon 未运行

- **容器 / 镜像 / 编排** 页显示 `available:false` 和原因（例如“未找到 docker CLI：docker”或“docker daemon 不可达”）；
- 列表不会报错崩溃；启动/停止/拉取等写操作返回 `UNAVAILABLE` 与可执行提示；
- `doctor` 的 `docker` 一行显示不可用。

处理：安装 Docker Engine 或 Docker Desktop，确认 `docker version` 能同时显示 client 与 server；Linux 上让 worker 运行用户有权限访问 `/var/run/docker.sock`（加入 `docker` 组或配置 rootless）；如果二进制不在 PATH，设置 `MPANEL_DOCKER_BIN`；重启 worker。

### dbx 未配置

- 数据库档案、测试、备份/恢复仍可用；
- 数据库页的查询控制台显示“dbx 未配置：查询控制台不可用”，不会让页面崩溃；
- 配置方式：构建期 `VITE_DBX_URL=https://dbx.example.com`，或部署目录 `config.json` 的 `dbxUrl`（运行时优先）；
- 若 dbx 要跨域调用 handoff redeem，core 还需设置 `MPANEL_DBX_ORIGIN=https://dbx.example.com`（加入 CSP `frame-src` 与 CORS 白名单），并重启 core；
- 如果 dbx 不支持跨域，可把它反向代理到面板同源路径（例如 `/dbx`），再把 `dbxUrl` 设为该路径。

## 7. 常见起步问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 测试连接失败 / 浏览器控制台 CORS 错误 | `MPANEL_CORS_ORIGINS` 没包含当前页面 origin | 加入 `http://localhost:5173` 与/或 `http://127.0.0.1:5173`，重启 worker |
| `401 UNAUTHORIZED` | token 错误、复制了旧 token、或 worker 重启后换了 token | 从 `$MPANEL_HOME/config.json` 重新复制；必要时重新生成并更新连接 |
| worker 启动即退出，退出码 2 | 配置非法（token 缺失、端口非法、路径非绝对等） | 看 stderr 的中文配置清单；`doctor` 也会打印当前配置 |
| `EADDRINUSE` | 8787/8790 已被占用 | 改 `MPANEL_PORT`/`MPANEL_LISTEN`，同步更新连接地址 |
| apply 返回 `503 UNAVAILABLE` | Caddy 不可用 | 安装 Caddy 或设置 `MPANEL_CADDY_BIN`，重启 worker |
| apply 返回 `502` 且 `rolledBack=true` | Caddy 没运行 / admin API 不可达 / reload 失败 | 启动 Caddy，检查 `MPANEL_CADDY_ADMIN`，看 `caddyOutput` |
| 站点 404 | 域名/Host 不匹配，或根目录没有 `index.html` | 用配置的域名访问（本例 `http://localhost:8080`），检查根目录 |
| 终端 `pty=false` | `node-pty` 未安装/加载失败 | 终端仍可用（管道模式，resize 无效）；需要 PTY 时安装构建工具后重装 `node-pty` |

更多生产问题见 [`operations.md`](operations.md) 的故障排查表。
