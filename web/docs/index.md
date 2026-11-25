---
layout: home

hero:
  name: MPanel
  text: 服务器管理面板文档
  tagline: web/panel、core、agent 三端分离；沿用 1Panel 的 /opt/mpanel 与 systemd 约定；站点管理用 Caddy。
  actions:
    - theme: brand
      text: 从源码安装
      link: /guide/install
    - theme: alt
      text: 与 1Panel 的差异
      link: /guide/faq

features:
  - title: 三端分离
    details: web/panel 只负责界面；core 负责登录、机器注册、隧道与代理；agent 在目标主机执行站点、数据库、容器、文件、终端与计划任务。
  - title: 1Panel 风格部署
    details: 安装根 /opt/mpanel，配置 conf/app.yaml 与 conf/agent.yaml，二进制放在 /usr/local/bin，服务用 mpanel-core.service / mpanel-agent.service。
  - title: Caddy 管理站点
    details: 每站点生成 sites.d/*.caddy 片段，apply 走 validate → 备份 → 原子替换 → reload → 回滚，天然支持自动 HTTPS。
  - title: 能力缺失可降级
    details: 没有 Caddy、Docker、PostgreSQL、Redis 或 PTY 时进程照常启动；列表返回 available=false，写操作返回 UNAVAILABLE 与可执行提示。
---

## 一句话定位

MPanel 是一个三端分离的服务器管理面板：`web/panel` 是 React 单页前端，`core` 是控制面（登录、机器注册、健康检查、隧道与 REST/WS 代理），`agent` 是功能面（在每台被管主机上执行站点、证书、数据库、容器、文件、终端与计划任务）；前端既可以直连单台 agent，也可以经 core 管理多台机器。

## 与 1Panel 的取舍

### 沿用 1Panel 的部署约定

MPanel 刻意保持 1Panel 用户熟悉的路径与进程模型：

| 项目 | 1Panel | MPanel |
|---|---|---|
| 安装根 | `/opt/1panel` | `/opt/mpanel` |
| 配置 | `conf/app.yaml` | `conf/app.yaml`（core）、`conf/agent.yaml`（agent） |
| 数据 / 日志 / 数据库 / 备份 | `data/`、`log/`、`db/`、`backup/` | `data/`、`log/`、`db/`、`backup/`，另有 `tmp/` |
| 二进制 | `/usr/local/bin/1panel-core`、`1panel-agent` | `/usr/local/bin/mpanel-core`、`mpanel-agent`、`mpanelctl` |
| systemd 服务 | `1panel-core.service`、`1panel-agent.service` | `mpanel-core.service`、`mpanel-agent.service` |
| 控制命令 | `1pctl` | `mpanelctl`（`/usr/bin/mpanel` 软链） |

这意味着备份、迁移、权限与 SELinux 的处理方式基本可以照搬 1Panel 的经验，运维不需要学习一套新目录。

### 网站管理改用 Caddy

1Panel 用 nginx 管理网站；MPanel 用 Caddy，原因不是偏好，而是站点模型更简单可靠：

1. **Caddyfile 片段化**：每个站点生成一个 `sites.d/<siteId>.caddy` 片段，主 `Caddyfile` 只有 `import sites.d/*.caddy`。增删站点是增删文件，不需要在一个大配置里做文本手术。
2. **自动 HTTPS**：域名只要解析到本机，Caddy 默认自动申请和续期证书；`tls internal`、`tls off` 只是配置项，不需要额外维护 certbot 与续期定时任务。
3. **validate / reload / 回滚是内建流程**：apply 前先 `caddy validate`，通过后备份现有目录、原子替换、`caddy reload`；reload 失败自动恢复备份并再次 reload。整个过程可以给出明确的 `stage` 与 `caddyOutput`。
4. **结构化配置边界更清晰**：MPanel 只接受结构化站点配置，不支持粘贴原始 Caddyfile 片段；所有进入 Caddyfile 的字符串都经过校验与转义，避免 nginx 时代常见的配置注入与手写错误。

## 实现状态

Go 重写仍在进行中。本站严格区分「已实现」与「规划中」，不把设计当成已交付功能：

| 能力 | 状态 | 说明 |
|---|---|---|
| REST API v1 与隧道协议 v1 契约 | 已冻结 | 见 [REST API 契约](/api/contract) 与 [隧道协议](/api/protocol) |
| 配置模型（`app.yaml` / `agent.yaml`、`MPANEL_*` 覆盖、目录创建、原子写） | 已实现 | `internal/config` |
| 信封、错误码、分页、隧道帧模型 | 已实现 | `internal/protocol` |
| 原子 JSON 存储 | 已实现 | `internal/store` |
| `mpanel-core` / `mpanel-agent` / `mpanelctl` 入口 | 规划中 | `cmd/` 尚在移植 |
| 认证、隧道、机器代理、站点/数据库/容器/文件/终端/任务模块 | 规划中 | 按契约逐端点移植 |
| web/panel 前端 | 已有源码 | 现有 React 应用，按冻结契约对接 Go 后端 |

安装步骤按目标形态书写；涉及尚未落地的二进制时，页面会明确标注，不要据此认为该步骤已经可执行。

## 文档地图

- [从源码安装](/guide/install)：构建、放置二进制、systemd 单元、首次启动 bootstrap token。
- [配置文件与环境变量](/guide/config)：`/opt/mpanel` 目录树、`app.yaml` 与 `agent.yaml` 全部字段、`MPANEL_*` 覆盖规则。
- [生产部署](/guide/deploy)：反向代理（Caddy / nginx）、升级、备份、SELinux 与权限。
- [站点与 Caddy](/guide/sites)：站点模型、apply 流程、证书扫描。
- [数据库与 dbx](/guide/databases)：PostgreSQL / Redis 档案、备份恢复、dbx iframe 与 handoff。
- [边缘节点](/guide/edge)：入网密钥、快照、离线作业。
- [REST API 契约](/api/contract)：所有端点、请求/响应形状与错误码。
- [隧道协议](/api/protocol)：stdio / reverse-ws 的帧格式、分块与多路复用。
- [故障排查](/ops/troubleshooting)：机器离线、Caddy apply 失败、PTY、dbx、入网 403。
