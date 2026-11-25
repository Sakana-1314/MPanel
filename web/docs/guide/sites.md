# 站点与 Caddy

MPanel 用 Caddy 管理网站，而不是 nginx。站点只接受**结构化配置**，由 agent 生成 Caddyfile 片段；不支持粘贴原始 Caddyfile、`import` 或任意指令。

::: tip 实现状态
站点模型、预览/应用/导入导出与证书扫描的接口契约已冻结（见 [REST API 契约](/api/contract)）；Go 版站点模块仍在移植，本文描述目标行为。已实现的部分是 agent 配置中的 `caddy_bin`、`caddy_config`、`caddy_data`、`caddy_admin` 字段与目录解析。
:::

## 1. 为什么是 Caddy

- **片段化**：每个站点一个 `sites.d/<siteId>.caddy` 文件，主 `Caddyfile` 只有 `import sites.d/*.caddy`。增删站点就是增删文件。
- **自动 HTTPS**：`tls auto` 由 Caddy 自动申请与续期证书；`tls internal` 用本地 CA；`tls off` 只监听 HTTP。
- **可验证的 apply**：先 `caddy validate`，再备份、原子替换、`caddy reload`，失败自动回滚。每一步都有明确的阶段与输出。
- **注入边界清晰**：所有进入 Caddyfile 的用户字符串都经过校验与转义，指令名与结构由代码固定。

## 2. 目录布局

agent 的 Caddy 目录由 `caddy_config` 与 `caddy_data` 决定：

```text
${caddy_config}/                  # 默认 ${agent.data_dir}/caddy
├─ Caddyfile                      # 受管主配置：import sites.d/*.caddy
├─ sites.d/
│  └─ <siteId>.caddy              # 每站点一个片段
├─ staging/                       # 生成与 validate 的临时目录
└─ data/                          # Caddy 数据目录（证书），默认即 ${caddy_data}
   └─ certificates/...
```

默认路径：

- `caddy_config` = `/opt/mpanel/data/agent/caddy`
- `caddy_data` = `${caddy_config}/data`

主 `Caddyfile` 内容固定为：

```caddyfile
import sites.d/*.caddy
```

首次 apply 前需要保证 Caddy 进程使用这个主配置启动，否则 reload 会作用到另一个实例，站点看起来“apply 成功但不生效”。

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
- Caddy 不可用时仍返回片段，`validation=null` 并带原因，不返回 503。

### 5.2 apply 流程

```http
POST /api/v1/sites/apply
{ "siteIds": ["<siteId>"], "force": false }
```

- `siteIds` 省略 = 全量：渲染所有启用站点，并删除 `sites.d` 中已不存在站点的片段。
- `siteIds` 给定 = 只把选中站点的当前草稿渲染进 staging；未选中的站点保留现有片段，revision 不变。删除站点后的清理必须走全量 apply。
- `force=true` 即使没有 revision 变化也重写。

执行顺序：

1. **加锁**：已有 apply 在进行 → `409 CONFLICT`，`details.retryAfterMs`。
2. **渲染到 staging**：失败 → `400 BAD_REQUEST`，`stage=render`。
3. **validate**：`caddy validate --config <staging>/Caddyfile --adapter caddyfile`。失败 → `400 BAD_REQUEST`，`stage=validate`，线上配置不变。
4. **备份**：把当前 `Caddyfile` 与 `sites.d/` 复制到 `${agent.data_dir}/backups/caddy/<timestamp>/`。
5. **原子替换**：Linux 上用“新目录 → rename”替换；Windows 没有非空目录的原子替换，采用“旧目录改名 → 新目录改名”，存在毫秒级窗口。
6. **reload**：`caddy reload --config <Caddyfile> --adapter caddyfile`，默认经 `127.0.0.1:2019` 的 admin API。
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
| `503 UNAVAILABLE` | 未开始 | Caddy 不可用；安装 Caddy 或设置 `caddy_bin` 绝对路径，重启 agent |
| `400 BAD_REQUEST` | `render` | 配置字段非法；按 `details.issues` 修正 |
| `400 BAD_REQUEST` | `validate` | 看 `details.output`；检查域名、root、upstream 与 header |
| `502 UPSTREAM_ERROR`，`rolledBack=true` | `reload` | Caddy 未运行、admin 地址不可达或权限不足；检查 `caddy_admin` 与 `caddyOutput` |
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

## 7. 能力缺失时的降级

没有安装 Caddy、或 `caddy_bin` 指向的文件不存在时：

- 站点列表与草稿的增删改查仍可用（JSON 存储）；
- `preview` 仍生成片段，`validation=null`，并返回 `validationUnavailableReason`；
- `apply` 返回 `503 UNAVAILABLE`，`details.hint` 提示安装 Caddy 或设置 `caddy_bin`；
- 证书列表的可用性只取决于 `caddy_data` 目录是否可读，与 Caddy 二进制无关。

agent 不会自动安装或启动 Caddy。

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

手工校验与重载（使用与 agent 相同的路径）：

```bash
caddy validate --config /opt/mpanel/data/agent/caddy/Caddyfile --adapter caddyfile
caddy reload   --config /opt/mpanel/data/agent/caddy/Caddyfile --adapter caddyfile
```

注意：

- Caddy 的 systemd 单元必须把 `ExecStart` 指向同一个 `Caddyfile`，否则重启 Caddy 会丢失面板刚 apply 的配置。
- Caddy 需要读 `Caddyfile` 与 `sites.d/`、写 `caddy_data`（证书）；agent 需要写 `caddy_config` 与备份目录。两者不是同一用户时，用组权限或 ACL 协调。
- `caddy_admin` 默认是 `127.0.0.1:2019`；如果 Caddy 在容器或另一个网络命名空间，必须让 agent 能访问该地址，并只对可信网络开放 admin API。
- 站点根目录的属主与权限要允许 Caddy 读取，否则 validate 通过但访问 403。
