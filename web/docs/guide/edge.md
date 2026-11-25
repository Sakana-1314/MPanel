# 边缘节点

边缘节点不是第四种传输，而是 `reverse-ws` 的一种**入网方式**：节点不需要在 core 预建机器，而是用一枚共享的**入网密钥**自助注册，注册后与普通 reverse-ws 机器完全同构，复用同一套 `/ws/worker` 握手、代理路径与 WebSocket 隧道。

::: tip 实现状态
边缘入网、快照与离线作业的接口契约已冻结（见 [REST API 契约](/api/contract)）；Go 版 core/agent 的边缘模块仍在移植，本文描述目标行为。当前已实现的是 agent 配置模型中的 `core_url`、`machine_id`、`machine_secret`、`edge_key` 字段与环境变量覆盖。
:::

## 1. 适用场景

- 目标机在 NAT、防火墙或家庭宽带后，无法让 core 主动连接；
- 节点数量多，逐台在 core 创建机器不现实；
- 需要按分组批量管理，并接受节点离线时作业排队、重连后补跑。

如果节点有固定公网地址、且你希望 core 主动探测，用 `http` 传输更简单；如果是少量同机节点，`stdio` 也可以，但它等于在 core 主机执行命令，只应给可信管理员使用。

## 2. 创建入网密钥

在 core 的「边缘节点」页面创建，或直接调用 API：

```bash
curl -sS -X POST https://panel.example.com/api/v1/edge/keys \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <core-token>' \
  -d '{
    "name": "生产边缘",
    "group": "prod",
    "ttlSec": 86400,
    "maxUses": 50
  }'
```

响应里的 `secret`（`mpedge_...`）**只显示一次**，请立即保存到部署系统或密码管理器。

| 字段 | 说明 |
|---|---|
| `name` | 密钥名称，便于识别 |
| `group` | 可选的机器分组；入网机器自动继承 |
| `ttlSec` | 有效期；不传或为 `null` 表示不过期 |
| `maxUses` | 最大入网次数；`0` 表示不限 |
| `uses` / `lastUsedAt` | 已使用次数与最后使用时间，由 core 维护 |
| `revokedAt` | 吊销时间；吊销后不能继续入网 |

相关端点：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/v1/edge/keys` | 列表（`ListResult<EdgeKey>`） |
| `POST` | `/api/v1/edge/keys` | 创建，响应含一次性 secret |
| `DELETE` | `/api/v1/edge/keys/:id` | 吊销；不影响已入网节点 |

## 3. 在节点上启动 agent

节点只需要**出站网络**，不需要开放入站端口。最小环境：

```bash
export MPANEL_TRANSPORT=reverse-ws
# 注意：这里填 HTTP(S) 基地址，不是 ws://.../ws/worker
export MPANEL_CORE_URL=https://panel.example.com
export MPANEL_EDGE_KEY=mpedge_xxx
export MPANEL_AGENT_BASE_DIR=/opt/mpanel

/usr/local/bin/mpanel-agent
```

也可以写成 systemd 环境文件 `/etc/mpanel/agent.env`：

```bash
MPANEL_AGENT_BASE_DIR=/opt/mpanel
MPANEL_TRANSPORT=reverse-ws
MPANEL_CORE_URL=https://panel.example.com
MPANEL_EDGE_KEY=mpedge_xxx
# 可选：显式指定配置层字段名（与 MPANEL_TRANSPORT 等价）
# MPANEL_AGENT_TRANSPORT=reverse-ws
```

启动过程：

1. agent 读取 `MPANEL_EDGE_KEY`，向 `${MPANEL_CORE_URL}/api/v1/edge/enroll` 发送入网请求；
2. core 校验密钥（存在、未吊销、未过期、`uses < maxUses`），创建一台 `transport=reverse-ws`、`edge=true` 的机器，返回一次性的 machine secret 与 WS 地址；
3. agent 把身份写入 `${MPANEL_AGENT_BASE_DIR}/data/agent/edge.json`（权限 `0600`），内容包括 `machineId`、`secret`、`coreUrl`、`keyFingerprint`；
4. agent 用该 secret 拨 `wss://panel.example.com/ws/worker`，发送 `hello`，之后与普通 reverse-ws 机器完全一致。

后续重启会复用 `edge.json`，不会重复消耗 `maxUses`。

## 4. 快照

边缘节点上线后，core 立即请求一次 `GET /system/snapshot`，之后每 5 分钟刷新，写入 `machine.snapshot`。

```ts
interface SystemSnapshot {
  collectedAt: string;
  hostname: string;
  platform: string;            // linux | win32 | darwin
  arch: string;
  release: string;
  nodeVersion: string;         // 契约保留字段；Go 版填运行时版本
  workerVersion: string;       // 契约保留字段；Go 版填 agent 版本
  uptimeSec: number;
  cpuCount: number;
  loadavg: [number, number, number] | null;
  memTotalBytes: number;
  memFreeBytes: number;
  diskTotalBytes: number | null;
  diskFreeBytes: number | null;
  ips: string[];
  transport: string;
  pty: boolean;
}
```

- 快照失败只更新 `lastError`，保留上一份快照，不改变在线状态。
- 快照用于列表与概览展示，不参与调度决策。
- `GET /system/metrics` 是更轻量的实时指标（CPU、内存、磁盘、uptime），节点侧同样不得因缺少外部命令而失败。

## 5. 离线作业

节点离线时，可以在 core 的「边缘节点 → 作业」里排队异步作业；节点重连后按 `createdAt` 顺序**串行**补跑。

| kind | core 实际调用 |
|---|---|
| `snapshot` | `GET /system/snapshot` |
| `run-task` | `POST /tasks/:id/run`，`payload.taskId` |
| `apply-site` | `POST /sites/apply`，请求体 `{ "siteIds": ["<siteId>"] }` |

作业状态：

```text
pending → running → succeeded
                  ↘ failed
pending → canceled
```

规则：

- core 每 10 秒调度一次；同一机器上的作业串行执行。
- 节点离线或请求中断时，作业回到 `pending` 并保留，不计入重试次数。
- 网络类失败最多重试 1 次；业务 4xx 直接 `failed`，不重试。
- `result` 是响应 `data` 的 JSON；超过 16 KB 截断并标记 `{truncated: true, sizeBytes, preview}`。
- 作业队列保存在 core 的本地状态里。core 不可用期间不会执行；迁移 core 主机时必须连同 `/opt/mpanel` 一起备份恢复。

端点：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/v1/edge/jobs` | 按 `machineId`、`status` 过滤，分页 |
| `POST` | `/api/v1/edge/jobs` | 创建作业，`201` |
| `GET` | `/api/v1/edge/jobs/:id` | 详情 |
| `DELETE` | `/api/v1/edge/jobs/:id` | 仅允许删除 `pending` 作业 |

## 6. 网络与反向代理

- `MPANEL_CORE_URL` 必须是 **HTTP(S) 基地址**。agent 会自行派生入网地址与 WS 地址；填 `ws://.../ws/worker` 会导致入网请求发错位置。
- 反向代理必须：
  - 放行 `POST /api/v1/edge/enroll`（免登录，凭 key，限流 10 次/分钟/IP）；
  - 为 `/ws/worker` 透传 `Upgrade` 与 `Connection`；
  - 超时足够长（反向代理读超时至少 620 秒，WS 空闲不要过早断开）。
- 生产只用 `wss://`；`MPANEL_CORE_INSECURE=1` 一类跳过证书校验的开关只用于本地自签调试，不要带到生产。
- 入网审计：core 追加 `edge.enroll`，记录 keyId、machineId 与来源 IP，不记录 secret。

## 7. 身份、轮换与排查

### 7.1 身份文件

`${MPANEL_AGENT_BASE_DIR}/data/agent/edge.json`（`0600`）保存 machineId、secret、coreUrl 与密钥指纹前缀。

- 删除该文件并保留 `MPANEL_EDGE_KEY` 会重新入网，**生成一台新机器**；旧机器记录需要手工删除。
- 吊销入网密钥**不会**断开已入网节点：它们使用各自的 machine secret。要踢掉节点，用「断开/删除机器」，或轮换该机器的 secret（旧连接立即失效）。
- 备份 agent 时把 `edge.json` 与 `conf/agent.yaml` 一起备份；恢复后节点仍是同一台机器。

### 7.2 入网 403

| 可能原因 | 处理 |
|---|---|
| 密钥已吊销 | 用新密钥重新入网 |
| 密钥已过期 | 延长/重建密钥，更新 agent 环境变量并重启 |
| `uses >= maxUses` | 提高上限或换新密钥 |
| `MPANEL_CORE_URL` 填成了 WS 地址 | 改成 `https://panel.example.com` 形式 |
| 请求根本没到 core | 检查反向代理是否放行 `POST /api/v1/edge/enroll`，看 core 审计是否有 `edge.enroll` |
| 节点反复离线 | 检查 `/ws/worker` 的 Upgrade 透传、TLS 证书与 WS 超时 |

更多排障项见[故障排查](/ops/troubleshooting#agent-入网-403)。
