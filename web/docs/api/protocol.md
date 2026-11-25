# 隧道协议（core ↔ agent）

core 与 agent 之间只有一种应用层协议：把 HTTP 请求/响应与 WebSocket 帧装进 JSON 帧。
stdio 模式按 NDJSON 分帧，reverse-ws 模式一条 WebSocket 文本消息一帧。http 传输不走隧道，
core 直接反向代理真实 HTTP。

## 帧格式

```json
{ "kind": "http-request", "phase": "head", "id": "r_xxx", "method": "GET", "url": "/api/v1/system/info", "headers": {}, "stream": true }
```

| kind | 方向 | 说明 |
|---|---|---|
| `hello` | worker → core | 注册：`v`、`role`、`machineId`、`worker` 描述、`protocol` 限制 |
| `ping` / `pong` | 双向 | 心跳；core 每 10s 发 ping，30s 无任何帧判定断开 |
| `http-request` | core → worker | `phase=head` 带 method/url/headers；body 超过 512KiB 时用 `phase=chunk` 分块，`final=true` 结束 |
| `http-response` | worker → core | `phase=head` 带 status/headers；响应体流式回 `phase=chunk` |
| `ws-open` | 双向 | core 请求打开流；worker 回 `accepted`/`status` |
| `ws-frame` | 双向 | `data` + `dataEncoding`（`utf8` 或 `base64`） |
| `ws-close` | 双向 | 关闭码与发起方 |

## 约束

- 单帧上限 16 MiB；分块 512 KiB；单条 WS 消息上限 4 MiB。
- 请求按 `id` 多路复用；每个方向只允许一个写者（互斥）。
- 客户端断开时 core 发送 `http-request` + `phase=cancel`，worker 取消上游请求。
- agent 的 WS 路由与直连 HTTP 共用同一张注册表（`agent.WSRegistry`），因此终端、容器日志
  在三种传输下行为一致。
- `hello` 中的 `worker` 描述用于 core 侧「机器」页展示版本与能力；能力以
  `GET /api/v1/system/info` 为准。

## 传输选择

| 传输 | 适用 | 说明 |
|---|---|---|
| `http` | worker 可被 core 访问 | core 用 `http.Client` 反向代理，流式转发 |
| `stdio` | 同机、由 core 拉起 | `mpanel-core` spawn `mpanel-agent serve`，stdin/stdout 走 NDJSON |
| `reverse-ws` | NAT/防火墙后、边缘节点 | agent 主动拨号 `wss://core/ws/worker`，Bearer machine secret 认证 |

## 边缘入网（不走帧）

边缘节点不新增帧类型：agent 先 `POST /api/v1/edge/enroll`（入网密钥）换取 machine secret，
写入 `$MPANEL_AGENT_DATA_DIR/identity.json`（0600），随后用既有 `/ws/worker` 握手拨号。
身份复用，密钥变化或 core 地址变化时重新入网。
