# core ↔ worker 隧道协议 v1

状态：冻结（2026-11-25）。唯一实现：`server/shared/src/protocol.ts`（zod schema + 编解码）。本文件描述字节层绑定、状态机、心跳/重连和三种传输的差异。HTTP 传输不使用本协议。

## 1. 范围与传输绑定

| 传输 | 是否使用帧 | 帧承载 | 备注 |
|---|---|---|---|
| `http` | 否 | 真实 HTTP/WS 反向代理 | core 以 worker token 认证；见 §9 |
| `stdio` | 是 | worker stdout / core stdin 的 **NDJSON** | stdout 只允许帧；stderr 是日志 |
| `reverse-ws` | 是 | 一条 WebSocket 的**文本消息**，每条消息一个 JSON 帧 | 二进制消息非法；子协议 `mpanel.tunnel.v1` |

- 所有帧都是 UTF-8 JSON 对象；不使用 MessagePack/CBOR。
- 隧道是**多路复用**的：一条 stdio 管道或一条 reverse-ws 同时承载多个 HTTP 请求与多个 WS 流，靠 `id` 关联。
- 协议版本 `v=1`；`hello` 之外不重复版本字段。hello.v 先按整数解析，transport 再校验是否为 1，以便返回 4002。

## 2. 分帧

### 2.1 stdio（NDJSON）

- 每个帧编码为一行：`JSON.stringify(frame) + "\n"`；行内不允许裸换行（JSON 字符串中的换行会转义）。
- 读取端按 `\n` 切分；忽略空行（`\r?\n` 均可）；跨 chunk 的半行必须缓冲。
- 单行最大 `TUNNEL_MAX_FRAME_BYTES = 16 MiB`；超过则终止隧道（关闭子进程/连接），记录 `lastError`。
- **stdout 从进程启动到退出只允许帧**。worker 的 logger 在 `MPANEL_TRANSPORT=stdio` 时强制写 stderr；任何 `console.log` 都被 lint/check 禁止。
- stderr 按行读取，作为 worker 日志进入 core 的 ring buffer 与 `logs/workers/<machineId>.log`，不参与协议；redact 后最多保留 1000 行/10 MiB。
- stdin 关闭（EOF）视为 core 要求退出；worker 优雅关闭后退出。

### 2.2 reverse-ws

- 每条 WebSocket **text message** 必须恰好是一个完整 JSON 帧；不要求尾随换行（允许空白）。
- 不允许二进制消息；收到 binary → close `1003 UNSUPPORTED_DATA`。
- 单条消息最大 16 MiB；超过 → close `1009`（标准 Message Too Big）或应用码 `1013`；实现统一用 `1013` 并记录。
- 不把多个帧拼进一个 WS 消息；也不把一帧拆到多个 WS 消息。
- 使用 `Sec-WebSocket-Protocol: mpanel.tunnel.v1` 协商；不接受该子协议的 core 拒绝升级。

### 2.3 HTTP

HTTP 传输没有帧、没有 hello、没有心跳协议；core 直接请求 worker，见 §9。

## 3. 公共字段与 id

```ts
interface FrameBase {
  kind: TunnelFrameKind;
  id?: string;   // 需要关联的帧必填；hello/ping/pong 见各节
}
```

- `id`：1–128 字符，ASCII 可见字符。core 生成 `c-<单调递增>-<随机>`；worker 生成 `w-...`。只在单条隧道内唯一；不同机器可重复。
- **请求 id 由发起方生成**，响应必须原样回显。同一 id 在未完成前不得复用。
- HTTP 请求 id（core 发起）与 WS 流 id（core 发起）共享命名空间即可，但建议分开前缀 `h-`/`w-`。
- `seq`：每个方向、每个 id 独立，从 0 开始连续递增；接收端发现缺口 → 该流失败（HTTP 502 / WS close 1011），隧道本身可继续。
- 所有 `id`/`seq` 只用于关联，不用于鉴权。

## 4. 帧类型

zod 定义见 `server/shared/src/protocol.ts`；下面是语义与约束。除 `http-request`/`http-response` 的 head/chunk/cancel 子形状外，`kind` 只有八种。

### 4.1 `hello`

```ts
{
  kind: 'hello';
  v: number;                      // 解析后由 transport 校验必须为 1
  role: 'core' | 'worker';
  machineId?: string;
  accepted?: boolean;
  reason?: string;
  token?: string;                 // 仅 stdio worker→core
  worker?: WorkerDescriptor;      // worker→core
  core?: { name; version; apiVersion; protocolVersion }; // core→worker
  protocol?: { maxFrameBytes: number; chunkBytes: number; maxInflightRequests?: number; maxWsStreams?: number };
  sentAt?: string;
}
```

- worker 在 stdio/reverse-ws 建立后**立即**发送 hello；core 在收到后 5 秒内回复 `hello {role:'core', accepted:true|false, machineId, core, protocol}`。
- `accepted=false`：core 发送后关闭（stdio kill / WS close 4002 或 4403），`reason` 说明。
- 版本不匹配：`accepted=false` + close `4002 VERSION_MISMATCH`。
- reverse-ws 的身份已由升级请求的 secret 决定；hello 的 `machineId` 用于交叉校验，不匹配 → 拒绝。
- stdio 的 hello 携带 `token`（来自 `MPANEL_TOKEN`）；core 与机器记录比对，失败 → `accepted=false` 后终止子进程。core 同时把 `MPANEL_TOKEN` 放进子进程 env，双保险。
- `protocol` 用于声明本端限制；实际使用两端较小值（帧上限/并发/WS 流）。v1 默认 16 MiB / 512 KiB / 128 / 64。
- hello 之后才能发送任何其他帧；hello 之前收到其他帧 → 协议错误，关闭隧道。

### 4.2 `ping` / `pong`

```ts
{ kind: 'ping'; id: string; ts: number }
{ kind: 'pong'; id: string; ts: number }
```

- `ts` 是发送方 `Date.now()` 毫秒；pong 必须回显 ping 的 `id` 与 `ts`（用于 RTT）。
- 双向都可发起；core 每 10 s 发一次；worker 可只回应。若 30 s 内没有收到任何 pong/其他帧，视为半开：core 关闭并标记 offline；worker 关闭并重连（reverse-ws）或退出等待 core 重启（stdio）。
- 心跳不参与 HTTP/WS 的请求 id 空间。

### 4.3 `http-request`

三种子形状，`kind` 相同，用 `phase` 区分（`head` 可省略）。

**head**

```ts
{
  kind: 'http-request';
  phase?: 'head';
  id: string;
  method: string;                 // GET/POST/...
  url: string;                    // origin-form：/api/v1/files/list?root=files
  headers: Record<string, string | string[]>;
  bodyBase64?: string;            // 完整 body（小请求）
  stream?: boolean;               // true 表示后续 chunk 帧
  remoteAddress?: string;         // core 观察到的客户端地址（仅日志）
}
```

**chunk**

```ts
{
  kind: 'http-request';
  phase: 'chunk';
  id: string;
  seq: number;                    // 0,1,2...
  chunkBase64: string;            // 原始字节的 base64
  final?: boolean;
}
```

**cancel**

```ts
{ kind: 'http-request'; phase: 'cancel'; id: string; reason?: string }
```

规则：

- 没有 body 的请求只发 head（`bodyBase64` 省略）。
- 小 body 可放 `bodyBase64`；大/未知 body 用 `stream:true` + chunk，最后一个 chunk `final:true`。
- `bodyBase64` 与 `stream:true` 互斥；同时出现 → 协议错误。
- chunk 帧 `seq` 严格从 0 递增；`chunkBase64` 解码后 ≤ `chunkBytes`（默认 512 KiB）；总 body 可达流式大小，但受 worker 自身上传限制。
- core 在客户端断开/超时时发 `cancel`；worker 收到后中止 loopback 请求。已发送的响应可以丢弃。
- worker 只为 `http-request` 发送 `http-response`；不接受 worker 主动发起的 HTTP 请求（v1 单向）。
- `url` 必须是 origin-form；拒绝 `http://`、`//host`、反斜杠、控制字符。worker 用它拼接 loopback URL，不允许改变目标主机。
- 不转发客户端 `host`/`cookie`/`authorization`/`connection`/`content-length` 以外的逐跳头；worker 侧 loopback 请求带自己的 `Host: 127.0.0.1` 和 Bearer token。

### 4.4 `http-response`

**head**

```ts
{
  kind: 'http-response';
  phase?: 'head';
  id: string;
  status: number;
  headers: Record<string, string | string[]>;
  bodyBase64?: string;
  stream?: boolean;
  error?: { code: ErrorCode; message: string; details?: unknown };
}
```

**chunk**

```ts
{ kind: 'http-response'; phase: 'chunk'; id: string; seq: number; chunkBase64: string; final?: boolean }
```

规则：

- 正常响应：head 可带完整 body（`bodyBase64`）；流式响应 head `stream:true`，随后 chunk，最后 `final:true`。
- `headers` 可包含多个 `set-cookie`（数组）；core 不透传 `set-cookie`。
- 若 worker 在处理前发生内部错误，仍返回 `http-response` head：`status=502`、`error={code,message,details}`；core 转为 API 失败信封。若已发送 head 后出错，发送一个 `phase:'chunk', final:true, chunkBase64:''` 并关闭该流（HTTP 客户端看到截断的 body；core 记录错误）。
- 响应 chunk 顺序必须与请求顺序一致；`seq` 独立从 0 开始。
- HEAD 请求可以没有 body；GET 404 等仍返回 worker 的 JSON 信封。
- 大文件下载以 512 KiB chunk 流式发送，不在 worker 内存中聚合。

### 4.5 `ws-open`

```ts
// 请求（core → worker）
{
  kind: 'ws-open';
  id: string;
  path: string;                   // /ws/terminal/term_1?x=1（含 query）
  headers: Record<string, string | string[]>;
  protocols?: string[];
}

// 回复（worker → core，同一 id）
{
  kind: 'ws-open';
  id: string;
  accepted: boolean;
  status?: number;                // 拒绝时的 HTTP 语义状态
  reason?: string;
}
```

- core 发起 open，worker 回复同 id 的 open：
  - `accepted:true`：随后可发 `ws-frame`。
  - `accepted:false`：`status`（如 404/503）+ `reason`；该 id 关闭。
- `path` 必须以 `/ws/` 开头并包含 query；worker 把 pathname 与 rawQuery 分开传给 `WsBridge`（rawQuery 保留重复参数/编码），再在 loopback 上打开同路径 WS。
- worker WS gateway 的认证顺序/集合：`Authorization: Bearer <MPANEL_TOKEN>`（core http 传输/服务端直连）、`?token=<MPANEL_TOKEN>`（隧道 loopback）、`?ticket=`（浏览器直连）。三者都必须接受；ticket 绑定比较时剔除 `ticket`/`token` 并排序业务 query。
- core 转发客户端 header 时剥离 `cookie`、`authorization`、`host`、`sec-websocket-*`；`protocols` 单独传递。worker loopback 使用自己的 token（query），不使用用户 ticket；core http 传输使用 Bearer header。core 代理 WS 在发 `ws-open` 前剔除用户 `ticket`/`token` query，只保留业务参数。
- worker 找不到路由 → accepted:false status 404；能力不可用 → 503 + reason。
- 每个 WS 流 id 独立；一个隧道最多 64 条同时打开的流（可协商）。超限 → accepted:false 503 `reason:"too many ws streams"`。
- 不允许 worker 主动 `ws-open` 到 core（v1 单向）。

### 4.6 `ws-frame`

```ts
{
  kind: 'ws-frame';
  id: string;
  data: string;
  dataEncoding: 'utf8' | 'base64';
  seq?: number;                   // 可选；建议每个方向递增
}
```

- 文本帧：`dataEncoding:'utf8'`，`data` 原样字符串。
- 二进制帧：`dataEncoding:'base64'`，`data` 是标准 base64；解码后 ≤ 4 MiB。`wsFrameSchema` 在 shared 中用字节长度 refine 强制执行 4 MiB（utf8 按 UTF-8 字节，base64 按解码长度），transport 仍可在更早处拒绝超大帧。
- 应用层协议（终端/日志）自身是 JSON 文本；`ws-frame` 不解析它。
- 收到未 open 的 id → 协议错误，隧道关闭；收到已 close 的 id → 丢弃并记录。
- `seq` 若提供必须连续；缺口 → close 该 WS `1011`，隧道继续。

### 4.7 `ws-close`

```ts
{
  kind: 'ws-close';
  id: string;
  code?: number;                  // 1000..4999
  reason?: string;                // ≤123 字节
  initiator?: 'core' | 'worker';
}
```

- 任一端可发起；收到后关闭本地 loopback/客户端 socket，并释放流。**不要求回显 close**；若对端随后发送同 id 的 close，忽略。
- 应用默认码：正常 1000；认证 4401；禁止 4403；找不到 4404；背压 1013；内部 1011；隧道替换 4001；版本 4002；上游不可用 4502。
- close 后 id 可回收（建议延迟 60 s 防迟到帧）。

## 5. HTTP 请求生命周期（core 视角）

```
core                                   worker
 |-- http-request head (stream) ------->|
 |-- http-request chunk seq0 ---------->|  loopback fetch
 |-- http-request chunk seq1 final ---->|
 |<---------- http-response head -------|
 |<---------- http-response chunk 0 ----|
 |<---------- http-response chunk 1 -----|
 |<---------- ... final -----------------|
```

- core 的 `MachineService.request()` 返回 `{status, headers, body: Readable}`；代理层直接 pipe 给浏览器。
- 请求体：core 从 Fastify 请求流读取，边读边发 chunk；客户端断开 → `cancel`。
- 响应体：worker 从 loopback `fetch` 的 `ReadableStream` 读取，边读边发 chunk；worker 的 loopback 流背压会暂停隧道读取（stdout drain / WS bufferedAmount）。
- 超时：core 每个请求默认 120 s（文件上传/大下载可到 600 s）；超时 → `cancel` + core 返回 `504`? 使用错误码 `UPSTREAM_ERROR` 502（契约没有 504）。
- 并发：每隧道 128 个 inflight；core 超出后排队等待，队列上限 256，仍超出 → 代理返回 `503 UNAVAILABLE`（hint: tunnel busy）。
- worker 端 loopback fetch 超时由 worker 自身路由/命令超时控制；隧道断开会 abort loopback。

## 6. WS 流生命周期

```
core                         tunnel                      worker loopback
 |-- ws-open (id=w1) ----------------------------------->|  WS connect /ws/...
 |<-- ws-open accepted:true ------------------------------|
 |-- ws-frame utf8 (terminal input JSON) ---------------->|  socket.send
 |<-- ws-frame utf8 (terminal output JSON) ---------------|  socket.onmessage
 |-- ws-close 1000 -------------------------------------->|  socket.close
```

- 多个流并发：终端 `w1`、容器日志 `w2` 的帧交错；按 `id` 分发。
- 客户端 WS 断开：core 发 `ws-close`（code 1001/1000），worker 关闭 loopback socket。
- worker loopback 关闭：发 `ws-close`，core 关闭浏览器 socket。
- 文本消息上限 4 MiB（shared schema 强制）；应用层终端输入限制 1 MiB。
- 背压：
  - core 监测浏览器 socket 的 `bufferedAmount`，超过 8 MiB 暂停从隧道读该流，或向 worker 发 close 1013（v1 选择：暂停读取，30 s 仍高则 close 1013）。
  - worker 监测 loopback socket 的 `bufferedAmount`；超过 8 MiB 暂停向隧道写，stdout/WS 通道 drain 后继续。终端 handler 通过 `PtyLike.pause()/resume()`（fallback 用 stream.pause/resume）停读 PTY，并在 `WsSink.waitForDrain()` 后恢复。
  - 隧道级背压：stdio `write()` 返回 false 时等待 drain；reverse-ws `bufferedAmount` 高时等待 `drain`/定时器。

## 7. 心跳、断线与重连

### 7.1 心跳

- core 每 10 s 发送 `ping`；记录 RTT；worker 立即 `pong`。
- 30 s 无 pong 且无其他入站帧 → core 关闭隧道，机器 `offline`，`lastError="heartbeat timeout"`。
- worker 侧 30 s 无 core 帧 → 主动关闭并重连（reverse-ws）/退出（stdio，由 core 重启）。
- 心跳期间仍可正常收发请求；不要因心跳阻塞队列。

### 7.2 reverse-ws 重连

- worker 断线后指数退避：1s, 2s, 4s … 最大 30s，±20% jitter；机器 `enabled` 时无限重试。
- 重连成功发 hello；core 用同一个 machine id 替换旧连接（若旧连接僵尸，先 close 4001）。
- core 记录 `reconnectAttempts`/`lastSeenAt`；前端轮询或 `/system/overview` 展示。
- core 重启：worker 自动重连；core 从 JSON 恢复机器，ticket/session 失效（前端重新换票）。
- secret 轮换/禁用：core 关闭连接并拒绝新 secret；worker 日志提示 401，继续按退避重试。

### 7.3 stdio 重启

- core spawn 子进程；退出（无论码）→ 机器 offline；`enabled=true` 时按 1s→30s 退避重启，连续 5 次失败后 `status=error`，需手动 `/connect`。
- stdout 出现非法帧/超限 → 立即 kill 子进程，`lastError` 记录，按失败重启。
- core 优雅关闭：先 SIGTERM，5 s 后 kill；stdin EOF 通知 worker。
- worker 退出码 0 且 core 未要求关闭 → 视为异常，重启。
- stdio 子进程 env 至少包含：`MPANEL_TRANSPORT=stdio`、`MPANEL_TOKEN`、`MPANEL_HOME`（每机器独立）；worker 的 stderr 不阻塞（持续读取）。

## 8. reverse-ws 注册握手

```
worker                                              core
  |-- GET /ws/worker HTTP/1.1 ---------------------->|
  |   Upgrade: websocket                            |
  |   Sec-WebSocket-Protocol: mpanel.tunnel.v1      |
  |   Authorization: Bearer <machineSecret>         |
  |<------------- 101 Switching Protocols -----------|
  |-- hello {role:'worker', v:1, worker, protocol} ->|  // v 在 hello 中放宽为整数，transport 再校验
  |<-- hello {role:'core', accepted:true, ...} ------|
  |-- ping/pong + http/ws frames ------------------->|
```

- 端点：`GET /ws/worker`（core），必须 Upgrade。
- 认证：`Authorization: Bearer <secret>`；`secret` 只在创建/轮换时显示一次，core 存 SHA-256。`?machineId=&secret=` 兼容形式默认**关闭**，只有 `MPANEL_ALLOW_WS_QUERY_SECRET=1` 才接受；始终优先 header，query secret 会进日志。
- core 校验：机器存在、`transport='reverse-ws'`、`enabled=true`、secret 哈希匹配；失败在升级前返回 401/403（不建立 WS）。
- 子协议：core 必须回显 `mpanel.tunnel.v1`；worker 校验；不匹配则断开。
- 升级后 5 s 内必须收到 hello；否则 close 4002（无 hello 与版本不匹配统一使用 VERSION_MISMATCH）。
- hello 的 `machineId` 与 secret 对应机器不一致 → close 4403。
- 同一机器已有连接：新连接优先，旧连接 close 4001；core 只保留一个活跃驱动。
- TLS：生产必须 `wss://`；worker 默认校验证书；`MPANEL_CORE_INSECURE=1` 仅用于开发（日志警告）。
- 代理环境：`MPANEL_CORE_URL` 可以是 origin（`https://host`）、带路径前缀的基地址（`https://host/mpanel`）或完整 WS 地址（`wss://host/mpanel/ws/worker`）。worker 规范化：pathname 已以 `/ws/worker` 结尾则原样使用，否则追加 `/ws/worker`；http(s) 自动转 ws(s)。部署反代需保留该路径。

## 9. HTTP 传输（无帧）

- core 的 `HttpTransportDriver` 对 worker 发起真实 HTTP：
  - 注入 `Authorization: Bearer <MPANEL_TOKEN>`、`x-mpanel-request-id`、`x-mpanel-user`。
  - 不转发浏览器 `cookie`/`authorization`。
  - 请求体流式转发；响应体流式返回。
- core 的 WS 直连：`new WebSocket(workerWsUrl, { headers: { Authorization: Bearer <token> } })`，路径与帧由 worker 原生协议处理（终端/日志 JSON）。
- 健康：`GET /api/v1/system/info` 每 15 s；连续 3 次失败 → `offline`；成功 → `online`，记录 RTT。
- 机器 token 错误：worker 401 → core `UPSTREAM_ERROR`（`details.stage='auth'`），机器 `error`。
- HTTP 传输没有隧道复用；并发由 HTTP agent/keep-alive 控制。

## 10. 路径与头映射

core 代理的客户端路径 `/api/v1/machines/:id/proxy/<suffix>`：

| suffix | 隧道 `http-request.url` | worker loopback |
|---|---|---|
| `/sites` | `/api/v1/sites` | `http://127.0.0.1:<port>/api/v1/sites` |
| `/files/download?root=files&path=/a` | `/api/v1/files/download?...` | 同路径 |
| `/ws/terminal/t1` | `ws-open.path=/ws/terminal/t1` | `ws://127.0.0.1:<port>/ws/terminal/t1` |

- 隧道内 `http-request.url` 永远是 origin-form；worker 只接受 `/api/v1/` 与 `/healthz`（loopback 自检），其他路径 404。
- `ws-open.path` 只接受已注册的 `/ws/` 路由；未知路由 accepted:false。
- core 不透传 `cookie`、`authorization`、`connection`、`transfer-encoding`、`upgrade`、`sec-websocket-*`；`host` 由 loopback 生成。
- `x-forwarded-for`/`x-real-ip` 不信任客户端值；core 可把观察到的地址放 `remoteAddress`，worker 作为日志字段，不用于授权。

## 11. 错误处理与关闭

| 场景 | 处理 |
|---|---|
| 非法 JSON / zod 校验失败 | 协议错误：stdio kill 子进程；reverse-ws close 1002；core 标记机器 error |
| 未知 `kind` | 同上 |
| 未知/重复 `id` | 丢弃并记录；重复使用 inflight id → 协议错误 |
| chunk seq 缺口 | 该 HTTP 流 502 / 该 WS 流 close 1011；隧道可继续 |
| 请求体超限 | worker 返回 `http-response` head `status=400` + `error.code='BAD_REQUEST'`（`details.hint`）；上传限流同样用 400 |
| 响应 chunk 超限 | worker 主动中止，发 head/error 或截断 chunk；core 记录 |
| 隧道写阻塞超过 30 s | close 1013；机器 offline/degraded |
| 认证失败（升级前） | HTTP 401，不升级 |
| hello 认证/版本失败 | accepted:false + close 4002/4403 |
| 重复 reverse 连接 | 旧连接 close 4001 |
| 子进程退出 | offline；按策略重启 |

- 关闭码表见 `server/shared/src/protocol.ts` 的 `WS_CLOSE_CODES`。
- 任何协议错误都必须记录对端 role、machineId、帧 kind/id（不含 body/base64）。

## 12. 版本协商与兼容

- hello 的 `v` 在 schema 中是 `number`（不是 literal），以便 transport 读到 v2 后回复 `accepted:false` + close `4002`；transport 校验 `v===1`，不等则拒绝。
- `worker.protocolVersion` 与 hello.v 一致；`apiVersion` 独立。
- 新增可选字段不需要升版本；未知字段被 zod strip。
- 新增帧 kind 属于破坏性变更（旧端不认识）→ 必须升 `v`。新增 `phase` 子形状也按破坏性处理，或先通过 `protocol` 能力位协商（v1 不预留，直接升 v2）。
- core 在升级窗口可同时接受 v1/v2 时，按连接维度协商；v1 不支持则拒绝。
- worker/core 的版本显示在 `/system/info`、`Machine.worker`；UI 对 `protocolVersion` 不匹配给明确提示。

## 13. 安全注意事项

1. **隧道不是加密层**：stdio 依赖本机管道；reverse-ws 必须 TLS。帧内容（含文件、终端输出、handoff 密码）在隧道内是明文 base64/JSON。
2. **连接认证 ≠ 请求授权**：reverse-ws 的 secret 只证明机器身份；worker loopback 仍用 token 执行 API 认证。core 不得在帧里携带用户密码/token。
3. **路径约束**：worker 只允许 loopback 的 `/api/v1/*` 与已注册 `/ws/*`；`http-request.url` 在 zod 和 bridge 两处都必须拒绝绝对 URL、`//host`、反斜杠、控制字符，避免 `new URL(frame.url, loopback)` 被绝对 URL 覆盖目标主机。
4. **帧上限**：16 MiB 帧、512 KiB chunk、4 MiB WS 消息；先检查长度再 JSON.parse，防止内存炸弹。
5. **id 不可预测**：仅用于关联，不用于权限；不要根据 id 复用已关闭流。
6. **日志**：帧的 `headers`、`bodyBase64`、`ws-frame.data` 不落日志；只记录 kind/id/长度/状态。
7. **背压**：任何一端不得无限缓冲；超过阈值 close 1013。
8. **stdio stdout 污染**是严重安全问题：把日志写进 stdout 会破坏帧同步并可能注入伪造响应；check 脚本必须 grep `console.log`/`process.stdout.write` 在 worker 非帧路径的使用。

## 14. 示例

### 14.1 HTTP 请求（stdio）

```
{"kind":"http-request","id":"h-1","method":"GET","url":"/api/v1/system/info","headers":{"accept":"application/json"}}
{"kind":"http-response","id":"h-1","status":200,"headers":{"content-type":"application/json"},"bodyBase64":"eyJvayI6dHJ1ZS..."}
```

### 14.2 流式下载

```
{"kind":"http-request","id":"h-2","method":"GET","url":"/api/v1/files/download?root=files&path=/big.iso","headers":{}}
{"kind":"http-response","id":"h-2","status":200,"headers":{"content-type":"application/octet-stream","content-length":"1073741824"},"stream":true}
{"kind":"http-response","id":"h-2","phase":"chunk","seq":0,"chunkBase64":"..."}
{"kind":"http-response","id":"h-2","phase":"chunk","seq":1,"chunkBase64":"...","final":true}
```

### 14.3 终端 WS

```
{"kind":"ws-open","id":"w-1","path":"/ws/terminal/term_1","headers":{},"protocols":[]}
{"kind":"ws-open","id":"w-1","accepted":true}
{"kind":"ws-frame","id":"w-1","data":"{\"type\":\"ready\",\"session\":{...}}","dataEncoding":"utf8","seq":0}
{"kind":"ws-frame","id":"w-1","data":"{\"type\":\"input\",\"data\":\"ls\\r\"}","dataEncoding":"utf8","seq":0}
{"kind":"ws-frame","id":"w-1","data":"{\"type\":\"output\",\"data\":\"file.txt\\r\\n\"}","dataEncoding":"utf8","seq":1}
{"kind":"ws-close","id":"w-1","code":1000,"reason":"client closed","initiator":"core"}
```

### 14.4 reverse-ws 注册

```
GET /ws/worker HTTP/1.1
Host: core.example.com
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Key: ...
Sec-WebSocket-Version: 13
Sec-WebSocket-Protocol: mpanel.tunnel.v1
Authorization: Bearer mp_...

HTTP/1.1 101 Switching Protocols
Upgrade: websocket
Connection: Upgrade
Sec-WebSocket-Accept: ...
Sec-WebSocket-Protocol: mpanel.tunnel.v1

{"kind":"hello","v":1,"role":"worker","machineId":"m_1","worker":{"name":"mpanel-worker","version":"0.1.0","apiVersion":1,"protocolVersion":1,"nodeVersion":"24.21.0","platform":"linux","arch":"x64"},"protocol":{"maxFrameBytes":16777216,"chunkBytes":524288},"sentAt":"2026-11-25T08:30:00.000Z"}
{"kind":"hello","v":1,"role":"core","machineId":"m_1","accepted":true,"core":{"name":"mpanel-core","version":"0.1.0","apiVersion":1,"protocolVersion":1},"protocol":{"maxFrameBytes":16777216,"chunkBytes":524288}}
```

### 14.5 心跳

```
{"kind":"ping","id":"p-42","ts":1764059400000}
{"kind":"pong","id":"p-42","ts":1764059400000}
```

## 15. 帧上限速查

| 常量 | 值 |
|---|---:|
| `TUNNEL_PROTOCOL_VERSION` | 1 |
| `TUNNEL_MAX_FRAME_BYTES` | 16 MiB |
| `TUNNEL_CHUNK_BYTES` | 512 KiB |
| `WS_MAX_MESSAGE_BYTES` | 4 MiB |
| `TUNNEL_HEARTBEAT_INTERVAL_MS` | 10 000 |
| `TUNNEL_HEARTBEAT_TIMEOUT_MS` | 30 000 |
| `TUNNEL_REQUEST_TIMEOUT_MS` | 120 000 |
| `TUNNEL_MAX_INFLIGHT_REQUESTS` | 128 |
| `TUNNEL_MAX_WS_STREAMS` | 64 |
