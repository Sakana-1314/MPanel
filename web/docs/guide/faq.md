# 常见问题

## 和 1Panel 是什么关系？

目录、配置与 systemd 约定参考 1Panel：安装根 `/opt/mpanel`、`conf/app.yaml`、`data/`、`log/`、
`db/`、`backup/`、`mpanel-core.service` / `mpanel-agent.service`、`mpanelctl` 控制脚本。
但网站管理用 **Caddy** 而不是 nginx。

## 为什么用 Caddy 而不是 nginx？

1Panel 用 nginx + 站点配置模板；MPanel 用 Caddy 的 `import sites.d/*.caddy`。好处是自动 HTTPS、
配置可校验（`caddy validate`）、reload 原子且失败可回滚，站点模型可以完全结构化生成，
不需要维护 nginx 的 location 片段。代价是宿主上需要安装 Caddy。

## 三端一定要一起部署吗？

不必。

- 只跑 `mpanel-agent` + 任意静态服务器托管 `web/panel`：单机面板。
- `mpanel-core` + 多个 agent：多机面板（http / stdio / reverse-ws）。
- 内网机器只允许出站：用 `reverse-ws` 或边缘入网密钥。

## core 会执行命令吗？

不会。core 只做认证、机器注册、代理与聚合；所有功能在 agent 上执行。唯一的例外是
`MPANEL_ALLOW_STDIO=1` 时 core 会 spawn agent 子进程——这等价于在 core 主机执行命令，默认关闭。

## 数据库为什么只支持 PostgreSQL 与 Redis？

一期只适配这两种，查询界面通过 iframe 嵌入外部 dbx；agent 负责连接档案、统计、备份恢复与
一次性 handoff 票据。MySQL 等不在当前范围。

## 前端能连多个后端吗？

能。连接管理中可保存多个 core / agent，切换时按连接隔离查询缓存；也支持构建期
`VITE_DEFAULT_BACKEND(S)` 与运行时 `config.json` 预置。

## 数据存在哪里？怎么备份？

core：`/opt/mpanel/db/*.json` 与 `conf/`；agent：`/opt/mpanel/data/agent/`（站点、任务、备份、回收站）
与 `conf/agent.yaml`。整体备份 `/opt/mpanel` 即可；密钥文件（`conf/app.yaml` 的 `secret`、
`data/agent/secrets.key`）必须一起备份，否则已加密的 token/密码无法解密。

## 面板端口是多少？

默认 core `10086`、agent `10087`。1Panel 安装时随机端口；MPanel 也可以改
`conf/app.yaml` 的 `system.port` 或设置 `MPANEL_PORT`。

## 用 gh-pages 上的面板连接自建 core 时登录不了？

浏览器把 `sakana-1314.github.io` 与你自己的域名视为**跨站**，会话 Cookie 是 `SameSite=Lax`，
跨站请求不会携带它，所以「登录成功但一刷新就掉线」是预期行为。两种做法：

1. **用 API Token（推荐）**：在面板「设置」里创建一个 write 权限 token，在连接配置里填入；
   前端会用 `Authorization: Bearer` 而不是 Cookie。core 侧需要把该 origin 加进
   `MPANEL_CORS_ORIGINS`（例如 `https://sakana-1314.github.io`）。
2. **同域部署**：把 `web/panel/dist` 放到 core 的 `MPANEL_WEB_DIR`（默认 `/opt/mpanel/web`），
   由 core 直接托管，登录 Cookie 同站可用。

自托管面板连自建 core 不受此限制。
