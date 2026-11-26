# 故障排查

## 机器离线

1. `mpctl status core` / `mpctl status agent` 确认服务在跑。
2. http 传输：core 访问 `http://<agent>:<port>/healthz`；确认 `MPANEL_AGENT_TOKEN` 与面板里填的一致。
3. reverse-ws：agent 日志里应有「已连接 core」；反向代理必须透传 `Upgrade`/`Connection` 头。
4. stdio：核心需显式设置 `MPANEL_ALLOW_STDIO=1`，且 `mpanel-agent` 在 PATH 或 `MPANEL_AGENT_ENTRY` 指向它。

## 站点 apply 失败

- 站点页会给出容器内 `caddy validate` 的输出尾部。常见原因：域名重复、上游不可达、root 不在
  `MPANEL_SITES_ROOTS` 白名单、基础认证缺少 bcrypt 工具。
- apply 失败会回滚到上一份 `Caddyfile`；`$MPANEL_AGENT_DATA_DIR/caddy/sites.d/<id>.caddy` 可手工检查。
- Caddy 容器未部署时，站点全功能不可用，只能一键安装；安装后 `capabilities.caddy` 才会变为可用。
- 容器启动失败时到「编排」页查看 `mpanel-caddy` 日志，常见原因是 80/443 被占用或挂载路径无权访问。

## 一键初始化失败

- 商店模板来自 GitHub：默认先试 raw，再回退 jsDelivr 与同源 `/store`，每个地址最多 10 秒。
  全部不可达时在面板 `config.json` 设置 `storeUrl` 指向可达镜像。
- 安装需要 Docker Engine 与 Compose v2；错误输出会显示 `docker compose` 的原始信息。
- 数据库端口默认只绑定 `127.0.0.1`，端口冲突时修改安装向导中的宿主端口。

## 证书看不到

证书来自 Caddy 数据目录（`$MPANEL_AGENT_DATA_DIR/caddy/data` 或 `MPANEL_CADDY_DATA_DIR`）。
若 Caddy 尚未首次签发，列表为空属正常；签发后刷新页面即可。

## PTY 不可用

Windows 上 `creack/pty` 不可用，终端降级为管道模式（`pty=false`），交互式程序（vim/top）不可用。
Linux 上检查 agent 是否以能创建 `/dev/ptmx` 的用户运行。

## dbx 打不开

在面板部署目录的 `config.json` 设置 `dbxUrl`，或构建时设置 `VITE_DBX_URL`。
未配置时数据库页仍可用，只是不显示 iframe，可复制连接信息手工连接。

## 边缘入网 403

密钥可能已吊销、过期或用尽（`maxUses`）。确认 `MPANEL_CORE_URL` 是 **HTTP(S) 基地址**，
不是 `ws://…/ws/worker`。审计日志中有 `edge.enroll` / `edge.job.*` 记录。

## 端口/配置在哪

`/opt/mpanel/conf/app.yaml`（core）与 `/opt/mpanel/conf/agent.yaml`（agent）。
所有字段可用 `MPANEL_*` 环境变量覆盖，优先级：环境变量 > 配置文件 > 默认值。
