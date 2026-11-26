# 生产部署

本页面向把 MPanel 长期运行在生产环境的部署者：systemd 托管、反向代理、升级、备份，以及 SELinux 与权限注意事项。安装步骤见[从源码安装](/guide/install)，字段含义见[配置文件与环境变量](/guide/config)。

::: warning 验证状态
本文的 systemd 单元、Caddyfile 与 nginx 配置是参考模板，未在本仓库 CI 或本机验证。首次上线前请在预发环境完整演练启动、反代、WebSocket、升级与回滚。
:::

## 1. 拓扑与暴露面

推荐拓扑：

```text
浏览器 ──HTTPS──> Caddy / nginx ──> 127.0.0.1:10086 (core)
                                        ├─ http ────────> agent A:10087（仅内网）
                                        ├─ reverse-ws <── agent B（NAT 后主动拨号）
                                        └─ stdio ───────> agent C 子进程（同机，需显式开启）
```

| 端口 | 建议 |
|---|---|
| core `10086` | 只监听 `127.0.0.1`，由反向代理对外提供 443 |
| agent `10087` | 仅内网或 core 可达；直连模式才由反代暴露，且必须 TLS |
| Caddy admin `2019` | 仅 loopback；不要暴露公网 |
| Docker socket | 不要通过网络暴露；挂载 socket 等价于宿主 root 能力 |

core 是单进程、单写者：会话、票据、机器健康与作业队列都在本地状态里，不要部署多个副本共享同一份 `/opt/mpanel`。

## 2. 运行用户、目录与权限

```bash
sudo useradd --system --home /opt/mpanel --shell /usr/sbin/nologin mpanel
sudo install -d -o mpanel -g mpanel -m 0700 /opt/mpanel
sudo install -d -o mpanel -g mpanel -m 0700 \
  /opt/mpanel/conf /opt/mpanel/data /opt/mpanel/log \
  /opt/mpanel/db /opt/mpanel/backup /opt/mpanel/tmp
sudo chown -R mpanel:mpanel /opt/mpanel
sudo chmod 0600 /opt/mpanel/conf/*.yaml
```

要点：

- `/opt/mpanel/conf` 含会话密钥、机器凭据与数据库密码密文，目录 `0700`、文件 `0600`。
- Caddy 若以独立用户运行，需要对 `caddy_config` 目录可读、对 `caddy_data` 目录可写（证书）。可以让 Caddy 与 agent 同组，或把 Caddy 的 `ExecStart` 指向 agent 的 Caddyfile 并由同一用户运行。
- agent 需要写站点根、文件根、Caddy 配置目录与备份目录；这些目录不在 `/opt/mpanel` 时，必须加进 systemd 的 `ReadWritePaths=`。
- 管理 Docker 时把运行用户加入 `docker` 组（`SupplementaryGroups=docker`），但这等价于给该用户宿主 root 能力；更稳妥的是 rootless Docker。
- 容器配置页要写 `docker_config`（默认 `/etc/docker/daemon.json`）。`ProtectSystem=strict` 下需要 drop-in 放行目录，并给 agent 用户最小 ACL：

  ```ini
  # /etc/systemd/system/mpanel-agent.service.d/docker-config.conf
  [Service]
  ReadWritePaths=/etc/docker
  ```

  ```bash
  sudo setfacl -m u:mpanel:rwx /etc/docker
  sudo setfacl -m u:mpanel:rw /etc/docker/daemon.json
  sudo systemctl daemon-reload && sudo systemctl restart mpanel-agent
  ```

  写入采用同目录 tmp + rename，目录必须可写。保存后需重启 Docker 才会生效；面板不会自动重启守护进程。

## 3. systemd 部署

完整的 `mpanel-core.service` 与 `mpanel-agent.service` 模板见[从源码安装](/guide/install#_4-systemd-单元)。生产环境注意：

1. 环境文件放 `/etc/mpanel/core.env`、`/etc/mpanel/agent.env`，权限 `0600`、属主 `root:mpanel`，用 `EnvironmentFile=` 加载。
2. `ProtectSystem=strict`、`ProtectHome=true`、`NoNewPrivileges=true` 会限制可写路径；所有需要写的目录都必须列入 `ReadWritePaths=`。
3. 如果站点根或文件根在 `/home` 下，`ProtectHome=true` 会让它们不可见；改为 `ProtectHome=read-only` 或去掉该选项。
4. 重启顺序：先 core 后 agent；停止时先 agent 后 core，减少 core 记录离线噪声。
5. 查看日志：

   ```bash
   sudo journalctl -u mpanel-core -f
   sudo journalctl -u mpanel-agent -f --since "30 min ago"
   ```

## 4. 反向代理

### 4.1 必须满足的条件

- 透传 WebSocket：`Upgrade` 与 `Connection` 头。
- 必须代理的路径：`/`（面板静态）、`/api/v1/*`、`/ws/worker`（reverse-ws 注册）、`/api/v1/machines/<id>/proxy/ws/*`（代理 WS）。
- 超时：普通 API 120 秒；镜像拉取、上传/下载、备份下载约 620 秒。反向代理读超时至少 620 秒。
- 请求体：文件上传默认上限 100 MiB，反代建议 `client_max_body_size` ≥ 128 MiB。
- 真实 IP：core 需要开启信任代理开关（`MPANEL_TRUST_PROXY`，随 core 的认证/限流模块落地），否则登录限流会把所有客户端看成反代地址。
- HTTPS：生产只用 HTTPS；Cookie 的 `Secure`/`SameSite` 由 core 的公开 URL 与 Cookie 配置决定。
- 安全头：CSP、`X-Content-Type-Options`、`Referrer-Policy` 由面板静态托管层负责；反向代理不要再叠加更严格的 CSP，多个 CSP 取交集可能把 dbx iframe 拦掉。

### 4.2 Caddy 示例

由 core 托管面板静态文件时，整站反代即可（Caddy 的 `reverse_proxy` 默认支持 WebSocket）：

```caddyfile
panel.example.com {
	encode zstd gzip

	reverse_proxy 127.0.0.1:10086 {
		transport http {
			read_timeout 620s
			write_timeout 620s
		}
	}
}
```

如果面板静态文件由 Caddy 直接托管、只把 API/WS 转给 core：

```caddyfile
panel.example.com {
	encode zstd gzip

	@backend path /api/* /ws/*
	reverse_proxy @backend 127.0.0.1:10086 {
		transport http {
			read_timeout 620s
			write_timeout 620s
		}
	}

	root * /opt/mpanel/web/panel
	try_files {path} /index.html
	file_server
}
```

文档站是纯静态产物（`web/docs/.vitepress/dist`），如果与面板同域发布，可放到 `/docs/` 子路径并让静态服务器直接托管，不需要经过 core。

### 4.3 nginx 示例

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

upstream mpanel_core {
    server 127.0.0.1:10086;
    keepalive 32;
}

server {
    listen 443 ssl;
    http2 on;
    server_name panel.example.com;

    ssl_certificate     /etc/letsencrypt/live/panel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/panel.example.com/privkey.pem;

    client_max_body_size 128m;

    location / {
        proxy_pass http://mpanel_core;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;

        proxy_read_timeout 620s;
        proxy_send_timeout 620s;
        proxy_buffering off;
    }
}
```

如果面板静态文件由 nginx 托管，把 `location /` 换成 `root` + `try_files $uri $uri/ /index.html;`，并为 `/api/`、`/ws/` 单独配置同样的 `proxy_pass` 与 Upgrade 头。`/ws/worker` 必须能到达 core，reverse-ws agent 才能注册。

### 4.4 无 80/443 时用高位端口转发

部分云厂商只放行高位端口。此时不必把 core 改成监听 `0.0.0.0`，可以用 `systemd-socket-proxyd` 在高位端口转发，core 继续只监听 loopback：

```ini
# /etc/systemd/system/mpanel-web.socket
[Unit]
Description=MPanel 面板公网端口

[Socket]
ListenStream=0.0.0.0:24579
Accept=no
Backlog=512

[Install]
WantedBy=sockets.target
```

```ini
# /etc/systemd/system/mpanel-web.service
[Unit]
Description=MPanel 面板端口转发到 core
After=mpanel-core.service
Requires=mpanel-core.service

[Service]
ExecStart=/lib/systemd/systemd-socket-proxyd 127.0.0.1:10086
PrivateTmp=yes
TimeoutStopSec=5s

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now mpanel-web.socket mpanel-web.service
curl -fsS http://127.0.0.1:24579/healthz
```

- 这个转发同时承载静态面板、`/api/v1` 与 `/ws`，浏览器直接访问 `http://<服务器>:24579` 即可，无需额外反代。
- 公网 http 会明文传输凭据；能配置 TLS 时仍应优先用 4.2/4.3 的方案。
- 云安全组需要放行对应高位端口；core 的 `10086` 与 agent 的 `10087` 仍保持 loopback/内网。

## 5. 升级

### 5.1 升级前

1. 阅读目标版本说明；协议只做加法时 core 可先升级，破坏性变更按说明先停 agent。
2. 完整备份 `/opt/mpanel`（见下一节），尤其是 `conf/`、`data/`、`db/`、`backup/`。
3. 在预发环境演练启动、登录、机器连接、站点 apply、WebSocket 终端与文件上传。

### 5.2 升级顺序

```text
1. core：停 core → 替换二进制 → 起 core → 检查 /healthz、登录、机器列表
2. agent 逐台：停一台 → 替换 → 起 → 等 core 标记 online → 下一台
3. 静态前端：替换 web/panel 产物即可，无需重启 core
4. 观察 15 分钟：机器健康、任务、站点 apply、审计
```

命令示例：

```bash
sudo systemctl stop mpanel-core
sudo install -m 0755 mpanel-core /usr/local/bin/mpanel-core
sudo systemctl start mpanel-core

# 每台 agent
sudo systemctl stop mpanel-agent
sudo install -m 0755 mpanel-agent /usr/local/bin/mpanel-agent
sudo systemctl start mpanel-agent
```

保留旧二进制便于回滚：

```bash
STAMP=$(date +%F-%H%M)
sudo mkdir -p /opt/mpanel/backup/bin-${STAMP}
sudo cp /usr/local/bin/mpanel-core /usr/local/bin/mpanel-agent /usr/local/bin/mpanelctl \
  /opt/mpanel/backup/bin-${STAMP}/
```

### 5.3 回滚

应用层不保证自动降级。回滚需要同时恢复旧二进制与升级前的状态目录；JSON 存储可能已按 `schemaVersion` 迁移，旧版本未必能读取新文件，所以升级前的整目录备份是唯一可靠回滚点。

```bash
sudo systemctl stop mpanel-agent mpanel-core
sudo cp /opt/mpanel/backup/bin-YYYY-MM-DD-HHMM/* /usr/local/bin/
# 恢复备份的状态目录（见下一节）
sudo systemctl start mpanel-core mpanel-agent
```

## 6. 备份与恢复

### 6.1 备份对象

| 对象 | 是否必须 | 说明 |
|---|---|---|
| `/opt/mpanel/conf/` | 必须 | `app.yaml`、`agent.yaml`、bootstrap token（若仍存在）；含密钥与密码密文 |
| `/opt/mpanel/data/` | 必须 | 站点草稿、数据库档案、任务、Caddy 配置与证书、文件/站点根 |
| `/opt/mpanel/db/` | 必须 | 控制面状态文档；丢失后机器列表、用户、会话等无法恢复 |
| `/opt/mpanel/backup/` | 建议 | Caddy apply 回滚副本、数据库备份 |
| `/opt/mpanel/log/` | 按需 | 合规或排障时需要 |

`/opt/mpanel/tmp` 不需要备份。二进制与前端产物可由版本重新构建。

### 6.2 一致性备份

多份 JSON 文件之间不是事务关系，最稳妥的做法是停服务或做文件系统快照后再打包：

```bash
sudo systemctl stop mpanel-agent mpanel-core

STAMP=$(date +%F-%H%M)
sudo tar --numeric-owner -czf "/var/backups/mpanel-${STAMP}.tgz" \
  --exclude='mpanel/tmp' --exclude='mpanel/log' \
  -C /opt mpanel

sudo systemctl start mpanel-core mpanel-agent
```

如果 Caddy 配置或证书在 `/opt/mpanel` 之外，单独打包对应目录。

### 6.3 恢复

```bash
sudo systemctl stop mpanel-agent mpanel-core
sudo tar --numeric-owner -xzf /var/backups/mpanel-YYYY-MM-DD-HHMM.tgz -C /opt
sudo chown -R mpanel:mpanel /opt/mpanel
sudo chmod 0600 /opt/mpanel/conf/*.yaml
sudo systemctl start mpanel-core mpanel-agent
```

恢复后检查：

- `GET /healthz` 正常；
- 能登录，机器列表与健康状态符合预期；
- 站点 apply 状态、数据库档案 `hasPassword`、任务历史存在；
- 若 `secret`/密钥文件恢复不全，机器凭据与数据库密码将无法解密，需要重新录入。

## 7. SELinux 与防火墙

### 7.1 SELinux

先确认状态：

```bash
getenforce
sudo ausearch -m avc -ts recent
```

常见处理：

- 给 `/opt/mpanel` 打上服务可写的标签，再递归恢复上下文：

  ```bash
  sudo semanage fcontext -a -t var_lib_t '/opt/mpanel(/.*)?'
  sudo restorecon -Rv /opt/mpanel
  ```

  标签类型要按实际策略选择；如果目录由 nginx/httpd 读取，应使用对应的 `httpd_sys_content_t`/`httpd_sys_rw_content_t`，不要机械照搬。

- nginx 反向代理到 `127.0.0.1:10086` 被拒绝时：

  ```bash
  sudo setsebool -P httpd_can_network_connect 1
  ```

- Caddy 单独运行时，确认其 systemd 单元对 `caddy_config`/`caddy_data` 有写权限；SELinux 拒绝会出现在 `ausearch` 中，可用 `audit2allow` 生成最小策略并人工复核，不要直接 `setenforce 0` 长期关闭。

### 7.2 防火墙

只对外开放反向代理的 443/80。core 与 agent 端口应绑定 loopback 或内网地址：

```bash
# 示例：只允许内网访问 agent 端口
sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="10.0.0.0/8" port port="10087" protocol="tcp" accept'
sudo firewall-cmd --reload
```

reverse-ws 与边缘节点只需要出站网络，不需要开放入站端口；但反向代理必须放行 `Upgrade`/`Connection` 并保留 `/ws/worker` 路径。

## 8. 日志与排障入口

| 日志 | 位置 |
|---|---|
| core | stderr → `journalctl -u mpanel-core` |
| agent | stderr → `journalctl -u mpanel-agent`；`log_path` 下的运行日志 |
| 计划任务输出 | agent 的 `data/agent/tasks/<taskId>/<runId>.log` |
| Caddy | Caddy 自己的日志；面板只记录 validate/reload 输出摘要 |
| 审计 | core 的 `db/`（审计 JSONL，随 core 落地） |

排障时优先看：

- 响应头 `x-mpanel-request-id`，core 生成后经代理传给 agent；
- 机器 `lastError` 与 `GET /api/v1/machines/:id/health`；
- `GET /api/v1/system/info` 的能力快照；
- `journalctl` 中的配置错误与 Caddy `caddyOutput`。

常见症状与处理见[故障排查](/ops/troubleshooting)。
