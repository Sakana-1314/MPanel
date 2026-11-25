<div align="center">

# MPanel

轻量、三端分离的服务器管理面板

[![version](https://img.shields.io/badge/version-0.3.0-blue.svg)](#)
[![go](https://img.shields.io/badge/go-%E2%89%A51.27-00ADD8.svg)](#)
[![node](https://img.shields.io/badge/node-%E2%89%A522-339933.svg)](#)
[![license](https://img.shields.io/badge/license-%E7%A7%81%E6%9C%89-red.svg)](LICENSE)

网站 · 证书 · 数据库 · 容器 · 文件 · 终端 · 计划任务 · 边缘节点

</div>

---

MPanel 把「一台机器」和「一片机器」拆成三个独立的部分：

- **`web/panel`**：Vue 3 + Vite + Vue Router + Naive UI 静态 SPA；**只连接 core**，不直连 agent，多机页面以标签页混合打开；
- **`core`**：Go 控制面，只做登录认证、机器注册、REST/WS 代理与聚合，不碰 Caddy、Docker 和宿主文件；
- **`agent`**：Go 功能端，网站、证书、数据库、容器、文件、终端、计划任务都在这里实现，通过 stdio、http 或 reverse-ws 接入 core。

一套 `/api/v1` 契约、core 多机拓扑、三种传输（stdio / http / reverse-ws）。面板始终经 core 代理访问机器；`/api/v1` 的 agent 直连能力保留给脚本与第三方客户端。功能缺失不会让进程崩溃：能力探测失败时列表返回 `available:false`，写操作返回 `UNAVAILABLE` 并给出可执行的 `hint`。

## 与 1Panel 的取舍

MPanel 沿用 1Panel 的部署直觉，但不复制它的全部体积：

| 项 | 1Panel | MPanel |
|---|---|---|
| 安装根 | `/opt/1panel` | `/opt/mpanel` |
| 配置 | `conf/app.yaml` | `conf/app.yaml`（core）、`conf/agent.yaml`（agent） |
| 服务 | `1panel-core.service`、`1panel-agent.service` | `mpanel-core.service`、`mpanel-agent.service` |
| 控制脚本 | `1pctl` | `mpanelctl` |
| 网站引擎 | OpenResty / nginx | **Caddy**（结构化配置、`validate` 后原子 reload） |
| 应用商店 | 有 | 无；只保留少量可靠模块 |
| 数据库 | 多种数据库与应用 | 仅 PostgreSQL / Redis 的连接档案、测试、统计与备份 |
| 前端 | 随面板内置 | 独立静态 SPA，可单独构建与托管 |

相同的是目录、配置、systemd 与「面板只管配置，不守护 Caddy」的边界；不同的是网站配置只接受结构化模型，不导入任意 Caddyfile 原文。

## 功能

| 模块 | 能力 |
|---|---|
| **网站与证书** | 反向代理 / 静态文件 / 重定向；多域名、TLS 模式、响应头、编码、访问日志；Caddyfile 预览、`caddy validate`、原子替换与失败回滚；证书扫描（只读 X.509，按到期时间筛选） |
| **数据库** | PostgreSQL / Redis 连接档案（密码只写不读）、连通性测试、版本与运行统计、备份 / 恢复；查询界面通过一次性 handoff 票据交给外部 **dbx** |
| **容器** | Docker CLI 适配：容器列表 / 启停 / 重启 / 删除 / exec、日志 WS 流、stats；镜像列表、拉取与清理；Compose 栈识别、up / down / restart |
| **文件** | 多根沙箱（realpath 前缀校验、拒绝符号链接逃逸）、列表 / 读写 / 重命名 / 复制 / chmod、回收站、上传下载、归档与解压、名称与内容搜索 |
| **终端** | PTY 多会话（Unix）；无 PTY 时降级为管道会话（Windows），WebSocket 使用一次性 ticket，尺寸同步 |
| **任务** | cron 表达式校验与未来运行预览、立即执行、启停、超时与并发策略、运行历史（退出码 + 输出尾部） |
| **边缘节点** | 入网密钥（有效期 / 次数 / 分组）、自助注册、上线即取快照并每 5 分钟刷新、离线作业在重连后串行补跑 |
| **多机** | stdio / http / reverse-ws 三种传输、机器健康与能力聚合、REST 与 WS 代理、会话登录与 API Token、审计 |

## 目录约定（1Panel 风格）

生产环境默认安装到 `/opt/mpanel`：

```text
/opt/mpanel/
├─ conf/
│  ├─ app.yaml          # core 配置
│  └─ agent.yaml        # agent 配置
├─ data/                # 站点、文件根、栈等运行数据
├─ log/                 # 日志
├─ db/core.db           # core 状态（JSON 文档，沿用 1Panel 的 db 路径）
├─ backup/              # 站点与数据库备份
└─ tmp/                 # 临时文件
```

- 二进制：`/usr/local/bin/mpanel-core`、`mpanel-agent`、`mpanelctl`；
- systemd：`mpanel-core.service`、`mpanel-agent.service`；
- 配置与密钥文件权限 `0600`，目录 `0700`；
- 非 Linux 开发机默认落到 `~/.mpanel`，可用 `MPANEL_BASE_DIR`（core）或 `MPANEL_AGENT_BASE_DIR`（agent）覆盖。

## 5 分钟从源码构建与运行

依赖：Go 1.27+、Node 22+（CI 使用 24）、pnpm 12.10.1。Caddy、Docker、PostgreSQL、Redis 都是可选的，缺失只会让对应能力不可用。

```bash
git clone https://github.com/Sakana-1314/MPanel.git
cd MPanel

# 1. 构建面板（类型检查 + Vite 生产构建）
cd web/panel
pnpm install
pnpm build
cd ../..

# 2. 构建 Go 二进制
go build -o mpanel-core ./cmd/mpanel-core
go build -o mpanel-agent ./cmd/mpanel-agent
go build -o mpanelctl ./cmd/mpanelctl

# 3. 启动 core。本地开发用仓库内状态目录，避免写入 /opt，
#    并把前端产物指给 core 托管（生产默认 /opt/mpanel/web）
export MPANEL_BASE_DIR="$PWD/mpanel-data"
export MPANEL_WEB_DIR="$PWD/web/panel/dist"
./mpanel-core
```

core 默认监听 `0.0.0.0:10086`，并静态托管 `web/panel/dist`。打开 `http://127.0.0.1:10086`：

1. 首次启动时 core 会生成一次性 bootstrap token（写入 `conf/bootstrap-token` 并打印到日志）；
2. 用它完成管理员初始化（`POST /api/v1/auth/setup`，面板会在首次进入时引导）；
3. 登录后即可在「机器」页添加 agent。

需要在同一台机器上再跑一个 agent 时：

```bash
export MPANEL_AGENT_BASE_DIR="$PWD/mpanel-data/agent"
export MPANEL_AGENT_TOKEN="$(openssl rand -base64 32)"
./mpanel-agent
# 默认监听 127.0.0.1:10087，等待 core 以 http 传输接入
```

开发前端时另开终端运行 Vite，改完即时热更新：

```bash
pnpm --dir web/panel dev     # http://localhost:5173
```

### mpanelctl

`mpanelctl` 是对 systemd 的薄封装，与两个服务二进制一起安装到 `/usr/local/bin`，用于查看状态、启停服务和读取日志：

```bash
mpanelctl status             # 查看 core / agent 服务状态
mpanelctl restart core       # 重启 core（或 agent）
mpanelctl --help             # 以实际安装版本的子命令为准
```

### 边缘节点接入

NAT 或防火墙后的机器只需要出站网络。在 core 创建入网密钥后，一行启动 agent：

```bash
MPANEL_AGENT_TRANSPORT=reverse-ws MPANEL_CORE_URL=https://panel.example.com MPANEL_EDGE_KEY=mpedge_xxx ./mpanel-agent
```

agent 会先 `POST /api/v1/edge/enroll` 换取一次性机器身份，写入本地 `edge.json`（`0600`），随后主动拨号 core 的 `/ws/worker`。节点上线后自动出现，之后与普通 reverse-ws 机器完全同构。

## 文档站

- 在线文档：<https://sakana-1314.github.io/MPanel/docs/>
- 文档源码：`web/docs`（VitePress，中文），由「发布站点」工作流随面板一起发布到 `gh-pages`。

## 目录结构

```text
MPanel/
├─ cmd/                  # mpanel-core / mpanel-agent / mpanelctl 入口
├─ core/                 # 控制面 + 共享包（protocol/config/store/auth/httpapi/tunnel）
├─ agent/                # 功能端：模块注册、能力探测、命令执行、systemd/终端支持
├─ web/
│  ├─ panel/             # Vue 3 + Vite + Naive UI 面板（独立 pnpm 包；只连 core）
│  └─ docs/              # VitePress 文档（独立 pnpm 包）
├─ .github/workflows/    # 校验、发布站点
├─ go.mod / go.sum
└─ README.md / LICENSE / AGENTS.md / CLAUDE.md / .gitignore
```

根目录只保留上述目录与文件；本地资料放在 `notes/`，已在 `.gitignore` 中忽略。

## 开发与门禁

```bash
# Go
go build ./...
go vet ./...
go test ./...

# 面板
cd web/panel && pnpm install --frozen-lockfile && pnpm build

# 文档
cd web/docs && pnpm install --frozen-lockfile && pnpm build
```

GitHub Actions：

- **校验**：PR 与 `main` 推送时运行 Go 构建 / `go vet` / `go test`，以及面板与文档的生产构建；
- **发布站点**：`main` 更新或手动触发时构建 panel 与 docs，发布到 `gh-pages`（面板在根，文档在 `/docs/`，`404.html` 作为 SPA 深链兜底）。

## 安全说明

- core 首次启动使用一次性 bootstrap token 完成初始化；密码以 scrypt 哈希保存，会话使用 HttpOnly Cookie，脚本使用 `mpanel_` 前缀的 API Token（只存 SHA-256）。
- 所有 `/ws` 连接必须携带一次性 ticket 或 token，不接受裸连；ticket 默认 60 秒且只可使用一次。
- 文件模块所有入口先 realpath 再校验允许根前缀，拒绝 `..`、符号链接逃逸与 Windows 保留名；删除默认进回收站。
- 外部命令一律通过参数数组执行，不拼接 shell 字符串；用户输入进入 Caddyfile 前必须经过结构化校验与转义。
- 终端、计划任务与 Compose 属于**可信属主功能**：能登录面板的人等价于能在这台机器上执行命令。只把面板暴露给可信网络，并始终通过 TLS 反代。
- 边缘入网密钥只存 SHA-256、支持有效期 / 次数 / 吊销；入网接口按 IP 限流并写审计。
- 仓库、工作流与文档中不得出现真实密钥、Token 或内部 IP；生产凭据放 `conf/*.yaml` 或 `MPANEL_*` 环境变量。

## License

本仓库代码不开源，也不允许任何未经明确授权地使用。详见 [LICENSE](LICENSE)。
