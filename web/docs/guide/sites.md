# 站点与 Caddy

MPanel 用 Caddy 管理网站，而不是 nginx。Caddy **以 Docker 容器运行**，由面板一键部署 `mpanel-caddy` 编排；站点只接受**结构化配置**，由 agent 生成 Caddyfile 片段，不支持粘贴原始 Caddyfile、`import` 或任意指令。

::: tip 部署模型
Caddy 不再依赖宿主机二进制。未部署容器时，站点列表、新建、预览、导入导出与应用全部不可用，页面只保留「一键安装 Caddy」入口。安装模板与说明在仓库 `web/store/caddy/`，通过 GitHub 链接读取。
:::

## 1. 为什么是 Caddy

- **片段化**：每个站点一个 `sites.d/<siteId>.caddy` 文件，主 `Caddyfile` 只包含受管全局块与 `import sites.d/*.caddy`。增删站点就是增删文件。
- **自动 HTTPS**：`tls auto` 由 Caddy 自动申请与续期证书；`tls internal` 用本地 CA；`tls off` 只监听 HTTP。
- **可验证的 apply**：先 `caddy validate`，再备份、原子替换、`caddy reload`，失败自动回滚。每一步都有明确的阶段与输出。
- **注入边界清晰**：所有进入 Caddyfile 的用户字符串都经过校验与转义，指令名与结构由代码固定。

## 2. 容器与目录布局

Caddy 容器由 `web/store/caddy/compose.yaml` 创建，固定项目名 `mpanel-caddy`、服务名 `caddy`。agent 通过 compose 标签定位运行中的容器，并用 `docker exec <container> caddy ...` 执行 validate/reload。

宿主目录由 `caddy_config` 与 `caddy_data` 决定：

```text
${caddy_config}/                  # 默认 ${agent.data_dir}/caddy，挂载到容器 /etc/caddy
├─ Caddyfile                      # 受管主配置：admin + import sites.d/*.caddy
├─ sites.d/
│  └─ <siteId>.caddy              # 每站点一个片段
└─ data/                          # 默认 ${caddy_data}，挂载到容器 /data
   └─ certificates/...
```

默认路径：

- `caddy_config` = `/opt/mpanel/data/agent/caddy`
- `caddy_data` = `${caddy_config}/data`
- 站点根目录 = `/opt/mpanel/data/agent/sites`（以及 `files_roots` 中的根）

安装前调用 `POST /api/v1/sites/bootstrap` 创建目录、写入主 `Caddyfile`，并返回需要写进 compose 的挂载。站点根会以**相同绝对路径**只读挂进容器，因此 `file_server.root` 在容器内仍然有效。

主 `Caddyfile` 内容固定为：

```caddyfile
# Managed by MPanel. Do not edit by hand.
{
	admin 127.0.0.1:2019
	storage file_system /data
}

import sites.d/*.caddy
```

反代宿主机服务时，upstream 用 `host.docker.internal:<端口>`（模板已配置 `extra_hosts: host-gateway`）；反代其它容器时填容器名和容器端口。

## 3. 站点模型

```ts
type SiteStatus = 'draft' | 'pending' | 'applied' | 'error' | 'disabled';

interface Site {
  id: string;
  name: string;
  enabled: boolean;
  config: SiteConfig;
  revision: number;                 // 站点级版本，每次本站点写 +1
  appliedRevision: number | null;   // 最近成功 apply 时的站点 revision
  status: SiteStatus;
  lastApply: {
    at: string;
    ok: boolean;
    revision: number;               // 全局 apply 序号
    error?: string;
    caddyfileHash?: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}
```

`SiteConfig` 的 `handler` 三选一：`reverse_proxy`、`file_server` 或 `redirect`。示例：

```json
{
  "name": "demo",
  "enabled": true,
  "config": {
    "domains": ["example.com"],
    "listen": ["0.0.0.0:443"],
    "handler": {
      "type": "file_server",
      "root": "/opt/mpanel/data/agent/sites/demo",
      "indexNames": ["index.html"],
      "spa": true,
      "precompressed": ["gzip", "zstd"]
    },
    "tls": { "mode": "auto", "email": "ops@example.com" },
    "headers": { "X-Frame-Options": "SAMEORIGIN" },
    "encode": ["zstd", "gzip"],
    "log": true
  }
}
```

关键约束：

- `domains` 为 1–50 个 hostname、`localhost` 或前导 `*.` 的通配域名。
- `file_server.root` 必须是绝对宿主路径，且在允许根白名单内（默认包含文件管理根与 `${agent.data_dir}/sites`；站点模块会校验，对应 1Panel 时代的 `MPANEL_SITES_ROOTS` 约定）。
- `reverse_proxy.upstreams`、`healthUri`、header 名与值、redirect 目标都不允许控制字符、未转义的引号或花括号。
- 站点名唯一；同一站点内域名重复会返回 `BAD_REQUEST`。
- 修改只改 JSON 草稿，不会自动 apply；删除已应用站点需要一次全量 apply 才会从 Caddy 移除。

## 4. Caddyfile 生成规则

| `SiteConfig` | 生成的片段 |
|---|---|
| `tls.mode = off` | 站点地址加 `http://` 前缀，不生成 `tls` 指令 |
| `tls.mode = auto` | 纯域名地址；有 `email` 时生成 `tls <email>` |
| `tls.mode = internal` | 纯域名地址 + `tls internal` |
| `listen[]` | block 内每个地址一行 `bind <addr>` |
| `reverse_proxy` | `reverse_proxy <upstream...> { lb_policy ...; header_up ...; transport http { tls_insecure_skip_verify } }`；`healthUri` 映射为 `health_uri` |
| `reverse_proxy.websocket` | 兼容字段；Caddy 默认支持 WebSocket，不生成额外指令 |
| `file_server` | `root * <root>`；`spa` 生成 `try_files {path} /index.html`；`browse` 生成 `file_server browse`；`precompressed` 生成 `precompressed gzip` 等 |
| `redirect` | `redir <to> permanent`；`preserveQuery` 时目标追加 `{uri}` |
| `headers` | 每个 header 一行 `header <name> <value>` |
| `encode` | `encode gzip zstd`，按数组顺序 |
| `log` | 固定 `log`，不接受用户字段 |

所有用户字符串都会经过 Caddy token 引号处理：双引号包裹、转义反斜杠与引号、拒绝控制字符。`preview` 与 `apply` 必须走同一个生成与校验路径。

## 5. 预览与 apply

### 5.1 预览

```http
POST /api/v1/sites/preview
{
  "site": { "domains": ["example.com"], "handler": { "type": "file_server", "root": "/var/www/demo" } },
  "validate": true
}
```

```ts
interface SitePreviewResult {
  caddyfile: string;
  warnings: string[];
  validation: { ok: boolean; output: string } | null;
  validationUnavailableReason?: string;
}
```

- `site` 与 `siteId` 恰好给一个；都不给或都给 → `BAD_REQUEST`。
- 预览只生成片段，不写线上目录、不改 revision。
- Caddy 容器未部署时预览也是 `503 UNAVAILABLE`；站点功能整体不可用。

### 5.2 apply 流程

```http
POST /api/v1/sites/apply
{ "siteIds": ["<siteId>"], "force": false }
```

- `siteIds` 省略 = 全量：渲染所有启用站点，并删除 `sites.d` 中已不存在站点的片段。
- `siteIds` 给定 = 只把选中站点的当前草稿渲染进 staging；未选中的站点保留现有片段，revision 不变。删除站点后的清理必须走全量 apply。
- `force=true` 即使没有 revision 变化也重写。

面板以 `Prefer: respond-async` 提交，API 立即返回 `202 { job }`，进度弹窗与任务中心轮询任务状态；下面的 validate/备份/reload 在后台依次执行。

执行顺序：

1. **加锁**：已有 apply 在进行 → `409 CONFLICT`，`details.retryAfterMs`。
2. **渲染到 staging**：失败 → `400 BAD_REQUEST`，`stage=render`。
3. **validate**：在容器内执行 `caddy validate --config /etc/caddy/<staging>/Caddyfile --adapter caddyfile`。失败 → `400 BAD_REQUEST`，`stage=validate`，线上配置不变。
4. **备份**：把当前 `Caddyfile` 与 `sites.d/` 复制到 `${agent.data_dir}/backups/caddy/<timestamp>/`。
5. **原子替换**：Linux 上用“新目录 → rename”替换；Windows 没有非空目录的原子替换，采用“旧目录改名 → 新目录改名”，存在毫秒级窗口。
6. **reload**：容器内 `caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`，默认经容器内 `127.0.0.1:2019` 的 admin API。
7. **失败回滚**：reload 失败时恢复备份目录与主配置，再次 reload；返回 `502 UPSTREAM_ERROR`，`stage=reload`、`rolledBack=true`。恢复也失败 → `500 INTERNAL`。
8. **记账**：全部成功后，本次渲染站点的 `appliedRevision` 设为当前站点 revision，`lastApply` 记录全局 apply 序号、时间与 Caddyfile 哈希。

成功响应：

```ts
interface SiteApplyResult {
  revision: number;                 // 全局 apply 序号
  appliedAt: string;
  caddyfilePath: string;
  backupPath: string | null;
  reloaded: boolean;
  rolledBack: boolean;
  sites: { id: string; name: string; status: SiteStatus }[];
  warnings: string[];
  caddyOutput: string;
}
```

### 5.3 失败对照

| 现象 | 阶段 | 处理 |
|---|---|---|
| `503 UNAVAILABLE` | 未开始 | Caddy 容器未部署；在站点页一键安装，或到编排页启动 `mpanel-caddy` |
| `400 BAD_REQUEST` | `render` | 配置字段非法；按 `details.issues` 修正 |
| `400 BAD_REQUEST` | `validate` | 看 `details.output`；检查域名、root、upstream 与 header |
| `502 UPSTREAM_ERROR`，`rolledBack=true` | `reload` | 容器内 admin 不可达、配置被外部改动或容器异常；检查容器日志与 `caddyOutput` |
| `409 CONFLICT` | 加锁 | 等 `retryAfterMs` 后重试，不要并发 apply |
| `500 INTERNAL` | 回滚也失败 | 检查磁盘空间与目录权限，从 `backups/caddy/` 手工恢复 |

## 6. 站点状态

| status | 条件 |
|---|---|
| `disabled` | `enabled=false` |
| `error` | `lastApply.ok=false` |
| `draft` | `appliedRevision=null` 且从未尝试 apply |
| `pending` | `appliedRevision` 与当前 `revision` 不一致 |
| `applied` | `appliedRevision === revision` 且最近一次 apply 成功 |

## 7. 未部署时的行为

Caddy 只以容器运行，不提供宿主机二进制回退。`mpanel-caddy` 编排的 `caddy` 容器未运行时：

- `capabilities.caddy.available=false`，`reason` 区分「Docker 不可用」「容器未部署」「容器运行但 caddy 命令异常」；
- `GET /sites` 返回 `200` + `{available:false,reason,items:[]}`；
- 其余 `/sites` 端点（含 preview、export、import）返回 `503 UNAVAILABLE`，`details.reason` 带上具体原因，`details.hint` 指向一键安装；
- 面板站点页不展示列表与编辑入口，只保留安装卡片；
- `POST /sites/bootstrap` 仍可用，用于安装前准备目录与挂载；
- 证书列表的可用性只取决于 `caddy_data` 目录是否可读，与容器是否运行无关。

安装步骤（面板自动完成）：

1. 从 `web/store` 读取 `caddy/app.json` 与 `caddy/compose.yaml`；
2. `POST /sites/bootstrap` 创建目录、写入主 Caddyfile，拿到挂载列表；
3. `POST /stacks` 创建 `mpanel-caddy` 编排（已存在则复用），再 `POST /stacks/mpanel-caddy/up`；
4. 轮询 `GET /system/info?refresh=1`，直到 `capabilities.caddy.available=true`。

Docker 或 Compose v2 缺失时安装会失败，页面会展示可执行的错误输出；修复后点「检查状态」重试。

## 8. 证书扫描

`GET /api/v1/certs` 只读扫描 `caddy_data` 下的证书：

- 路径模式：`certificates/**/*.crt` 与 `certificates/**/*.pem`；
- 只解析 X.509 公钥证书，**绝不读取或返回私钥**；
- `id` 使用 SHA-256 指纹；同一证书的 `.crt`/`.pem` 副本按指纹去重；
- `daysRemaining = floor((notAfter - now) / 86400000)`，可为负；
- `status`：已过期 `expired`，剩余不超过 14 天 `expiring`，其余 `valid`，无法解析为 `unknown`；
- 单个证书解析失败只跳过并记 warning，不让整个列表失败；
- `caddy_data` 不存在或不可读 → `available=false`，`items=[]`；
- 不提供手动续期/删除，证书生命周期交给 Caddy。

## 9. 运维命令

容器健康后，手工校验与重载（与 agent 执行位置一致）：

```bash
docker exec mpanel-caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker exec mpanel-caddy caddy reload   --config /etc/caddy/Caddyfile --adapter caddyfile
```

注意：

- 不要在宿主机另起 `caddy run` 使用同一份配置；容器是唯一实例。
- `caddy_config` 与 `caddy_data` 由容器写入，agent 需要读写权限；站点根目录需要容器可读，否则 validate 通过但访问 403。
- 修改 compose（例如增加站点根挂载）请到「编排」页编辑 `mpanel-caddy`，不要直接改容器。
- admin API 只在容器回环地址监听，不对外发布；agent 通过 `docker exec` 操作，不依赖宿主端口。
