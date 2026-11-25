# 从源码安装

本页描述把 MPanel 安装到一台 Linux 主机的目标流程：从源码构建 Go 二进制，放到 `/usr/local/bin`，用 systemd 托管 `mpanel-core` 与 `mpanel-agent`，完成首次初始化后通过浏览器访问。

::: warning 实现状态
Go 重写已落地：`cmd/`、`core/`、`agent/` 与全部业务模块均可构建，`go build ./...`、`go vet ./...`、`go test ./...` 在 CI 中作为合并门禁。以下命令均可直接执行。已实现与规划中的完整清单见[首页](/index.md#实现状态)。
:::

## 1. 前置条件

- Linux（amd64 或 arm64），systemd 作为服务管理器。
- Go 工具链版本不低于仓库 `go.mod` 的 `go` 指令（当前为 `1.27.2`）。
- 一个专用系统用户（下文用 `mpanel`），不要用 root 直接运行面板进程。
- 可选外部能力：Caddy（站点）、Docker（容器/编排）、PostgreSQL 客户端工具（`pg_dump`、`psql`）、Redis 客户端（`redis-cli`）。缺少这些不会阻止 agent 启动，只影响对应模块的写操作。

端口约定：

| 进程 | 默认监听 | 用途 |
|---|---|---|
| `mpanel-core` | `0.0.0.0:10086` | 控制面 API、登录、机器代理，可托管 `web/panel` 静态文件 |
| `mpanel-agent` | `0.0.0.0:10087` | 直连模式 API；被 core 以 http 传输管理时也应只对内网开放 |

生产环境不要让 10086/10087 直接暴露公网，统一由反向代理终止 TLS，见[生产部署](/guide/deploy)。

## 2. 从源码构建

```bash
git clone https://github.com/sakana-1314/MPanel.git
cd MPanel

# 构建三个二进制
go build ./cmd/...
```

构建会在当前目录生成三个可执行文件：

| 产物 | 作用 |
|---|---|
| `mpanel-core` | 控制面：登录、机器注册、健康检查、隧道与代理、静态托管 |
| `mpanel-agent` | 功能面：站点、证书、数据库、容器、镜像、编排、文件、终端、计划任务 |
| `mpanelctl` | 控制命令：服务状态/启停辅助、账号与配置检查（子命令随 `cmd/mpanelctl` 落地补齐） |

发布构建建议把版本写入二进制（`core/config.Version` 支持 `-ldflags` 覆盖）：

```bash
VERSION=0.3.0
go build -ldflags "-X github.com/sakana-1314/mpanel/core/config.Version=${VERSION}" ./cmd/...
```

交叉编译到 Linux amd64：

```bash
GOOS=linux GOARCH=amd64 go build ./cmd/...
```

构建前可先做静态检查（仓库验收要求）：

```bash
go build ./...
go vet ./...
go test ./...
```

## 3. 放置二进制与创建目录

```bash
# 专用用户与安装根
sudo useradd --system --home /opt/mpanel --shell /usr/sbin/nologin mpanel
sudo install -d -o mpanel -g mpanel -m 0700 /opt/mpanel
sudo install -d -o mpanel -g mpanel -m 0700 \
  /opt/mpanel/conf /opt/mpanel/data /opt/mpanel/log \
  /opt/mpanel/db /opt/mpanel/backup /opt/mpanel/tmp

# 二进制
sudo install -m 0755 mpanel-core mpanel-agent mpanelctl /usr/local/bin/

# 1Panel 风格的短命令：/usr/bin/mpanel -> mpanelctl
sudo ln -sf /usr/local/bin/mpanelctl /usr/bin/mpanel
```

目录职责（完整说明见[配置文件与环境变量](/guide/config)）：

```text
/opt/mpanel/
├─ conf/
│  ├─ app.yaml            # core 配置
│  ├─ agent.yaml          # agent 配置
│  └─ bootstrap-token     # 首次初始化用，完成后删除
├─ data/                  # core 数据；agent 默认在 data/agent
├─ log/                   # 运行日志
├─ db/                    # 状态文档
├─ backup/                # 备份
└─ tmp/                   # 临时文件
```

首次启动时 `core/config` 会在配置缺失时按默认值创建 `conf/app.yaml` 与 `conf/agent.yaml`，权限 `0600`；`conf/` 目录权限为 `0700`。

## 4. systemd 单元

两份单元都应显式指定 `MPANEL_BASE_DIR=/opt/mpanel`，并只允许写 `/opt/mpanel`。把环境变量放在 `/etc/mpanel/*.env`，权限 `0600`、属主 `root:mpanel`。

### 4.1 `/etc/mpanel/core.env`

```bash
MPANEL_BASE_DIR=/opt/mpanel
# 可选：覆盖 app.yaml 的 system.port / bindAddress
# MPANEL_PORT=10086
# MPANEL_BIND_ADDRESS=127.0.0.1
# MPANEL_LOG_LEVEL=info
```

### 4.2 `/etc/mpanel/agent.env`

```bash
MPANEL_AGENT_BASE_DIR=/opt/mpanel
# 直连 http 模式；reverse-ws / 边缘节点另见 guide/edge
MPANEL_AGENT_TRANSPORT=http
MPANEL_AGENT_LISTEN=0.0.0.0:10087
# 必填：agent 的静态访问令牌。生成方式见第 5 节
MPANEL_AGENT_TOKEN=请替换为至少 32 字节的随机值
# 可选：文件管理根（name=绝对路径，逗号分隔）
# MPANEL_FILES_ROOTS=files=/opt/mpanel/data/files
```

### 4.3 `mpanel-core.service`

```ini
[Unit]
Description=MPanel Core
Documentation=https://github.com/sakana-1314/MPanel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=mpanel
Group=mpanel
EnvironmentFile=-/etc/mpanel/core.env
ExecStart=/usr/local/bin/mpanel-core
Restart=on-failure
RestartSec=3
LimitNOFILE=65535
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/opt/mpanel

[Install]
WantedBy=multi-user.target
```

### 4.4 `mpanel-agent.service`

```ini
[Unit]
Description=MPanel Agent
Documentation=https://github.com/sakana-1314/MPanel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=mpanel
Group=mpanel
EnvironmentFile=-/etc/mpanel/agent.env
ExecStart=/usr/local/bin/mpanel-agent
Restart=on-failure
RestartSec=3
LimitNOFILE=65535
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
# agent 需要写状态、站点/文件根、Caddy 配置与证书目录。
# 如果站点根在 /opt/mpanel 之外，把对应目录追加到这里。
ReadWritePaths=/opt/mpanel
# 管理 Docker 时按需加入（等价于给该用户宿主 root 能力）
# SupplementaryGroups=docker

[Install]
WantedBy=multi-user.target
```

安装并启动：

```bash
sudo install -d -m 0750 -o root -g mpanel /etc/mpanel
sudo chmod 0600 /etc/mpanel/core.env /etc/mpanel/agent.env
sudo cp deploy/systemd/mpanel-core.service /etc/systemd/system/
sudo cp deploy/systemd/mpanel-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mpanel-core mpanel-agent
```

> 上述单元是参考模板，未在本仓库 CI 中验证；首次上线前请在预发环境演练，并按实际站点根、Caddy 目录与 Docker 权限调整 `ReadWritePaths` 与 `SupplementaryGroups`。

## 5. 首次启动与 bootstrap token

core 首次启动时如果还没有管理员账号，会生成一次性 bootstrap token：

- 写入 `/opt/mpanel/conf/bootstrap-token`，权限 `0600`；
- 同时打印到启动日志（`journalctl -u mpanel-core` 可见）；
- token 只用于初始化，设置完用户名/密码后失效并删除文件。

初始化流程：

1. 读取 token：

   ```bash
   sudo cat /opt/mpanel/conf/bootstrap-token
   ```

2. 调用初始化端点设置管理员账号（`POST /api/v1/auth/setup`，字段以 `core/auth` 落地为准）：

   ```bash
   curl -sS -X POST http://127.0.0.1:10086/api/v1/auth/setup \
     -H 'content-type: application/json' \
     -d '{"token":"<bootstrap-token>","username":"admin","password":"<至少 10 位密码>"}'
   ```

3. 成功后删除 `conf/bootstrap-token`（若进程未自动删除），用新账号登录。

如果 token 泄漏或过期：在仍无管理员账号的前提下删除 `conf/bootstrap-token` 并重启 core，会重新生成。

agent 没有用户名密码，也没有匿名模式。它只接受静态 token：

- 配置项 `agent.token`，或环境变量 `MPANEL_AGENT_TOKEN`；
- 建议至少 32 字节随机值；
- curl 调用使用 `Authorization: Bearer <token>` 或 `X-MPanel-Token: <token>`；
- 直连模式的前端连接页填同一个 token。

生成随机 token：

```bash
openssl rand -base64 48
```

## 6. 验证与访问

```bash
# 进程存活（无认证，非信封）
curl -s http://127.0.0.1:10086/healthz
curl -s http://127.0.0.1:10087/healthz

# systemd 状态与日志
systemctl status mpanel-core mpanel-agent
journalctl -u mpanel-core -f
journalctl -u mpanel-agent -f
```

`/healthz` 只表示进程可响应，能力状态看 `GET /api/v1/system/info`。

访问方式：

- **core 模式**：浏览器打开 `http://<服务器IP>:10086`。core 托管 `web/panel` 静态文件（规划中）；若未托管，用 Caddy/nginx 把面板静态目录与 `/api/v1`、`/ws` 反代到 core。
- **agent 直连模式**：浏览器打开面板静态站点，在「新增连接」中选择 agent（直连 token），地址填 `http://<IP>:10087`，token 填 `MPANEL_AGENT_TOKEN`。单机模式没有 `/machines*` 与 `/system/overview`，这是预期行为。
- 生产环境务必改为 HTTPS 域名访问，见[生产部署](/guide/deploy)。

## 7. 升级与卸载

升级只替换二进制，不移动 `/opt/mpanel`：

```bash
sudo systemctl stop mpanel-agent mpanel-core
sudo install -m 0755 mpanel-core mpanel-agent mpanelctl /usr/local/bin/
sudo systemctl daemon-reload
sudo systemctl start mpanel-core
sudo systemctl start mpanel-agent
```

升级前先备份 `/opt/mpanel`（至少 `conf/`、`data/`、`db/`、`backup/`），因为配置里包含会话密钥、机器凭据与数据库密码密文。详见[生产部署](/guide/deploy#备份与恢复)。

卸载：

```bash
sudo systemctl disable --now mpanel-agent mpanel-core
sudo rm -f /etc/systemd/system/mpanel-core.service /etc/systemd/system/mpanel-agent.service
sudo systemctl daemon-reload
sudo rm -f /usr/local/bin/mpanel-core /usr/local/bin/mpanel-agent /usr/local/bin/mpanelctl /usr/bin/mpanel
# /opt/mpanel 含配置与数据，确认不再需要后再删除
```
