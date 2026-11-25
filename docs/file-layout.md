# 文件布局、所有权与导出契约

状态：冻结（2026-11-25）。13 条实现轨道按本文件逐行执行。**每个实现文件只能有一个 owner；页面目录不得重叠。** 修改任何路径/签名必须先改本文件并获得架构轨道同意。

**文档优先级**：`docs/api-contract.md` > `docs/protocol.md` > `docs/file-layout.md` > `docs/architecture.md`；shared 实现 API/protocol 类型。冲突时低优先级让位，并同步修正。

## 0. Owner 名单与 13/16 的裁决

任务原文说“正好 13 个 owner”，随后枚举了 **16** 个名称。本契约以枚举的 16 个名称为准，并作如下解释：

- **13 条实现轨道** = 16 − {`架构`, `脚手架`, `集成`}（这三个是横切/收口轨道）。
- 13 条实现轨道：`worker 核心`、`worker 站点`、`worker 容器`、`worker 数据`、`worker 文件`、`worker 终端与任务`、`core 主机与代理`、`core 认证与网关`、`前端外壳`、`前端数据库页`、`前端容器页`、`前端文件页`、`前端终端与任务页`。
- 16 个 owner 全部使用，不新增、不改名、不合并。

### 0.1 v0.2 追加的两个 owner（边缘节点）

v0.2 增加边缘节点与概览页，属于新增功能范围，按同样规则**追加**两个 owner，既有 16 个不变：

- **边缘节点后端**：`server/core/src/edge/**`、`server/worker/src/edge/**`、`server/worker/src/modules/system/**`，以及 shared 的 EdgeKey/EdgeJob/SystemSnapshot 增量与 `machines/**` 的字段/快照改动。
- **边缘节点与概览前端**：`web/src/pages/edge/**`、`web/src/pages/dashboard/**`、`web/src/api/edge.ts`，以及 `web/src/api/{system,types}.ts` 的边缘增量。

`scripts/check.mjs` 的 OWNERS 名单同步为 18 个。

**前端站点/证书页没有独立 owner**：枚举中没有该前端轨道。为避免新增 owner，`web/src/pages/sites/`、`web/src/pages/certs/`、machines、settings、login 归 **前端外壳**（v0.2 起 `dashboard` 改归 **边缘节点与概览前端**）；worker 侧站点/证书归 **worker 站点**。这是唯一不重叠的分配。

`web/src/api/types.ts` 是手写契约镜像，owner 固定为 **前端外壳**；页面轨道只 import，不修改。`server/shared` 只被 core/worker 引用，web 禁止 import。

<!-- OWNERSHIP_TABLE_START -->

## 1. 所有权总表（每行一个文件）

> 格式：`| 路径 | owner | 必须导出的接口/约定 |`。`scripts/check.mjs` 解析本表：路径必须存在、owner 必须是 §0 的 18 个之一（v0.2 追加两个，见 §0.1）、路径不得重复。以 `—` 开头的导出表示非代码文件。

### 1.1 根与构建（非实现代码也列全）

| 路径 | owner | 必须导出/约定 |
|---|---|---|
| `package.json` | 脚手架 | `private:true`、`engines.node>=24`、`packageManager:"pnpm@12.10.1"`；scripts：`dev`、`build`、`build:shared`、`typecheck`、`check`、`smoke`、`start:worker`、`start:core`、`clean`（见 §6） |
| `pnpm-workspace.yaml` | 脚手架 | `packages: [server/shared, server/worker, server/core, web]`；`onlyBuiltDependencies: [esbuild, node-pty]` |
| `tsconfig.base.json` | 脚手架 | strict、ES2022、NodeNext、declaration、sourceMap、skipLibCheck；供 worker/core 继承 |
| `pnpm-lock.yaml` | 脚手架 | —（生成文件，不手改） |
| `.npmrc` | 脚手架 | `auto-install-peers=true`、`strict-peer-dependencies=false` |
| `.gitignore` | 脚手架 | 忽略 `node_modules/`、`dist/`、`*.tsbuildinfo`、`.env`、`MPANEL_HOME` 测试目录 |
| `.editorconfig` | 脚手架 | — |
| `README.md` | 脚手架 | 快速开始、三端启动、`pnpm check/smoke`、指向 docs |
| `web/package.json` | 脚手架 | React 18.3.1、Vite 6.4.x、Tailwind 3.4.x；scripts `dev/build/typecheck/clean` |
| `web/tsconfig.json` | 脚手架 | bundler resolution、jsx react-jsx、strict；include `src`、`vite.config.ts` |
| `web/vite.config.ts` | 脚手架 | `export default defineConfig(...)`；`base: process.env.VITE_BASE_PATH ?? '/'`（子路径部署可配）、react 插件、`server.port=5173` |
| `web/tailwind.config.ts` | 脚手架 | `export default { content:['./index.html','./src/**/*.{ts,tsx}'], darkMode:'class', ... }` |
| `web/postcss.config.js` | 脚手架 | tailwindcss + autoprefixer |
| `web/index.html` | 脚手架 | `#root`、`/src/main.tsx` |
| `web/public/config.json` | 脚手架 | 默认 `{ "appName":"MPanel", "allowUserConnections":true }`；不得含 token/密码 |
| `server/shared/package.json` | 架构 | `@mpanel/shared`，`type:module`，exports 子路径，依赖仅 `zod`，dev `typescript` |
| `server/shared/tsconfig.json` | 架构 | strict、ES2022、NodeNext、declaration、rootDir src、outDir dist |
| `server/worker/package.json` | 脚手架 | `@mpanel/worker`，依赖见 §7；`node-pty` 在 optionalDependencies |
| `server/worker/tsconfig.json` | 脚手架 | extends `../../tsconfig.base.json`；outDir dist、rootDir src、types node |
| `server/core/package.json` | 脚手架 | `@mpanel/core`，依赖见 §7 |
| `server/core/tsconfig.json` | 脚手架 | 同 worker，types node |

### 1.2 `server/shared/src`（owner：架构）

| 路径 | owner | 必须导出 |
|---|---|---|
| `server/shared/src/errors.ts` | 架构 | `ERROR_CODES`, `ErrorCode`, `ERROR_HTTP_STATUS`, `errorCodeSchema`, `apiErrorBodySchema`, `ApiErrorBody`, `ApiSuccess<T>`, `ApiFailure`, `ApiEnvelope<T>`, `apiEnvelopeSchema<T>()`, `okEnvelope()`, `errorEnvelope()`, `PanelError`, `isPanelError()`, `badRequest()`, `unavailable()`；UNAVAILABLE 在 schema/构造/errorEnvelope 三层都强制 `details.hint` |
| `server/shared/src/protocol.ts` | 架构 | `TUNNEL_PROTOCOL_VERSION`, `TUNNEL_SUBPROTOCOL`, `TUNNEL_MAX_FRAME_BYTES`, `TUNNEL_CHUNK_BYTES`, `TUNNEL_HEARTBEAT_INTERVAL_MS`, `TUNNEL_HEARTBEAT_TIMEOUT_MS`, `TUNNEL_REQUEST_TIMEOUT_MS`, `TUNNEL_MAX_INFLIGHT_REQUESTS`, `TUNNEL_MAX_WS_STREAMS`, `WS_MAX_MESSAGE_BYTES`, `WS_CLOSE_CODES`, `WS_CLOSE_CODES` 值类型，`TUNNEL_FRAME_KINDS`, `TunnelFrameKind`, `tunnelHeaderValueSchema`, `tunnelHeadersSchema`, `TunnelHeaders`, `workerDescriptorSchema`, `WorkerDescriptor`, `ProtocolLimits`, `helloFrameSchema`, `pingFrameSchema`, `pongFrameSchema`, `httpRequestHeadFrameSchema`, `httpRequestChunkFrameSchema`, `httpRequestCancelFrameSchema`, `httpResponseHeadFrameSchema`, `httpResponseChunkFrameSchema`, `wsOpenRequestFrameSchema`, `wsOpenReplyFrameSchema`, `wsOpenFrameSchema`（union）, `wsFrameSchema`, `wsCloseFrameSchema`, `tunnelFrameSchema`, `TunnelFrame` 及每个帧的类型（`HelloFrame`…`WsCloseFrame`、`HttpRequestFrame`、`HttpResponseFrame`、`WsOpenRequestFrame`、`WsOpenReplyFrame`）、`encodeTunnelFrame()`, `decodeTunnelFrame()`, `isTunnelFrame()`, `isHttpRequestHead()`, `isHttpResponseHead()`, `utf8ByteLength()`, `base64DecodedByteLength()`；hello.v 为整数（transport 校验 v===1），ws-frame 强制 4 MiB、http url 仅 origin-form、ws 路径/header 拒绝控制字符 |
| `server/shared/src/capabilities.ts` | 架构 | `CAPABILITY_NAMES`, `CapabilityName`, `capabilityStatusSchema`, `CapabilityStatus`, `capabilitiesSchema`, `Capabilities`, `availableCapability()`, `unavailableCapability()`, `allCapabilitiesUnavailable()`, `isCapabilityAvailable()`, `CapabilityProvider { get(force?); snapshot() }` |
| `server/shared/src/command.ts` | 架构 | `CommandOptions`（含显式 env 与 inheritEnv）, `CommandResult`, `CommandStream`, `CommandRunner`, `ShellRunOptions`, `ShellRunner` |
| `server/shared/src/module.ts` | 架构 | `ModuleLogger`, `ModuleRegistration<TApp,TContext>`（`prefixes: readonly string[]`，多前缀）, `ModuleContext<TApp>`（`capabilities: CapabilityProvider`） |
| `server/shared/src/ws-bridge.ts` | 架构 | `WsOpenRequest`（`path`+`rawQuery`+`query`+`params`）, `WsSink`（`waitForDrain?`）, `WsConnection`, `WsHandler`, `WsBridge`（`open` 抛 PanelError）, `matchWsPath()`, `wsCloseCodeForError()`, `wsHttpStatusForError()` |
| `server/shared/src/secrets.ts` | 架构 | `SecretCipher { encrypt(plain): string; decrypt(payload): string }`、`SECRET_CIPHER_VERSION`；core/worker 共用此类型，不互相 import |
| `server/shared/src/schemas.ts` | 架构 | 全部 zod schema：`isoDateTimeSchema`、`pageQuerySchema`、`listResultSchema()`、`systemInfoSchema`、`systemOverviewSchema`、`siteDomainSchema`、`hostPathSchema`、`absoluteHostPathSchema`、`virtualFilePathSchema`（`filePathSchema` alias）、`caddyUpstreamSchema`、`caddyHealthUriSchema`、`caddyTokenTextSchema`、`siteConfigSchema`、`siteSchema`、`siteCreateSchema`、`siteUpdateSchema`、`sitePreviewRequestSchema`、`siteApplyRequestSchema`、`siteApplyResultSchema`、`siteExportBundleSchema`、`siteImportRequestSchema`、`certificateSchema`、`databaseProfileSchema`、`databaseProfileCreateSchema`、`databaseProfileUpdateSchema`、`databaseStatsSchema`、`backupRequestSchema`、`backupRecordSchema`、`restoreRequestSchema`、`databaseJobSchema`、`containerSummarySchema`、`containerDetailSchema`、`containerStatsSchema`、`execRequestSchema`、`imageSummarySchema`、`stackSummarySchema`、`stackDetailSchema`、`fileItemSchema`、`fileWriteRequestSchema`、`trashEntrySchema`、`terminalSessionSchema`、`terminalClientMessageSchema`、`terminalServerMessageSchema`、`taskSchema`、`taskCreateSchema`、`taskUpdateSchema`、`taskRunSchema`、`machineSchema`、`machineCreateSchema`、`machineCreateResultSchema`、`machineEnrollmentSchema`、`machineHealthSchema`、`handoffRedeemRequestSchema`、`wsTicketRequestSchema`、`wsTicketSchema`、`loginRequestSchema`、`authUserSchema`、`authMeSchema` 等（完整列表以文件为准） |
| `server/shared/src/models.ts` | 架构 | 从 schemas 推导的全部领域类型：`SystemInfo`、`SystemOverview`、`Machine`、`MachineCreateInput`、`MachineCreateResult`、`MachineEnrollment`、`Site`、`SiteConfig`、`SitePreviewResult`、`SiteApplyResult`、`CertificateInfo`、`DatabaseProfile`、`DatabaseStats`、`BackupRecord`、`DatabaseJob`、`ContainerSummary`、`ContainerDetail`、`ContainerStats`、`ImageSummary`、`StackSummary`、`StackDetail`、`FileRoot`、`FileItem`、`FileReadResult`、`Task`、`TaskRun`、`TerminalSession`、`AuthUser`、`WsTicket`、`HandoffRedeemRequest`、`MachineDesiredState`、`ListResult<T>`、`PageQuery` 等 |
| `server/shared/src/index.ts` | 架构 | `export *` 上述模块（含 secrets；不含任何 Node/DOM 依赖，运行时仅 zod） |

### 1.3 `server/worker/src`（核心与模块）

| 路径 | owner | 必须导出 |
|---|---|---|
| `server/worker/src/index.ts` | worker 核心 | `main(argv?: readonly string[]): Promise<void>`；CLI：`serve`（默认）、`token generate [--length N]`、`--version`、`--help`；`main` 处理 SIGINT/SIGTERM、启动传输、stdio 模式 stdout 仅帧 |
| `server/worker/src/config.ts` | worker 核心 | `interface WorkerConfig`（见 §4.1）、`loadWorkerConfig(env?: NodeJS.ProcessEnv, argv?: readonly string[]): WorkerConfig`、`defaultHomeDir(): string` |
| `server/worker/src/logger.ts` | worker 核心 | `interface WorkerLogger extends ModuleLogger { child(bindings: Record<string,unknown>): WorkerLogger }`、`createLogger(level: string, opts: { stderrOnly: boolean; file?: string }): WorkerLogger`、`redact(value: unknown): unknown` |
| `server/worker/src/http.ts` | worker 核心 | `interface WorkerApp { app: FastifyInstance; wsBridge: WsBridge; auth: WorkerAuth; capabilities: CapabilityService; modules: WorkerModule[]; close(): Promise<void> }`、`createWorkerApp(config: WorkerConfig, logger: WorkerLogger): Promise<WorkerApp>`；注册 CORS、统一错误映射（413/415→BAD_REQUEST、404→NOT_FOUND）、body 限制（全局 JSON 8 MiB，`/files/write` 20 MiB，multipart 100 MiB）、**仅 /api/v1 子作用域**的鉴权 hook（精确放行 POST handoff redeem）、模块、独立 WS gateway；模块通过 CapabilityProvider 请求时解析能力 |
| `server/worker/src/auth.ts` | worker 核心 | `interface WorkerAuth { authenticate(req): Promise<void>; issueWsTicket(req, path): WsTicket; consumeWsTicket(ticket, path): boolean; registerRoutes(app): Promise<void> }`、`createWorkerAuth(config, tickets): WorkerAuth`、`class TicketStore { issue(path, subject, ttlSec?): {ticket,expiresAt}; consume(ticket, normalizedPath): boolean; sweep(): void }`、`verifyStaticToken(expected, header): boolean`；ticket 绑定比较剔除 ticket/token、业务 query 排序 |
| `server/worker/src/registry.ts` | worker 核心 | `type WorkerModuleContext = ModuleContext<FastifyInstance> & { config; store: StoreFactory; paths; runner: CommandRunner & ShellRunner; wsBridge; auth }`（inherits `capabilities: CapabilityProvider`）、`type WorkerModule = ModuleRegistration<FastifyInstance, WorkerModuleContext>`、`createModuleRegistry(modules: WorkerModule[]): ModuleRegistry`、`class ModuleRegistry { registerAll(ctx): Promise<void>; list(): readonly WorkerModule[] }`；在单个 `/api/v1` 作用域挂载，模块用 `prefixes` 声明多前缀（containers 为 `/containers,/images,/stacks`） |
| `server/worker/src/modules/index.ts` | worker 核心 | `createWorkerModules(): WorkerModule[]`（按 sites/certs/databases/containers/files/terminal/tasks 顺序；其他轨道只改各自模块，不改本文件） |
| `server/worker/src/util.ts` | worker 核心 | `listResult<T>(items: T[], extra?: Partial<ListResult<T>>): ListResult<T>`、`unavailableList<T>(reason: string): ListResult<T>`、`parsePage(q: {limit?: unknown; cursor?: unknown}): { limit: number; cursor?: string }`、`isTruthyQuery(value: unknown): boolean`、`assertCapability(caps: CapabilityProvider, name: CapabilityName): Promise<void>`（请求时 `await caps.get()`；不可用抛 `PanelError('UNAVAILABLE', ..., {hint})`；`requires` 仅 advisory）、`toIso(value: Date \| number): string` |
| `server/worker/src/capabilities.ts` | worker 核心 | `interface CapabilityService extends CapabilityProvider { get(force?: boolean): Promise<Capabilities>; snapshot(): Capabilities; invalidate(): void }`、`createCapabilityService(config, runner, logger): CapabilityService`；30s 缓存，写前可 force、`probeCaddy()`, `probeDocker()`, `probePostgres()`, `probeRedis()`, `probePty()`（各自返回 `Promise<CapabilityStatus>`） |
| `server/worker/src/exec.ts` | worker 核心 | `createCommandRunner(logger, opts?: { defaultTimeoutMs?: number; maxBufferBytes?: number; baseEnv?: Record<string,string> }): CommandRunner & ShellRunner`、`killProcessTree(child: ChildProcess): Promise<void>`；实现只能用 `spawn`/`execFile` argv 数组；默认 env 仅 PATH/HOME/TMP/TZ 等 allowlist，绝不继承 MPANEL_*（调用方显式传密码 env） |
| `server/worker/src/paths.ts` | worker 核心 | `interface PathSandbox { readonly roots: FileRoot[]; resolve(root, virtualPath, opts?: { forWrite?: boolean; allowMissing?: boolean }): Promise<string>; relative(root, absPath): string; validateSiteRoot(absPath, opts?): Promise<string> }`、`createPathSandbox(config, logger): Promise<PathSandbox>`、`normalizeVirtualPath(input: string): string` |
| `server/worker/src/store.ts` | worker 核心 | `interface JsonStore<T> { read(): Promise<T>; write(value:T): Promise<void>; update(mutator:(draft:T)=>T \| void): Promise<T> }`、`createJsonStore<T>(filePath: string, defaults: T): JsonStore<T>`、`readJsonFile<T>()`, `writeFileAtomic()`, `readJsonlTail<T>()`, `appendJsonl()`, `acquireStateLock(homeDir, role: 'worker'): Promise<() => Promise<void>>`（锁文件 `state/.worker.lock`）、`interface StoreFactory { json<T>(name, defaults): JsonStore<T>; appendJsonl(name, record): Promise<void>; readJsonlTail<T>(name, limit): Promise<T[]>; newId(prefix): string }`、`createStoreFactory(homeDir): StoreFactory`、`newId(prefix: string): string` |
| `server/worker/src/ws.ts` | worker 核心 | `createWsBridge(logger): WsBridge`、`registerWsGateway(app: FastifyInstance, bridge: WsBridge, auth: WorkerAuth, logger: WorkerLogger): Promise<void>`；gateway 负责 `Authorization: Bearer <MPANEL_TOKEN>` / `?token=` / `?ticket=` 三类认证、pathname+rawQuery 拆分、`bufferedBytes`/`waitForDrain`、关闭码；`PanelError`→4401/4403/4404/4502/1011 |
| `server/worker/src/transports/types.ts` | worker 核心 | `interface WorkerTransport { readonly kind: 'http'\|'stdio'\|'reverse-ws'; start(): Promise<void>; stop(): Promise<void> }`、`interface WorkerTransportDeps { config; app: FastifyInstance; logger }`；传输在 `listen(127.0.0.1:0)` 后创建 TunnelBridge |
| `server/worker/src/transports/ndjson.ts` | worker 核心 | `class NdjsonReader { push(chunk: Buffer): string[]; end(): string[] }`、`encodeNdjson(frame: TunnelFrame): string`、`writeNdjson(stream: NodeJS.WritableStream, frame: TunnelFrame): Promise<void>` |
| `server/worker/src/transports/tunnel-bridge.ts` | worker 核心 | `class TunnelBridge { constructor(deps: { token; logger; host; port }); handleFrame(frame: TunnelFrame, send: (frame:TunnelFrame)=>void): Promise<void>; closeAll(): void }`；只处理 `http-request`/`ws-open`/`ws-frame`/`ws-close`，`hello`/`ping`/`pong` 由 stdio/reverse 传输层处理；只通过 loopback 的 `fetch`/`ws` + token 访问，不直接调用 WsBridge 绕过鉴权 |
| `server/worker/src/transports/http.ts` | worker 核心 | `createHttpTransport(deps: WorkerTransportDeps): WorkerTransport`；`start` 调用 `app.listen({host,port})`，在 stdout 打印 `{"event":"listening","host":...,"port":...}` 供 smoke 发现端口 |
| `server/worker/src/transports/stdio.ts` | worker 核心 | `createStdioTransport(deps: WorkerTransportDeps): WorkerTransport`；`start` 先 listen `127.0.0.1:0` 并取得实际端口→创建 TunnelBridge→读 stdin NDJSON、写 stdout、stderr 日志、hello 握手；同时导出 `createStdioChannel` |
| `server/worker/src/transports/reverse-ws.ts` | worker 核心 | `createReverseWsTransport(deps: WorkerTransportDeps): WorkerTransport`；`start` 也先 listen `127.0.0.1:0`（绝不公网）并创建 TunnelBridge；再用 `ws` 拨号 core `/ws/worker`（Bearer secret 优先，query secret 默认关闭），子协议/hello/心跳/指数退避；导出 `createReverseWsChannel` |
| `server/worker/src/modules/sites/index.ts` | worker 站点 | `createSitesModule(): WorkerModule`；`prefixes: ['/sites']` |
| `server/worker/src/modules/sites/store.ts` | worker 站点 | `interface SiteStore { list(): Promise<Site[]>; get(id): Promise<Site\|undefined>; create(input: SiteCreateInput): Promise<Site>; update(id, input: SiteUpdateInput): Promise<Site>; remove(id): Promise<void>; exportBundle(): Promise<SiteExportBundle>; importBundle(bundle, mode): Promise<SiteImportResult>; markApplied(ids, applyRevision, at): Promise<void> /* appliedRevision = 各站点当前 revision */; markApplyError(ids, at, error): Promise<void> }`、`createSiteStore(file: string): SiteStore` |
| `server/worker/src/modules/sites/caddyfile.ts` | worker 站点 | `renderSite(site: Site): string`、`renderSiteConfig(config: SiteConfig): string`、`renderRootConfig(sites: Site[], opts: { adminAddress?: string }): string`、`quoteCaddyToken(value: string): string`（拒绝所有控制字符；preview/apply 必调用）、`siteWarnings(site: Site, all: Site[]): string[]`、`renderPreview(config: SiteConfig): SitePreviewResult` |
| `server/worker/src/modules/sites/caddy.ts` | worker 站点 | `interface CaddyClient { probe(): Promise<CapabilityStatus>; validate(configPath: string): Promise<CommandResult>; reload(configPath: string): Promise<CommandResult> }`、`createCaddyClient(config, runner): CaddyClient` |
| `server/worker/src/modules/sites/apply.ts` | worker 站点 | `interface SiteApplyService { preview(req: SitePreviewRequest): Promise<SitePreviewResult>; apply(req: SiteApplyRequest): Promise<SiteApplyResult> }`（siteIds 省略=全量渲染并清理；给定=选中站点用草稿、未选中复用现有 sites.d 片段）、`createSiteApplyService(deps: { config; store; caddy; runner; logger }): SiteApplyService`；实现 staging→validate→backup→swap→reload→rollback |
| `server/worker/src/modules/certs/index.ts` | worker 站点 | `createCertsModule(): WorkerModule`；`prefixes: ['/certs']` |
| `server/worker/src/modules/certs/scan.ts` | worker 站点 | `scanCertificates(dataDir: string, logger: WorkerLogger): Promise<{ available: boolean; reason?: string; items: CertificateInfo[] }>`、`parseCertificateFile(path: string): Promise<CertificateInfo \| null>` |
| `server/worker/src/modules/databases/index.ts` | worker 数据 | `createDatabasesModule(): WorkerModule`；`prefixes: ['/databases']`；redeem 为 `POST /databases/handoff/redeem`（body `{ticket}`） |
| `server/worker/src/modules/databases/store.ts` | worker 数据 | `interface DatabaseStore { listProfiles(); getProfile(); createProfile(); updateProfile(); deleteProfile(); listBackups(profileId); getBackup(id); createBackup(record); updateBackup(id, patch); deleteBackup(id); listJobs(profileId?); createJob(job); updateJob(id, patch); getJob(id) }`、`createDatabaseStore(file, cipher): DatabaseStore` |
| `server/worker/src/modules/databases/secrets.ts` | worker 数据 | `import type { SecretCipher } from '@mpanel/shared'`、`createSecretCipher(key: Buffer): SecretCipher`（AES-256-GCM，格式 `v1:iv:tag:ciphertext`）、`loadOrCreateSecretKey(homeDir, envKey?): Buffer`（`open(...,'wx',0o600)` + EEXIST 读取，避免与 core 同 home 竞态） |
| `server/worker/src/modules/databases/postgres.ts` | worker 数据 | `interface PostgresDriver { test(profile, password): Promise<DatabaseTestResult>; stats(profile, password): Promise<PostgresStats>; backup(profile, password, opts): Promise<{ filePath; sizeBytes }>; restore(profile, password, backup): Promise<void> }`、`createPostgresDriver(config, runner, logger): PostgresDriver` |
| `server/worker/src/modules/databases/redis.ts` | worker 数据 | `interface RedisDriver { test(); stats(); backupLogical(); restoreLogical(); backupRdb() }`、`createRedisDriver(config, runner, logger): RedisDriver`；`logical` 用 ioredis，`rdb` 用 redis-cli |
| `server/worker/src/modules/databases/jobs.ts` | worker 数据 | `interface DatabaseJobService { startBackup(profileId, body): Promise<DatabaseJob>; startRestore(profileId, body): Promise<DatabaseJob>; getJob(id): Promise<DatabaseJob\|undefined>; listJobs(q): Promise<ListResult<DatabaseJob>>; cancel(profileId): void }`、`createDatabaseJobService(deps): DatabaseJobService` |
| `server/worker/src/modules/databases/handoff.ts` | worker 数据 | `interface HandoffService { issue(profileId, ttlSec?): Promise<HandoffTicket>; redeem(ticket): Promise<HandoffPayload> }`、`createHandoffService(deps: { store; cipher; publicUrl?; rateLimit }): HandoffService`；redeem 只从 body 取 ticket，内存一次性票据，限速默认 10/min |
| `server/worker/src/modules/databases/profiles.ts` | worker 数据 | `interface ProfileService { list(q); get(id); create(input); update(id, input); remove(id); test(id); stats(id) }`、`createProfileService(deps): ProfileService` |
| `server/worker/src/modules/databases/exec.ts` | worker 数据 | `runCommand`, `runStreamingCommand`, `requireTool`, `commandFailure`, `tailText`, `scrubSecret`, `describeError`, `isErrno`；经注入的 CommandRunner 以 argv 数组执行，输出截断并脱敏 |
| `server/worker/src/modules/databases/paging.ts` | worker 数据 | `readPage(q: PageQuery): PageParams`、`pageSlice<T>(items, q): ListResult<T>` |
| `server/worker/src/modules/containers/index.ts` | worker 容器 | `createContainersModule(): WorkerModule`；`prefixes: ['/containers','/images','/stacks']`（同一注册内注册全部绝对路径） |
| `server/worker/src/modules/containers/docker.ts` | worker 容器 | `interface DockerClient { probe(); listContainers(q); inspect(id); start(id); stop(id, timeout?); restart(id, timeout?); remove(id, opts); logs(id, opts): AsyncIterable<{stream,data,ts?}>; stats(id); exec(id, req); listImages(q); pull(ref); removeImage(id, force); pruneImages(opts); composeLs(); composeUp(name, opts); composeDown(name, opts); composeRestart(name); composeConfig(yamlPath) }`、`createDockerClient(config, runner, logger): DockerClient` |
| `server/worker/src/modules/containers/containers.ts` | worker 容器 | `interface ContainerService { list(q); get(id); action(id, action, opts); logs(id, q); stats(id); exec(id, req) }`、`createContainerService(docker): ContainerService` |
| `server/worker/src/modules/containers/images.ts` | worker 容器 | `interface ImageService { list(q); pull(reference); remove(id, force); prune(opts) }`、`createImageService(docker): ImageService` |
| `server/worker/src/modules/containers/stacks.ts` | worker 容器 | `interface StackService { list(); get(name); create(input); update(name, input); up(name, opts); down(name, opts); restart(name); remove(name, force?) }`、`createStackService(docker, config): StackService` |
| `server/worker/src/modules/containers/logs.ts` | worker 容器 | `registerContainerLogsWs(bridge: WsBridge, service: ContainerService): void`；路径 `/ws/containers/:id/logs`，JSON 文本消息 |
| `server/worker/src/modules/files/index.ts` | worker 文件 | `createFilesModule(): WorkerModule`；`prefixes: ['/files']`；注册除 `/files/upload` 外的全部端点（upload.ts 是 upload 唯一注册者） |
| `server/worker/src/modules/files/fs.ts` | worker 文件 | `interface FileService { roots(); list(q); stat(q); read(q); write(req); mkdir(req); rename(req); copy(req); chmod(req); delete(q); upload(root, path, filename, stream); download(q); }`、`createFileService(deps: { config; paths; logger }): FileService` |
| `server/worker/src/modules/files/sandbox.ts` | worker 文件 | `interface FileSandbox extends PathSandbox`、`normalizeVirtualPath(input): string`、`fileTypeOf(stats): FileType`、`formatMode(mode)`、`mapFsError(error, action): PanelError`、`MAX_VIRTUAL_PATH_LENGTH`、`MAX_SEGMENT_BYTES`、`LIST_LIMIT_DEFAULT/MAX`；realpath 根内校验，拦截 `..`、NUL、盘符、UNC 与 Windows 保留名 |
| `server/worker/src/modules/files/trash.ts` | worker 文件 | `interface TrashService { move(root, path): Promise<TrashEntry>; list(q); restore(req); empty(req) }`、`createTrashService(config): TrashService` |
| `server/worker/src/modules/files/archive.ts` | worker 文件 | `interface ArchiveService { archive(req): Promise<FileArchiveResult>; extract(req): Promise<FileExtractResult> }`、`createArchiveService(deps): ArchiveService`；tar argv、条目预检 |
| `server/worker/src/modules/files/upload.ts` | worker 文件 | `registerUploadRoute(app, service): Promise<void>`；@fastify/multipart，单文件字段 `file`，临时文件+rename |
| `server/worker/src/modules/files/search.ts` | worker 文件 | `searchFiles(deps, q): Promise<FileSearchResult>`、`createSearchService(deps): { search(q): Promise<FileSearchResult> }` |
| `server/worker/src/modules/terminal/index.ts` | worker 终端与任务 | `createTerminalModule(): WorkerModule`；`prefixes: ['/terminal']` |
| `server/worker/src/modules/terminal/sessions.ts` | worker 终端与任务 | `interface TerminalManager { create(input); list(); get(id); close(id); noteActivity(id); sweep(): void }`、`createTerminalManager(deps): TerminalManager` |
| `server/worker/src/modules/terminal/pty.ts` | worker 终端与任务 | `interface PtyLike { pid; write(data); resize(cols,rows); pause(); resume(); kill(signal?); onData(cb); onExit(cb) }`、`interface FallbackPty extends PtyLike { pause(); resume() }`、`loadPty(): Promise<{ spawn: (...) => PtyLike; version: string } \| null>`、`spawnFallback(shell, args, opts): FallbackPty` |
| `server/worker/src/modules/terminal/ws.ts` | worker 终端与任务 | `registerTerminalWs(bridge: WsBridge, manager: TerminalManager): void`；路径 `/ws/terminal/:sessionId`，JSON 消息 |
| `server/worker/src/modules/tasks/index.ts` | worker 终端与任务 | `createTasksModule(): WorkerModule`；`prefixes: ['/tasks']` |
| `server/worker/src/modules/tasks/store.ts` | worker 终端与任务 | `interface TaskStore { list(q); get(id); create(input); update(id, input); remove(id); listRuns(q); getRun(id); appendRun(run); updateRun(id, patch); trimHistory(taskId) }`、`createTaskStore(file, runsFile): TaskStore` |
| `server/worker/src/modules/tasks/scheduler.ts` | worker 终端与任务 | `interface TaskScheduler { start(): void; stop(): void; refresh(task): void; remove(taskId): void; nextRuns(task, count): string[] }`、`createTaskScheduler(deps): TaskScheduler`（croner，timezone，overlap） |
| `server/worker/src/modules/tasks/runner.ts` | worker 终端与任务 | `runTask(deps, task, triggeredBy): Promise<TaskRun>`、`buildShellArgs(shell, command): { command; args }`、`sanitizeTaskEnv(env): Record<string,string>`；用 `ShellRunner`，kill 进程树 |
| `server/worker/src/modules/tasks/history.ts` | worker 终端与任务 | `interface TaskHistory { append(run); list(taskId?, q); trim(): Promise<void> }`、`createTaskHistory(file): TaskHistory` |

### 1.4 `server/core/src`

| 路径 | owner | 必须导出 |
|---|---|---|
| `server/core/src/index.ts` | core 主机与代理 | `main(argv?: readonly string[]): Promise<void>`；CLI `serve`（默认）、`user add\|passwd\|list\|delete`、`--version`、`--help`；启动时创建 auth/machines/app 并 listen；`port=0` 时 stdout 打印 `{"event":"listening","host":...,"port":...}` 供 smoke 发现 |
| `server/core/src/config.ts` | core 主机与代理 | `interface CoreConfig`（见 §4.2）、`loadCoreConfig(env?: NodeJS.ProcessEnv): CoreConfig`、`defaultCoreHome(): string` |
| `server/core/src/store.ts` | core 主机与代理 | `interface JsonStore<T> { read(): Promise<T>; write(value:T): Promise<void>; update(mutator:(draft:T)=>T\|void): Promise<T> }`、`createJsonStore<T>(filePath: string, defaults: T): JsonStore<T>`、`writeFileAtomic()`、`appendJsonl()`、`readJsonlTail<T>()`、`acquireStateLock(home: string): Promise<() => Promise<void>>`（锁文件 `state/.core.lock`）、`newId(prefix)` |
| `server/core/src/app.ts` | core 认证与网关 | `interface CoreAppDeps { config: CoreConfig; auth: AuthService; machines: MachineService; audit: AuditLog; rateLimit: RateLimiter; logger?: FastifyBaseLogger }`、`buildCoreApp(deps: CoreAppDeps): Promise<FastifyInstance>`；公开路由（healthz/login/static）与受保护 `/api/v1` 分组注册；`/ws/worker` preValidation 用 `authenticateReverseWs`；代理 WS 独立 ticket 校验；注册 CORS/WS/static/system/auth/machines/proxy、统一错误映射 |
| `server/core/src/system.ts` | core 认证与网关 | `registerSystemRoutes(app: FastifyInstance, deps: { config; machines }): Promise<void>`、`buildCoreSystemInfo(config): SystemInfo`、`buildSystemOverview(config, machines, listAll): Promise<SystemOverview>`（overview 用 `listAll`，分页列表用 `list`） |
| `server/core/src/static.ts` | core 认证与网关 | `registerStatic(app: FastifyInstance, config: CoreConfig): Promise<void>`；@fastify/static + SPA fallback，不吞 `/api`、`/ws`、`/healthz`；设置 CSP（`frame-src` 含 dbx 源）、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`；`webDir` 不存在时记录 warning 并只提供 API |
| `server/core/src/audit.ts` | core 认证与网关 | `interface AuditLog { write(event: {at; action; actor; ip?; target?; result; details?}): Promise<void> }`、`createAuditLog(file: string): AuditLog`；handoff 只记录 ticket 哈希前 8 位，不记录 body/URL secret |
| `server/core/src/auth/types.ts` | core 认证与网关 | `interface AuthContext { kind:'session'\|'token'; user: AuthUser }`、`interface AuthService { authenticate(req: FastifyRequest): Promise<AuthContext>; authenticateOrNull(req): Promise<AuthContext\|null>; issueWsTicket(auth, path, machineId?): WsTicket; consumeWsTicket(ticket, path): AuthContext; registerRoutes(app, machines): Promise<void> }` |
| `server/core/src/auth/scrypt.ts` | core 认证与网关 | `hashPassword(password: string): Promise<StoredPassword>`、`verifyPassword(password: string, stored: StoredPassword): Promise<boolean>`、`interface StoredPassword { salt; hash; N; r; p }` |
| `server/core/src/auth/store.ts` | core 认证与网关 | `interface UserStore { list(); findByUsername(name); get(id); create(user); update(id, patch); remove(id) }`、`createUserStore(file): UserStore`、`interface SessionStore { create(userId, ttlSec); get(token); delete(token); deleteForUser(userId); sweep() }`、`createSessionStore(file): SessionStore`；只存 token 的 SHA-256 |
| `server/core/src/auth/sessions.ts` | core 认证与网关 | `createSessionService(config, store): SessionService`、`interface SessionService { issue(user): Promise<{token; expiresAt}>; resolve(token): Promise<AuthContext\|null>; revoke(token): Promise<void>; revokeUser(userId, keepToken?): Promise<void>; cookieHeader(token, expiresAt): string; clearCookieHeader(): string }` |
| `server/core/src/auth/tickets.ts` | core 认证与网关 | `interface TicketStore { issue(input: {auth; path; machineId?; ttlSec?}): WsTicket; consume(ticket, path): AuthContext; sweep(): void }`、`createTicketStore(): TicketStore` |
| `server/core/src/auth/routes.ts` | core 认证与网关 | `registerAuthRoutes(app, deps: { config; sessions; users; tickets; audit; loginLimiter }): Promise<void>`；login/logout/me/ws-ticket/password；login 限速 |
| `server/core/src/auth/index.ts` | core 认证与网关 | `createAuthService(config, logger): Promise<AuthService>`、`runUserCli(argv, config): Promise<number>`；内部创建 login limiter；redeem limiter 由 `buildCoreApp` 从 config 创建并传给代理 |
| `server/core/src/auth/rate-limit.ts` | core 认证与网关 | `interface RateLimiter { hit(key: string): { allowed: boolean; retryAfterSec?: number }; reset(key?): void }`、`createRateLimiter(opts: { windowSec: number; max: number }): RateLimiter`；用于 login 与 handoff redeem |
| `server/core/src/machines/types.ts` | core 主机与代理 | `interface MachineRecord`（内部完整记录，含加密凭据、`desiredState`）、`declare module 'fastify' { interface FastifyRequest { reverseWsMachine?: Machine } }`、`interface MachineHttpRequest { method; path; headers; body: Readable\|null; requestId; remoteAddress?; signal? }`、`interface MachineHttpResponse { status; headers: Record<string,string\|string[]>; body: Readable }`、`interface MachineWsOpenRequest { path; headers; protocols }`、`interface MachineWsConnection { send(data: string\|Uint8Array, binary): void; close(code?,reason?): void; onMessage(cb): void; onClose(cb): void }`、`interface DriverStatus { status; lastSeenAt; latencyMs?; consecutiveFailures; lastError? }` |
| `server/core/src/machines/store.ts` | core 主机与代理 | `interface MachineStore { list(); get(id); create(record); update(id, patch); remove(id); findBySecretHash(hash) }`、`createMachineStore(file): MachineStore` |
| `server/core/src/machines/credentials.ts` | core 主机与代理 | `import type { SecretCipher } from '@mpanel/shared'`、`createCredentialCipher(homeDir, envKey?): SecretCipher`（AES-256-GCM，独立实现）、`hashMachineSecret(secret): string`、`generateMachineSecret(): string`；key 用 `open(...,'wx',0o600)` 原子创建 |
| `server/core/src/machines/service.ts` | core 主机与代理 | `interface MachineService`（**网关轨道直接 import 此接口**，见 §5.1；`list` 返回分页 `ListResult<Machine>`，另提供 `listAll`）、`createMachineService(config, logger): Promise<MachineService>` |
| `server/core/src/machines/routes.ts` | core 主机与代理 | `registerMachineRoutes(app, deps: { machines; auth; config; audit; rateLimit? }): Promise<void>`；`/machines*`，写操作写 audit |
| `server/core/src/machines/health.ts` | core 主机与代理 | `interface HealthMonitor { start(): void; stop(): void; check(id): Promise<MachineHealth>; markOnline(id, latency?); markOffline(id, error?) }`、`createHealthMonitor(deps): HealthMonitor` |
| `server/core/src/transports/types.ts` | core 主机与代理 | `interface TransportDriver { readonly kind: MachineTransport; start(machine: MachineRecord): Promise<void>; stop(machineId: string): Promise<void>; request(machineId, req: MachineHttpRequest): Promise<MachineHttpResponse>; openWs(machineId, req: MachineWsOpenRequest): Promise<MachineWsConnection>; status(machineId): DriverStatus; attach?(machineId, socket: import('ws').WebSocket, req: import('node:http').IncomingMessage): Promise<void> }`、`interface TransportDriverDeps { config; credentials; logger }`、`type TransportDriverFactory = (deps) => TransportDriver` |
| `server/core/src/transports/http.ts` | core 主机与代理 | `createHttpTransportDriver(deps: TransportDriverDeps): TransportDriver`；fetch + ws，Bearer worker token |
| `server/core/src/transports/stdio.ts` | core 主机与代理 | `createStdioTransportDriver(deps: TransportDriverDeps): TransportDriver`；spawn、NDJSON、stderr 日志、hello、重连；导出 `createStdioChannel` |
| `server/core/src/transports/reverse-ws.ts` | core 主机与代理 | `createReverseWsTransportDriver(deps: TransportDriverDeps): TransportDriver`；`attach` 接收 app 认证后的连接并创建 `TunnelChannel`，管理 hello/心跳/帧循环；不自行 listen；导出 `createReverseWsChannel` |
| `server/core/src/transports/tunnel.ts` | core 主机与代理 | `interface TunnelChannel { send(frame: TunnelFrame): Promise<void>; close(code?,reason?): void; onFrame(cb); onClose(cb) }`（`send` 等待 drain/背压）、`type TunnelChannelFactory = () => Promise<TunnelChannel>`、`class TunnelTransportDriver implements TransportDriver { attachChannel(machineId, channel): void }`、`createTunnelDriver(kind, deps): TunnelTransportDriver`；请求/WS 多路复用、心跳、pending 表 |
| `server/core/src/transports/ndjson.ts` | core 主机与代理 | `class NdjsonReader { push(chunk: Buffer): string[]; end(): string[] }`、`encodeNdjson(frame): string` |
| `server/core/src/proxy/index.ts` | core 主机与代理 | `registerProxyRoutes(app, deps: { machines; auth; config; audit; rateLimit }): Promise<void>`；代理注册在独立封装插件（catch-all no-op parser、≥110 MiB bodyLimit）；HTTP + WS 路由；仅精确 `POST .../databases/handoff/redeem` 免 session，并限速/审计 |
| `server/core/src/proxy/http.ts` | core 主机与代理 | `proxyHttpHandler(deps): (req, reply) => Promise<void>`、`mapProxyHttpRequest(rawUrl: string): string`（保留原始 query、剥离 core 凭据）；流式转发、头清洗 |
| `server/core/src/proxy/ws.ts` | core 主机与代理 | `proxyWsHandler(deps): (socket, req) => Promise<void>`、`mapProxyWsRequest(rawUrl: string): string`（保留业务原始 query、剔除 ticket/token）；ticket 校验、双向 pump、关闭码 |

### 1.5 `web/src`

| 路径 | owner | 必须导出 |
|---|---|---|
| `web/src/main.tsx` | 前端外壳 | 入口；`loadRuntimeConfig()` 后 `createRoot(...).render(<App />)`；无命名导出 |
| `web/src/routes.tsx` | 前端外壳 | `export const routes: RouteObject[]`；路径见 §6.4；页面 lazy import；`/login`、`*`；BrowserRouter 的 `basename` 取 `import.meta.env.BASE_URL`（去尾斜杠） |
| `web/src/vite-env.d.ts` | 前端外壳 | `/// <reference types="vite/client" />`、`interface ImportMetaEnv { VITE_DEFAULT_BACKEND?; VITE_DEFAULT_BACKEND_KIND?; ... }` |
| `web/src/app/App.tsx` | 前端外壳 | `export default function App(): JSX.Element`；Providers + Router |
| `web/src/app/Providers.tsx` | 前端外壳 | `export function Providers(props: { children: ReactNode }): JSX.Element`；QueryClient/Toast/Theme/ErrorBoundary |
| `web/src/app/AppShell.tsx` | 前端外壳 | `export function AppShell(): JSX.Element`；Sidebar/TopBar/MachineSwitcher/Outlet |
| `web/src/app/ErrorBoundary.tsx` | 前端外壳 | `export class ErrorBoundary extends React.Component<{children}, {error}>` |
| `web/src/app/ConnectionGate.tsx` | 前端外壳 | `export function ConnectionGate(props: { children: ReactNode }): JSX.Element` |
| `web/src/app/LoginGate.tsx` | 前端外壳 | `export function LoginGate(props: { children: ReactNode }): JSX.Element`；core 未登录跳转 |
| `web/src/app/ThemeProvider.tsx` | 前端外壳 | `export function ThemeProvider(...)`、`export function useTheme(): {theme; setTheme}` |
| `web/src/app/MachineGate.tsx` | 前端外壳 | `requiresMachine(pathname): boolean`、`MachineGate(props: { children: ReactNode }): JSX.Element`；core 模式未选机器时提示 |
| `web/src/api/types.ts` | 前端外壳 | 手写镜像：必须包含 API §15 `// TypeName` 列表的每一个 export（`ErrorCode`、`ApiEnvelope`、`ListResult`、`PageQuery`、`Site`、`CertificateInfo`、`DatabaseProfile`、`ContainerSummary`、`FileItem`、`Task`、`TerminalSession`、`Machine`、`SystemInfo`、`ContainerLogsClientMessage`、`ShellInfo`…）；`pnpm check` 逐名校验；**不得 import `@mpanel/shared`** |
| `web/src/api/client.ts` | 前端外壳 | `class ApiError extends Error { readonly code; readonly status; readonly details }`、`apiRequest<T>(path, opts?): Promise<T>`、`apiRaw(path, opts?): Promise<Response>`、`interface ApiRequestOptions { method?; body?; query?; signal?; timeoutMs? }` |
| `web/src/api/transport.ts` | 前端外壳 | `interface ApiTransport`、`ApiRequestOptions`、`QueryValue`、`QueryParams` |
| `web/src/api/current.ts` | 前端外壳 | `setCurrentClientSupplier(fn: () => ApiClient): void`、`currentClient(): ApiClient` |
| `web/src/api/errors.ts` | 前端外壳 | `class AppError extends Error`（`code`/`status`/`details`）、`errorFromStatus(...)`、`describeError(error, fallbackTitle?)`、`isAppError(error, code?)` |
| `web/src/api/ws.ts` | 前端外壳 | `wsPathFor(featurePath: string): string`（worker `/ws`+path、core `/api/v1/machines/<id>/proxy/ws`+path）、`connectWs(featurePath: string, handlers, opts?): Promise<WsSession>`（内部取票+追加 ticket）、`interface WsSession { sendText; close; status }` |
| `web/src/api/auth.ts` | 前端外壳 | `workerMe()`, `coreLogin(input)`, `coreLogout()`, `coreMe()`, `changePassword(input)` |
| `web/src/api/system.ts` | 前端外壳 | `getSystemInfo(refresh?): Promise<SystemInfo>`、`getSystemOverview(): Promise<SystemOverview>` |
| `web/src/api/machines.ts` | 前端外壳 | `listMachines(q)`, `createMachine(input)`, `getMachine(id)`, `updateMachine(id, input)`, `deleteMachine(id)`, `connectMachine(id)`, `disconnectMachine(id)`, `testMachine(id)`, `getMachineHealth(id)`, `rotateMachineSecret(id)` |
| `web/src/api/sites.ts` | 前端外壳 | `listSites(q)`, `createSite(input)`, `getSite(id)`, `updateSite(id,input)`, `deleteSite(id)`, `previewSite(req)`, `applySites(req)`, `exportSites()`, `importSites(req)` |
| `web/src/api/certs.ts` | 前端外壳 | `listCerts(q)`, `getCert(id)` |
| `web/src/api/databases.ts` | 前端数据库页 | `listProfiles(q)`, `createProfile(input)`, `getProfile(id)`, `updateProfile(id,input)`, `deleteProfile(id)`, `testProfile(id)`, `getProfileStats(id)`, `createHandoff(id, ttlSec?)`, `listBackups(profileId,q)`, `createBackup(id,body)`, `restoreBackup(id,body)`, `getJob(id)`, `listJobs(q)`, `deleteBackup(id)`, `backupDownloadUrl(id)` |
| `web/src/api/containers.ts` | 前端容器页 | `listContainers(q)`, `getContainer(id)`, `containerAction(id, action, opts?)`, `removeContainer(id, opts)`, `getContainerLogs(id,q)`, `getContainerStats(id)`, `execContainer(id,req)`, `listImages(q)`, `pullImage(ref)`, `removeImage(id,force?)`, `pruneImages(body)`, `listStacks()`, `getStack(name)`, `createStack(input)`, `updateStack(name,input)`, `stackAction(name, action, body)`, `deleteStack(name,force?)` |
| `web/src/api/files.ts` | 前端文件页 | `listRoots()`, `listFiles(q)`, `statFile(q)`, `readFile(q)`, `writeFile(req)`, `mkdir(req)`, `rename(req)`, `copy(req)`, `chmod(req)`, `deleteFile(q)`, `listTrash(q)`, `restoreTrash(req)`, `emptyTrash(req)`, `uploadFile(root,path,file,overwrite?)`, `downloadFile(q)`, `archiveFiles(req)`, `extractFile(req)`, `searchFiles(q)` |
| `web/src/api/terminal.ts` | 前端终端与任务页 | `listShells()`, `listSessions(q)`, `createSession(input)`, `getSession(id)`, `closeSession(id)` |
| `web/src/api/tasks.ts` | 前端终端与任务页 | `listTasks(q)`, `createTask(input)`, `getTask(id)`, `updateTask(id,input)`, `deleteTask(id)`, `runTask(id)`, `listTaskHistory(id,q)`, `listTaskRuns(q)`, `getNextRuns(id,count?)` |
| `web/src/lib/connection-store.ts` | 前端外壳 | `interface ConnectionState { connections; activeId; selectedMachineByConnection: Record<string,string\|undefined>; add; update; remove; setActive; selectMachine(connectionId, machineId?) }`、`useConnectionStore`（持久化不含 token）、`getActiveConnection()`（内存合并 secret）、`getSelectedMachineId()`、`getBasePath()`、`getWsBasePath()`、`useBasePath()` |
| `web/src/lib/connection-secrets.ts` | 前端外壳 | `useConnectionSecrets`、`getSecret(connectionId)`、`setSecret(connectionId, token, storage: 'session'\|'local')`、`removeSecret(connectionId)`；默认 sessionStorage，localStorage 必须显式 opt-in；绝不并入 `mpanel.connections.v1` |
| `web/src/lib/auth-store.ts` | 前端外壳 | `useAuthStore`、`getAuthState(connectionId)`、`setAuthState(...)`、`clearAuth(connectionId?)` |
| `web/src/lib/runtime-config.ts` | 前端外壳 | `loadRuntimeConfig(): Promise<RuntimeConfig>`、`getRuntimeConfig(): RuntimeConfig`、`mergeRuntimeConfig(configFile, env): RuntimeConfig` |
| `web/src/lib/query-client.ts` | 前端外壳 | `export const queryClient: QueryClient` |
| `web/src/lib/format.ts` | 前端外壳 | `formatBytes(n)`, `formatDate(iso)`, `formatDuration(ms)`, `formatPercent(n)` |
| `web/src/lib/paths.ts` | 前端外壳 | `joinUrl(base, path)`, `toWsUrl(base)`, `resolveRedeemUrl(redeemUrl, basePath)`, `buildHandoffFrameUrl(dbxUrl, endpoint, ticket)` |
| `web/src/lib/download.ts` | 前端外壳 | `downloadRaw(path, filename?): Promise<void>`；携带 cookie/Bearer，使用 blob |
| `web/src/lib/use-ws.ts` | 前端外壳 | `useTicketWs(path: string\|null, opts: { enabled?; onMessage; onClose? }): { status; send; close }`；自动取票/退避重连 |
| `web/src/lib/cn.ts` | 前端外壳 | `cn(...values: Array<string\|false\|null\|undefined>): string` |
| `web/src/lib/bootstrap.ts` | 前端外壳 | `bootstrapConnections(config?): void`；把 runtime config 的默认后端写入 connection store |
| `web/src/lib/connection-events.ts` | 前端外壳 | `onConnectionChange(listener): () => void`、`emitConnectionChange(reason)` |
| `web/src/lib/mutations.ts` | 前端外壳 | `useAppMutation(...)`、`toastError(toast, error, title?)`、`useInvalidate()`；写操作统一 toast + invalidate |
| `web/src/lib/query-keys.ts` | 前端外壳 | `connectionScope(): ConnectionScope`、`scopedKey(...parts): readonly unknown[]`；query key 按连接/机器隔离 |
| `web/src/lib/use-machines.ts` | 前端外壳 | `useMachines(enabled?): UseQueryResult<ListResult<Machine>, Error>` |
| `web/src/lib/use-refresh.ts` | 前端外壳 | `useRefresh(): { refresh(): void; busy: boolean }` |
| `web/src/lib/use-session.ts` | 前端外壳 | `useSession(): SessionState`；worker/core 会话状态与登录跳转 |
| `web/src/components/ui/index.ts` | 前端外壳 | 统一 re-export 所有 ui 组件 |
| `web/src/components/ui/Button.tsx` | 前端外壳 | `Button(props: ButtonProps & ButtonHTMLAttributes)`、`ButtonProps { variant?; size?; loading?; icon? }` |
| `web/src/components/ui/Input.tsx` | 前端外壳 | `Input(props: InputHTMLAttributes & { invalid? })` |
| `web/src/components/ui/Textarea.tsx` | 前端外壳 | `Textarea(props)` |
| `web/src/components/ui/Select.tsx` | 前端外壳 | `Select(props)`、`SelectOption { value; label }` |
| `web/src/components/ui/Checkbox.tsx` | 前端外壳 | `Checkbox(props)` |
| `web/src/components/ui/Switch.tsx` | 前端外壳 | `Switch(props: { checked; onChange; label?; disabled? })` |
| `web/src/components/ui/FormField.tsx` | 前端外壳 | `FormField(props: { label; hint?; error?; required?; children })` |
| `web/src/components/ui/Modal.tsx` | 前端外壳 | `Modal(props: { open; onClose; title; children; footer?; size? })` |
| `web/src/components/ui/Drawer.tsx` | 前端外壳 | `Drawer(props)` |
| `web/src/components/ui/Tabs.tsx` | 前端外壳 | `Tabs(props: { tabs: {id;label}[]; active; onChange })` |
| `web/src/components/ui/Badge.tsx` | 前端外壳 | `Badge(props: { tone?; children })` |
| `web/src/components/ui/Spinner.tsx` | 前端外壳 | `Spinner(props: { size?; label? })` |
| `web/src/components/ui/EmptyState.tsx` | 前端外壳 | `EmptyState(props: { title; description?; action? })` |
| `web/src/components/ui/ErrorState.tsx` | 前端外壳 | `ErrorState(props: { error; onRetry? })` |
| `web/src/components/ui/Alert.tsx` | 前端外壳 | `Alert(props: AlertProps)`、`UnavailableAlert(props)`、`AlertTone` |
| `web/src/components/ui/RelativeTime.tsx` | 前端外壳 | `RelativeTime(props: { value; className? })` |
| `web/src/components/ui/StatusBadge.tsx` | 前端外壳 | `StatusBadge(props: { status; className? })`（复用 tones） |
| `web/src/components/ui/Toolbar.tsx` | 前端外壳 | `Toolbar(props: { children; actions? })` |
| `web/src/components/ui/tones.ts` | 前端外壳 | `StatusTone`、`statusTone(status)`、`statusLabel(status)`、`TONE_CLASS`、`toneClass(tone)`、`cnTone(base, tone)` |
| `web/src/components/ui/CapabilityNotice.tsx` | 前端外壳 | `CapabilityNotice(props: { capability; status; hint? })` |
| `web/src/components/ui/ConfirmDialog.tsx` | 前端外壳 | `ConfirmDialog(props: { open; title; message; confirmLabel?; danger?; onConfirm; onCancel })` |
| `web/src/components/ui/DataTable.tsx` | 前端外壳 | `DataTable<T>(props: { columns: Column<T>[]; rows: T[]; rowKey; loading?; empty?; onRowClick? })`、`Column<T> { key; header; render?; className? }` |
| `web/src/components/ui/Pagination.tsx` | 前端外壳 | `Pagination(props: { nextCursor?; onNext; onReset?; loading? })` |
| `web/src/components/ui/SearchInput.tsx` | 前端外壳 | `SearchInput(props: { value; onChange; placeholder? })` |
| `web/src/components/ui/Toast.tsx` | 前端外壳 | `ToastProvider`, `useToast(): { push(input: {title; description?; tone?}) }` |
| `web/src/components/ui/Tooltip.tsx` | 前端外壳 | `Tooltip(props: { content; children })` |
| `web/src/components/ui/Card.tsx` | 前端外壳 | `Card(props)`, `CardHeader`, `CardBody` |
| `web/src/components/ui/PageHeader.tsx` | 前端外壳 | `PageHeader(props: { title; description?; actions? })` |
| `web/src/components/ui/CodeBlock.tsx` | 前端外壳 | `CodeBlock(props: { code; language?; maxHeight? })` |
| `web/src/components/ui/CodeEditor.tsx` | 前端外壳 | `CodeEditor(props: { value; onChange; readOnly?; height?; placeholder? })`；@uiw/react-codemirror |
| `web/src/components/ui/FileIcon.tsx` | 前端外壳 | `FileIcon(props: { type; name?; className? })` |
| `web/src/components/ui/LogViewer.tsx` | 前端外壳 | `LogViewer(props: { lines: {ts?;stream?;text}[]; follow?; onClear?; emptyText? })` |
| `web/src/components/ui/StatusDot.tsx` | 前端外壳 | `StatusDot(props: { status: 'online'\|'offline'\|'degraded'\|'error'\|'starting'\|'success'\|'warning' })` |
| `web/src/components/ui/CopyButton.tsx` | 前端外壳 | `CopyButton(props: { value; label? })` |
| `web/src/components/ui/SecretReveal.tsx` | 前端外壳 | `SecretReveal(props: { value; title; onDone })`；一次性 secret 展示 |
| `web/src/components/layout/Sidebar.tsx` | 前端外壳 | `Sidebar(): JSX.Element` |
| `web/src/components/layout/TopBar.tsx` | 前端外壳 | `TopBar(): JSX.Element` |
| `web/src/components/layout/ConnectionSwitcher.tsx` | 前端外壳 | `ConnectionSwitcher(): JSX.Element` |
| `web/src/components/layout/MachineSwitcher.tsx` | 前端外壳 | `MachineSwitcher(): JSX.Element`（仅 core） |
| `web/src/components/ConnectionDialog.tsx` | 前端外壳 | `ConnectionDialog(props: { open; onClose; initial? }): JSX.Element`；worker token/core 登录 |
| `web/src/components/CommandPalette.tsx` | 前端外壳 | `CommandPalette(): JSX.Element \| null`、`OPEN_COMMAND_PALETTE_EVENT`；Ctrl+K |
| `web/src/components/ConnectionManager.tsx` | 前端外壳 | `ConnectionManager(props): JSX.Element`；设置页连接增删改 |
| `web/src/pages/LoginPage.tsx` | 前端外壳 | `export default function LoginPage(): JSX.Element` |
| `web/src/pages/NotFoundPage.tsx` | 前端外壳 | `export default function NotFoundPage(): JSX.Element` |
| `web/src/pages/dashboard/DashboardPage.tsx` | 边缘节点与概览前端 | `export default function DashboardPage(): JSX.Element`；v0.2 起改为 1Panel 风格概览（v0.1 由前端外壳创建） |
| `web/src/pages/machines/MachinesPage.tsx` | 前端外壳 | `export default function MachinesPage(): JSX.Element` |
| `web/src/pages/machines/MachineDetailPage.tsx` | 前端外壳 | `export default function MachineDetailPage(): JSX.Element` |
| `web/src/pages/machines/MachineFormDialog.tsx` | 前端外壳 | `MachineFormDialog(props: { open; onClose; machine? })` |
| `web/src/pages/machines/EnrollmentDialog.tsx` | 前端外壳 | `EnrollmentDialog(props: { enrollment; onClose })` |
| `web/src/pages/sites/SitesPage.tsx` | 前端外壳 | `export default function SitesPage(): JSX.Element` |
| `web/src/pages/sites/SiteEditorPage.tsx` | 前端外壳 | `export default function SiteEditorPage(): JSX.Element` |
| `web/src/pages/sites/SiteForm.tsx` | 前端外壳 | `SiteForm(props: { value; onChange; onSubmit; submitting? })` |
| `web/src/pages/sites/SitePreviewDialog.tsx` | 前端外壳 | `SitePreviewDialog(props: { open; onClose; request })` |
| `web/src/pages/sites/SiteImportExportDialog.tsx` | 前端外壳 | `SiteImportExportDialog(props: { open; onClose })` |
| `web/src/pages/sites/SiteStatusBadge.tsx` | 前端外壳 | `SiteStatusBadge(props: { status: SiteStatus })` |
| `web/src/pages/certs/CertsPage.tsx` | 前端外壳 | `export default function CertsPage(): JSX.Element` |
| `web/src/pages/certs/CertDetailDrawer.tsx` | 前端外壳 | `CertDetailDrawer(props: { cert: CertificateInfo\|null; onClose })` |
| `web/src/pages/settings/SettingsPage.tsx` | 前端外壳 | `export default function SettingsPage(): JSX.Element` |
| `web/src/pages/settings/ConnectionsPanel.tsx` | 前端外壳 | `ConnectionsPanel(): JSX.Element` |
| `web/src/pages/settings/AboutPanel.tsx` | 前端外壳 | `AboutPanel(): JSX.Element` |
| `web/src/pages/db/DatabasesPage.tsx` | 前端数据库页 | `export default function DatabasesPage(): JSX.Element`；profiles + iframe |
| `web/src/pages/db/ProfileList.tsx` | 前端数据库页 | `ProfileList(props: { profiles; selectedId; onSelect; onEdit; onDelete; onTest })` |
| `web/src/pages/db/ProfileFormDialog.tsx` | 前端数据库页 | `ProfileFormDialog(props: { open; onClose; profile?; onSaved })` |
| `web/src/pages/db/DatabaseStatsPanel.tsx` | 前端数据库页 | `DatabaseStatsPanel(props: { profileId })` |
| `web/src/pages/db/BackupPanel.tsx` | 前端数据库页 | `BackupPanel(props: { profileId })` |
| `web/src/pages/db/JobProgress.tsx` | 前端数据库页 | `JobProgress(props: { jobId; onDone? })` |
| `web/src/pages/db/DbxFrame.tsx` | 前端数据库页 | `DbxFrame(props: { redeemUrl: string; dbxUrl?: string })`；iframe |
| `web/src/pages/db/HandoffButton.tsx` | 前端数据库页 | `HandoffButton(props: { profileId; onTicket })` |
| `web/src/pages/containers/ContainersPage.tsx` | 前端容器页 | `export default function ContainersPage(): JSX.Element` |
| `web/src/pages/containers/ContainerTable.tsx` | 前端容器页 | `ContainerTable(props: { items; loading; onOpen; onAction })` |
| `web/src/pages/containers/ContainerDetailDrawer.tsx` | 前端容器页 | `ContainerDetailDrawer(props: { id; onClose })` |
| `web/src/pages/containers/ContainerLogsPanel.tsx` | 前端容器页 | `ContainerLogsPanel(props: { id })`；WS 日志 |
| `web/src/pages/containers/ContainerStatsPanel.tsx` | 前端容器页 | `ContainerStatsPanel(props: { id })` |
| `web/src/pages/containers/ContainerExecDialog.tsx` | 前端容器页 | `ContainerExecDialog(props: { id; open; onClose })` |
| `web/src/pages/containers/ImagesPage.tsx` | 前端容器页 | `export default function ImagesPage(): JSX.Element` |
| `web/src/pages/containers/ImagePullDialog.tsx` | 前端容器页 | `ImagePullDialog(props: { open; onClose })` |
| `web/src/pages/containers/StacksPage.tsx` | 前端容器页 | `export default function StacksPage(): JSX.Element` |
| `web/src/pages/containers/StackDetailPage.tsx` | 前端容器页 | `export default function StackDetailPage(): JSX.Element` |
| `web/src/pages/containers/StackEditorPage.tsx` | 前端容器页 | `export default function StackEditorPage(): JSX.Element` |
| `web/src/pages/containers/ContainerTabs.tsx` | 前端容器页 | `ContainerTabs(): JSX.Element`；容器/镜像/编排三页导航 |
| `web/src/pages/containers/container-utils.ts` | 前端容器页 | `CONTAINER_ACTION_LABEL`、`containerName`、`containerShortId`、`formatPort(s)`、`containerStateLabel`、`isRunningState` |
| `web/src/pages/containers/log-utils.ts` | 前端容器页 | `LOG_LINE_LIMIT`、`parseLogMessage(raw)`、`toLogLine(message)`、`appendLogLines(...)`、`wsCloseHint(code)`、`isFatalCloseCode(code)` |
| `web/src/pages/containers/Sparkline.tsx` | 前端容器页 | `Sparkline(props: SparklineProps)`；行内趋势 |
| `web/src/pages/containers/stack-utils.ts` | 前端容器页 | `STACK_NAME_PATTERN`、`STACK_ACTION_LABEL`、`validateStackName`、`validateComposeYaml`、`stackStatusLabel/Tone`、`stackWorkingDir`、`stackComposeFile`、`collectStackImages`、`stackServiceName`、`stackPullHint` |
| `web/src/pages/containers/StackLogsDrawer.tsx` | 前端容器页 | `StackLogsDrawer(props: StackLogsDrawerProps)` |
| `web/src/pages/containers/StackLogsPanel.tsx` | 前端容器页 | `StackLogsPanel(props: StackLogsPanelProps)`；多容器 WS 聚合（≤8 连接） |
| `web/src/pages/containers/useContainerStats.ts` | 前端容器页 | `STATS_HISTORY_LIMIT`、`StatsPoint`、`ContainerStatsSnapshot`、`useContainerStats(...)`、`seriesValues(...)`；每 5 秒轮询运行中容器 |
| `web/src/pages/containers/useStackActions.tsx` | 前端容器页 | `StackOperation`、`StackBusyState`、`StackPullProgress`、`StackActionsApi`、`useStackActions(options?)`、`StackPullProgressBanner` |
| `web/src/pages/files/FilesPage.tsx` | 前端文件页 | `export default function FilesPage(): JSX.Element` |
| `web/src/pages/files/FileBrowser.tsx` | 前端文件页 | `FileBrowser(): JSX.Element` |
| `web/src/pages/files/FileTable.tsx` | 前端文件页 | `FileTable(props: { items; onOpen; onSelect; selected })` |
| `web/src/pages/files/FileToolbar.tsx` | 前端文件页 | `FileToolbar(props: { root; path; onRefresh; onNewFolder; onUpload; onArchive; onSearch; onTrash })` |
| `web/src/pages/files/Breadcrumbs.tsx` | 前端文件页 | `Breadcrumbs(props: { path; onNavigate })` |
| `web/src/pages/files/FileEditorDrawer.tsx` | 前端文件页 | `FileEditorDrawer(props: { file: FileItem\|null; onClose; onSaved })` |
| `web/src/pages/files/FilePreview.tsx` | 前端文件页 | `FilePreview(props: { file; content; isBinary })` |
| `web/src/pages/files/UploadDialog.tsx` | 前端文件页 | `UploadDialog(props: { open; root; path; onClose; onDone })` |
| `web/src/pages/files/TrashDrawer.tsx` | 前端文件页 | `TrashDrawer(props: { open; onClose })` |
| `web/src/pages/files/ArchiveDialog.tsx` | 前端文件页 | `ArchiveDialog(props: { open; root; paths; onClose; onDone })` |
| `web/src/pages/files/FileSearchPanel.tsx` | 前端文件页 | `FileSearchPanel(props: { root; path; onClose; onOpen })` |
| `web/src/pages/terminal/TerminalPage.tsx` | 前端终端与任务页 | `export default function TerminalPage(): JSX.Element` |
| `web/src/pages/terminal/TerminalTabs.tsx` | 前端终端与任务页 | `TerminalTabs(props: { sessions; activeId; onSelect; onClose })` |
| `web/src/pages/terminal/TerminalView.tsx` | 前端终端与任务页 | `TerminalView(props: { sessionId; active })`；xterm + fit + WS |
| `web/src/pages/terminal/NewSessionDialog.tsx` | 前端终端与任务页 | `NewSessionDialog(props: { open; onClose; onCreated })` |
| `web/src/pages/terminal/SessionList.tsx` | 前端终端与任务页 | `SessionList(props: { sessions; onOpen; onDelete })` |
| `web/src/pages/tasks/TasksPage.tsx` | 前端终端与任务页 | `export default function TasksPage(): JSX.Element` |
| `web/src/pages/tasks/TaskEditorPage.tsx` | 前端终端与任务页 | `export default function TaskEditorPage(): JSX.Element` |
| `web/src/pages/tasks/TaskForm.tsx` | 前端终端与任务页 | `TaskForm(props: { value; onChange; onSubmit; submitting? })` |
| `web/src/pages/tasks/RunHistoryDrawer.tsx` | 前端终端与任务页 | `RunHistoryDrawer(props: { taskId; open; onClose })` |
| `web/src/pages/tasks/TaskRunTable.tsx` | 前端终端与任务页 | `TaskRunTable(props: { runs; onOpen? })` |
| `web/src/pages/tasks/NextRunsPreview.tsx` | 前端终端与任务页 | `NextRunsPreview(props: { taskId })` |
| `web/src/styles/index.css` | 前端外壳 | `@tailwind base/components/utilities` + 全局样式；无导出 |

### 1.6 scripts 与 deploy

| 路径 | owner | 必须导出/约定 |
|---|---|---|
| `scripts/check.mjs` | 集成 | 可执行 Node 脚本（无导出）；解析本文件所有权表；禁止 `TODO/FIXME`、`child_process.exec(`、`execSync`、`shell:true`、web import shared；跑根 `pnpm typecheck` + `pnpm build`（保证 shared 先构建）；`--no-typecheck`/`--no-build`/`--verbose`；失败退出 1 |
| `scripts/smoke.mjs` | 集成 | 可执行 Node 脚本；无外部 Caddy/Docker/Postgres/Redis 依赖；临时 `MPANEL_HOME`；worker/core 冒烟；`--keep`、`--verbose`、`--timeout=120000`；失败退出 1 |
| `deploy/systemd/mpanel-worker.service` | 集成 | —；WorkingDirectory 指向 `pnpm deploy` 输出（dist+node_modules）、User=mpanel、EnvironmentFile、Restart=always、ReadWritePaths；stdio 模式不设置公网端口 |
| `deploy/systemd/mpanel-core.service` | 集成 | —；同上，ExecStart core；`MPANEL_ALLOW_STDIO=1` 必须显式开启 |
| `deploy/env/worker.env.example` | 集成 | —；§4.1 全部变量的注释示例（http/stdio/reverse-ws） |
| `deploy/env/core.env.example` | 集成 | —；§4.2 全部变量 |
| `deploy/Caddyfile.example` | 集成 | —；面板反代（core 或直连 worker）示例，含 WS Upgrade、上传大小、CSP/nosniff/Referrer-Policy |
| `deploy/README.md` | 集成 | —；Linux systemd、Windows NSSM、TLS、reverse-ws、权限、备份 |
| `deploy/windows/README.md` | 集成 | —；NSSM/任务计划、PowerShell 环境变量、路径注意事项 |


### 1.9 边缘节点与交付流水线（v0.2）

| 路径 | owner | 必须导出/约定 |
|---|---|---|
| `server/core/src/edge/types.ts` | 边缘节点后端 | 边缘类型（EdgeKey/EdgeJob 记录与视图形状） |
| `server/core/src/edge/store.ts` | 边缘节点后端 | 原子 JSON 存储：edge-keys.json / edge-jobs.json |
| `server/core/src/edge/service.ts` | 边缘节点后端 | EdgeService：密钥、入网、作业 CRUD 与串行队列 |
| `server/core/src/edge/dispatcher.ts` | 边缘节点后端 | 10s 调度循环与 5min 快照刷新 |
| `server/core/src/edge/routes.ts` | 边缘节点后端 | /edge/* 路由（enroll 免登录） |
| `server/worker/src/edge/identity.ts` | 边缘节点后端 | edge.json 身份存储（tmp+fsync+rename，0600） |
| `server/worker/src/edge/enroll.ts` | 边缘节点后端 | POST /api/v1/edge/enroll 客户端 |
| `server/worker/src/edge/runtime.ts` | 边缘节点后端 | 边缘模式装配（身份复用/失效重入网） |
| `server/worker/src/edge/index.ts` | 边缘节点后端 | 边缘入口导出 |
| `server/worker/src/modules/system/index.ts` | 边缘节点后端 | GET /system/snapshot 与 /system/metrics |
| `AGENTS.md` | 集成 | —；协作与提交约束（PR/签名/目录/契约先行） |
| `CLAUDE.md` | 集成 | —；@AGENTS.md |
| `LICENSE` | 集成 | —；私有许可声明 |
| `.dockerignore` | 集成 | —；镜像构建上下文排除项 |
| `.github/workflows/校验.yml` | 集成 | —；PR/main 门禁：check.mjs + smoke.mjs |
| `.github/workflows/镜像构建.yml` | 集成 | —；web/core/worker → GHCR，固定 tag latest 与 v<version> |
| `deploy/Dockerfile.web` | 集成 | —；静态站镜像（nginx + 运行时 config.json） |
| `deploy/nginx.web.conf` | 集成 | —；SPA 回退、安全头、静态缓存 |
| `deploy/web/config.json.template` | 集成 | —；运行时 config.json 模板（envsubst） |
| `deploy/web/docker-entrypoint.sh` | 集成 | —；生成并校验 config.json |


### 1.10 边缘节点前端（v0.2）

| 路径 | owner | 必须导出/约定 |
|---|---|---|
| `web/src/pages/edge/CreateEdgeJobDialog.tsx` | 边缘节点与概览前端 | 边缘节点页 |
| `web/src/pages/edge/CreateEdgeKeyDialog.tsx` | 边缘节点与概览前端 | 边缘节点页 |
| `web/src/pages/edge/edge-utils.ts` | 边缘节点与概览前端 | 边缘节点页 |
| `web/src/pages/edge/EdgeJobResultDrawer.tsx` | 边缘节点与概览前端 | 边缘节点页 |
| `web/src/pages/edge/EdgeJobsPanel.tsx` | 边缘节点与概览前端 | 边缘节点页 |
| `web/src/pages/edge/EdgeKeyPanel.tsx` | 边缘节点与概览前端 | 边缘节点页 |
| `web/src/pages/edge/EdgeNodeDrawer.tsx` | 边缘节点与概览前端 | 边缘节点页 |
| `web/src/pages/edge/EdgeNodeTable.tsx` | 边缘节点与概览前端 | 边缘节点页 |
| `web/src/pages/edge/EdgePage.tsx` | 边缘节点与概览前端 | 边缘节点页 |
| `web/src/pages/edge/UsageMeter.tsx` | 边缘节点与概览前端 | 边缘节点页 |
| `web/src/pages/edge/use-page-visible.ts` | 边缘节点与概览前端 | 边缘节点页 |
| `web/src/pages/dashboard/MachineGrid.tsx` | 边缘节点与概览前端 | 1Panel 风格概览 |
| `web/src/pages/dashboard/MetricCards.tsx` | 边缘节点与概览前端 | 1Panel 风格概览 |
| `web/src/pages/dashboard/QuickActions.tsx` | 边缘节点与概览前端 | 1Panel 风格概览 |
| `web/src/pages/dashboard/ResourceCards.tsx` | 边缘节点与概览前端 | 1Panel 风格概览 |
| `web/src/pages/dashboard/UsageBar.tsx` | 边缘节点与概览前端 | 1Panel 风格概览 |
| `web/src/pages/dashboard/use-page-visible.ts` | 边缘节点与概览前端 | 1Panel 风格概览 |
| `web/src/api/edge.ts` | 边缘节点与概览前端 | 边缘 API 客户端与类型 |

<!-- OWNERSHIP_TABLE_END -->

## 2. 模块边界与注册契约

### 2.1 worker 模块

```ts
interface WorkerModuleContext extends ModuleContext<FastifyInstance> {
  app: FastifyInstance;
  config: WorkerConfig;
  store: StoreFactory;
  paths: PathSandbox;
  runner: CommandRunner & ShellRunner;
  wsBridge: WsBridge;
  auth: WorkerAuth;
}

type WorkerModule = ModuleRegistration<FastifyInstance, WorkerModuleContext>;
```

- `createWorkerApp` 创建 `CapabilityService`（不是一次性快照）→ 创建 `WorkerModuleContext` → `ModuleRegistry.registerAll`；能力探测失败只记录，不阻止启动。
- registry 为每个模块在同一个 `/api/v1` 作用域创建 Fastify 子插件；模块用 `prefixes` 声明自己拥有的前缀，并在 `register` 内注册**完整 API 相对路径**（如 `/containers`、`/images`、`/stacks`）。不允许用 `/api/v1${prefix}` 自动包一层，否则多前缀模块（containers）无法注册。
- 模块不得自行调用 `listen`、不得写 stdout、不得访问其他模块的 store；跨模块需求走 `ctx` 提供的服务或新增共享文件（需改契约）。
- 能力校验：模块在写 handler 开头 `await assertCapability(ctx.capabilities, name)`；列表返回 `{available:false,reason}`；不得缓存启动时的能力快照。
- WS 模块通过 `ctx.wsBridge.register('/ws/...', handler)`；`createWorkerApp` 统一注册 `registerWsGateway`，HTTP 传输与隧道都进入同一 bridge。模块若持有定时器/子进程/PTY，必须 `app.addHook('onClose', ...)` 释放（tasks scheduler、terminal sessions、log streams）。

### 2.2 core 服务注入

`buildCoreApp(deps)` 只依赖 `AuthService` 与 `MachineService` 接口：

- `auth/routes.ts` 使用 `AuthService`；`machines/routes.ts` 使用 `MachineService`；`proxy/*` 使用二者；`system.ts` 使用 `MachineService.listAll/get`，机器列表路由用 `list`（分页）。
- 传输驱动由 `createMachineService` 内部实例化，网关不 import 驱动。
- `/ws/worker` 的升级由 core `app.ts` 注册：`preValidation` 调 `machines.authenticateReverseWs(req)`，成功后写 `req.reverseWsMachine = machine`（FastifyRequest augmentation，定义在 machines/types）；handler 调 `machines.handleReverseWs(req.reverseWsMachine.id, socket, req)`。失败 401/403 不升级。
- 鉴权 hook 作用域：公开 healthz/login/static；`/api/v1` 受保护（精确放行 handoff redeem）；`/ws/worker`、worker `/ws/*`、core 代理 WS 由各自 gateway/preValidation 认证，不挂 REST hook。
- 任何 core 路由不得直接 spawn/fetch worker。

### 2.3 前端页面

- `routes.tsx` 是唯一路由表；页面文件必须 default export 且无 props（路由参数用 `useParams`）。
- 页面只 import：`api/*`、`lib/*`、`components/ui/*`、`components/layout/*`、`api/types.ts`。
- 页面目录内组件只属于该 owner；跨页面共享组件必须放 `components/`（前端外壳）。
- 前端外壳负责 layout、连接切换、登录、能力横幅、错误边界；页面不自行创建 QueryClient/Toast Provider。
- 查询键统一在 `api/*` 内定义（如 `queryKeys.sites.list(params)`），页面使用；切换连接时 Provider 清空缓存。

## 3. MachineService 接口（网关轨道直接 import）

`server/core/src/machines/service.ts`：

```ts
import type { Readable } from 'node:stream';
import type {
  Machine, MachineCreateInput, MachineCreateResult, MachineEnrollment,
  MachineHealth, MachineStatus, MachineTestResult, MachineTransport,
  MachineUpdateInput, SystemInfo, WsTicket,
} from '@mpanel/shared';

export interface MachineHttpRequest {
  method: string;
  path: string;                                  // 以 /api/v1/ 或 /healthz 开头
  headers: Record<string, string | string[] | undefined>;
  body: Readable | null;
  requestId: string;
  remoteAddress?: string;
  signal?: AbortSignal;
}

export interface MachineHttpResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body: Readable;
}

export interface MachineWsOpenRequest {
  path: string;                                  // /ws/...，含 query
  headers: Record<string, string | string[] | undefined>;
  protocols?: string[];
}

export interface MachineWsConnection {
  send(data: string | Uint8Array, binary: boolean): void;
  close(code?: number, reason?: string): void;
  onMessage(cb: (data: string | Uint8Array, binary: boolean) => void): void;
  onClose(cb: (code: number, reason: string) => void): void;
}

export interface MachineService {
  list(query?: { status?: MachineStatus; transport?: MachineTransport; q?: string; limit?: number; cursor?: string }): Promise<ListResult<Machine>>;
  listAll(query?: { status?: MachineStatus; transport?: MachineTransport; q?: string }): Promise<Machine[]>; // overview/聚合
  get(id: string): Promise<Machine>;
  create(input: MachineCreateInput): Promise<MachineCreateResult>;
  update(id: string, input: MachineUpdateInput): Promise<Machine>;
  remove(id: string): Promise<void>;
  connect(id: string): Promise<Machine>;
  disconnect(id: string): Promise<Machine>;
  test(id: string): Promise<MachineTestResult>;
  health(id: string): Promise<MachineHealth>;
  rotateSecret(id: string): Promise<{ secret: string; workerEnv: Record<string, string> }>;
  request(id: string, req: MachineHttpRequest): Promise<MachineHttpResponse>;
  openWs(id: string, req: MachineWsOpenRequest): Promise<MachineWsConnection>;
  info(id: string): Promise<SystemInfo>;          // system/test 复用
  /** 校验 /ws/worker 的 machine secret，返回机器；失败抛 UNAUTHORIZED/FORBIDDEN。 */
  authenticateReverseWs(req: import('node:http').IncomingMessage): Promise<Machine>;
  /** 认证后的 reverse-ws 连接交给对应驱动；负责 hello/心跳/帧循环。app 在 preValidation 保存 `req.reverseWsMachine`。 */
  handleReverseWs(machineId: string, socket: import('ws').WebSocket, req: import('node:http').IncomingMessage): Promise<void>;
  shutdown(): Promise<void>;
}
```

- `get` 不存在 → `PanelError('NOT_FOUND')`；`request/openWs` 对 offline → `PanelError('UNAVAILABLE', ..., {hint, machineId, machineStatus})`。
- 网关不得把 `MachineRecord`（含凭据）暴露给路由。

### 3.1 三种传输驱动工厂（core）

```ts
export interface TransportDriver {
  readonly kind: MachineTransport;
  start(machine: MachineRecord): Promise<void>;
  stop(machineId: string): Promise<void>;
  request(machineId: string, req: MachineHttpRequest): Promise<MachineHttpResponse>;
  openWs(machineId: string, req: MachineWsOpenRequest): Promise<MachineWsConnection>;
  status(machineId: string): DriverStatus;
  attach?(machineId: string, socket: import('ws').WebSocket, req: import('node:http').IncomingMessage): Promise<void>;
}

export interface TransportDriverDeps {
  config: CoreConfig;
  credentials: { getToken(machine: MachineRecord): Promise<string>; getSecret(machine: MachineRecord): Promise<string> };
  logger: FastifyBaseLogger;
}

export type TransportDriverFactory = (deps: TransportDriverDeps) => TransportDriver;

export function createHttpTransportDriver(deps: TransportDriverDeps): TransportDriver;       // transports/http.ts
export function createStdioTransportDriver(deps: TransportDriverDeps): TransportDriver;      // transports/stdio.ts
export function createReverseWsTransportDriver(deps: TransportDriverDeps): TransportDriver;  // transports/reverse-ws.ts
export function createStdioChannel(...): TunnelChannel;
export function createReverseWsChannel(...): TunnelChannel;

export interface TunnelChannel {
  send(frame: TunnelFrame): Promise<void>; // resolves after drain/backpressure
  close(code?: number, reason?: string): void;
  onFrame(cb: (frame: TunnelFrame) => void): void;
  onClose(cb: (code?: number, reason?: string) => void): void;
}
export type TunnelChannelFactory = () => Promise<TunnelChannel>;
```

- 三个驱动都不解析 API 业务；只处理认证、路径、HTTP/WS 转发。
- reverse-ws driver 不自己 listen；core `app.ts` 注册 `GET /ws/worker`（`@fastify/websocket`），`preValidation` 用 `authenticateReverseWs`，handler 调 `handleReverseWs`。
- 驱动 `status` 返回 `online/offline/starting/degraded/error` 与 lastSeen/latency/failures。

## 4. 配置契约

### 4.1 WorkerConfig

```ts
interface WorkerConfig {
  home: string;
  transport: 'http' | 'stdio' | 'reverse-ws';
  host: string;                         // 默认 127.0.0.1
  port: number;                         // 默认 8787；0 = 随机
  token: string;                        // MPANEL_TOKEN，serve 必填
  publicUrl?: string;                   // MPANEL_PUBLIC_URL，ticket/redeem 绝对地址用
  corsOrigins: string[];
  dbxOrigin?: string;
  logLevel: string;
  caddy: {
    bin: string;                        // MPANEL_CADDY_BIN= caddy
    configDir: string;                  // $HOME/caddy
    dataDir: string;                    // $HOME/caddy/data
    sitesRoots: string[];               // file_server.root 白名单
    backupDir: string;
    stagingDir: string;
    adminAddress?: string;
  };
  docker: { bin: string; composeBin?: string; socket?: string };
  databases: {
    pgDumpBin: string; pgRestoreBin: string; psqlBin: string; redisCliBin: string;
    backupDir: string;
  };
  files: {
    roots: { name: string; path: string }[];  // 默认 [{name:'files', path:$HOME/files}]
    trashDir: string;
    maxUploadBytes: number;                   // 默认 100 MiB
  };
  tasks: { shell?: string; historyLimit: number };
  security: { secretKey?: string; keyFile: string };       // MPANEL_SECRET_KEY / $HOME/secrets.key
  redeemRateLimit: { windowSec: number; max: number };      // 默认 60s / 10，handoff redeem
  coreUrl?: string;                      // reverse-ws
  machineId?: string;
  machineSecret?: string;
  insecureCoreTls: boolean;
}
```

环境变量（全部）：`MPANEL_HOME`、`MPANEL_TRANSPORT`、`MPANEL_HOST`、`MPANEL_PORT`、`MPANEL_TOKEN`、`MPANEL_PUBLIC_URL`、`MPANEL_CORS_ORIGINS`、`MPANEL_DBX_ORIGIN`、`MPANEL_LOG_LEVEL`、`MPANEL_CADDY_BIN`、`MPANEL_CADDY_CONFIG_DIR`、`MPANEL_CADDY_DATA_DIR`、`MPANEL_CADDY_ADMIN`、`MPANEL_SITES_ROOTS`、`MPANEL_DOCKER_BIN`、`MPANEL_DOCKER_COMPOSE_BIN`、`MPANEL_PG_DUMP_BIN`、`MPANEL_PG_RESTORE_BIN`、`MPANEL_PSQL_BIN`、`MPANEL_REDIS_CLI_BIN`、`MPANEL_FILES_ROOTS`（`name=path[,name=path]`）、`MPANEL_MAX_UPLOAD_BYTES`、`MPANEL_TASK_SHELL`、`MPANEL_TASK_HISTORY_LIMIT`、`MPANEL_SECRET_KEY`、`MPANEL_REDEEM_RATE_LIMIT`（`10/60s`）、`MPANEL_CORE_URL`、`MPANEL_MACHINE_ID`、`MPANEL_MACHINE_SECRET`、`MPANEL_CORE_INSECURE`。

### 4.2 CoreConfig

```ts
interface CoreConfig {
  home: string;
  host: string;                         // 默认 127.0.0.1
  port: number;                         // 默认 8790；0 = 随机（smoke）
  publicUrl?: string;                   // 反代公网地址，用于 reverse enrollment
  webDir?: string;                      // web/dist；缺失则只提供 API
  allowStdio: boolean;                  // MPANEL_ALLOW_STDIO=1
  workerEntry: string;                  // MPANEL_WORKER_ENTRY，stdio 默认 args
  corsOrigins: string[];
  dbxOrigin?: string;
  cookieName: string;                   // 默认 mpanel_session
  cookieSecure: boolean;
  cookieSameSite: 'lax' | 'none' | 'strict';
  sessionTtlSec: number;
  allowWsQuerySecret: boolean;          // MPANEL_ALLOW_WS_QUERY_SECRET，默认 false
  redeemRateLimit: { windowSec: number; max: number }; // 默认 60s / 10
  csp?: string;                         // MPANEL_CSP，静态 CSP 覆盖
  coreToken?: string;                   // MPANEL_CORE_TOKEN
  adminUser?: string;                   // 首次启动 seed
  adminPassword?: string;
  trustProxy: boolean;
  secretKey?: string;                   // MPANEL_SECRET_KEY，机器凭据加密
  logLevel: string;
}
```

环境变量：`MPANEL_HOME`、`MPANEL_HOST`、`MPANEL_PORT`、`MPANEL_PUBLIC_URL`、`MPANEL_WEB_DIR`、`MPANEL_ALLOW_STDIO`、`MPANEL_WORKER_ENTRY`、`MPANEL_CORS_ORIGINS`、`MPANEL_DBX_ORIGIN`、`MPANEL_COOKIE_NAME`、`MPANEL_COOKIE_SECURE`、`MPANEL_COOKIE_SAMESITE`、`MPANEL_SESSION_TTL_HOURS`、`MPANEL_CORE_TOKEN`、`MPANEL_ADMIN_USER`、`MPANEL_ADMIN_PASSWORD`、`MPANEL_TRUST_PROXY`、`MPANEL_SECRET_KEY`、`MPANEL_ALLOW_WS_QUERY_SECRET`、`MPANEL_REDEEM_RATE_LIMIT`（`10/60s`）、`MPANEL_CSP`、`MPANEL_LOG_LEVEL`。

`adminUser/adminPassword` 只在 `users.json` 不存在/为空时创建一次；之后忽略并日志提示。scrypt 参数固定；密码最短 10 字符。

## 5. 根 scripts 与工作区

### 5.1 根 package.json scripts

```json
{
  "scripts": {
    "build:shared": "pnpm --filter @mpanel/shared build",
    "build": "pnpm build:shared && pnpm --filter @mpanel/worker build && pnpm --filter @mpanel/core build && pnpm --filter @mpanel/web build",
    "typecheck": "pnpm build:shared && pnpm -r typecheck",
    "dev": "pnpm build:shared && pnpm --parallel --filter @mpanel/worker --filter @mpanel/core --filter @mpanel/web dev",
    "check": "node scripts/check.mjs",
    "smoke": "node scripts/smoke.mjs",
    "start:worker": "node server/worker/dist/index.js",
    "start:core": "node server/core/dist/index.js",
    "deploy:worker": "pnpm --filter @mpanel/worker deploy --prod out/worker",
    "deploy:core": "pnpm --filter @mpanel/core deploy --prod out/core",
    "clean": "pnpm -r clean && node -e \"for (const p of ['server/shared','server/worker','server/core','web']) require('node:fs').rmSync(p + '/dist', {recursive:true,force:true})\""
  }
}
```

- `pnpm-workspace.yaml`：

```yaml
packages:
  - server/shared
  - server/worker
  - server/core
  - web
onlyBuiltDependencies:
  - esbuild
  - node-pty
```

- 每个 package 的 scripts：worker/core `dev`=`tsx watch src/index.ts`、`build`=`tsc -p tsconfig.json`、`typecheck`=`tsc -p tsconfig.json --noEmit`、`clean` 删除 `dist`；web `dev`=`vite`、`build`=`tsc --noEmit && vite build`、`typecheck`=`tsc --noEmit`、`clean` 删除 `dist`；shared 已有 build/typecheck/clean，无 dev。
- `typecheck` 前必须 build shared，因为 core/worker 通过包 exports 解析 `dist/*.d.ts`。
- 独立部署必须用 `pnpm deploy`（dist + 生产 node_modules，含 @mpanel/shared/zod），不能只复制 dist；systemd 的 WorkingDirectory 指向 deploy 输出。
- `node-pty` 在 `optionalDependencies`；`pnpm install` 失败不阻断其它包。

### 5.2 `scripts/check.mjs` 约定

1. 读取 `<!-- OWNERSHIP_TABLE_START -->` 与 `<!-- OWNERSHIP_TABLE_END -->` 之间的所有权表：
   - 每个路径存在（`deploy/**`、`web/public/config.json` 等不能漏）。
   - owner ∈ 16 名单；路径唯一；同一 `web/src/pages/<dir>/` 仅一个 owner。
2. 静态禁令：
   - `server/**` 不含 `child_process.exec(`、`execSync(`、`shell: true`、字符串拼接 `spawn('sh -c ...')`（`tasks/runner.ts` 的 `buildShellArgs` 例外，必须只传 argv）。
   - `web/src/**` 不含 `from '@mpanel/shared'` 或 `require('@mpanel/shared')`。
   - `server/**` 与 `web/src/**` 的实现文件不含 `TODO`/`FIXME` 标记（文档不参与该扫描）。
   - worker 非 CLI 文件不含 `console.log`、`console.info`、`console.debug`、`process.stdout.write`，也不含 `stdio:'inherit'`（例外：`index.ts` 的 `token generate`/help、`transports/http.ts` 的 listening 行）。
   - 反向覆盖：`server/*/src/**/*.ts` 与 `web/src/**/*.{ts,tsx}` 的每个实现文件必须出现在所有权表（排除 dist/生成文件），多出即失败。
   - 解析 `docs/api-contract.md` §15 的 `// TypeName` 列表，校验 `web/src/api/types.ts` 有同名 export。
3. 契约覆盖：`docs/api-contract.md` 必须包含 §18 覆盖检查表列出的关键路径字符串。
4. 执行根 `pnpm typecheck` 与 `pnpm build`（可用 `--no-typecheck`/`--no-build`），确保 shared 先于 core/worker 构建。
5. `node --input-type=module -e "import('@mpanel/shared').then(...)"` 验证 shared 产物可加载、`decodeTunnelFrame` 可用。
6. 输出 PASS/FAIL 摘要；失败退出 1。

### 5.3 `scripts/smoke.mjs` 约定

- 前置：`pnpm build`（或 `--no-build` 跳过；默认检查 dist 存在）。
- 打包验证：对 worker（至少）执行 `pnpm --filter @mpanel/worker deploy --prod <tmp>/deploy-worker`，在空 cwd 运行 `<tmp>/deploy-worker/dist/index.js --version`，断言能解析 @mpanel/shared/zod；core 同法。
- 使用 `node:child_process.spawn` 启动 `server/worker/dist/index.js` 与 `server/core/dist/index.js`：
  - 临时 `MPANEL_HOME`（`os.tmpdir()/mpanel-smoke-<rand>`）。
  - worker：`MPANEL_PORT=0`、`MPANEL_HOST=127.0.0.1`、随机 token；解析 stdout listening JSON。
  - core：`MPANEL_PORT=0`、`MPANEL_CORE_TOKEN`、`MPANEL_ADMIN_USER`/`MPANEL_ADMIN_PASSWORD`、`MPANEL_WEB_DIR` 指向临时 index.html 目录（验证静态头）、`MPANEL_ALLOW_STDIO=1`、`MPANEL_WORKER_ENTRY` 指向 worker dist。
- 断言至少：
  1. `/healthz` 200；无 token `/api/v1/system/info` 401；错误信封 code。
  2. `system/info` 有五个能力键且每个有 `available`；`pty` 可为 false。
  3. `/sites` 创建 + `preview` 生成 Caddyfile；caddy 不可用时调用 apply 断言 503 + `details.hint`；caddy 可用时**不调用 apply**（没有隔离 Caddy，避免影响宿主），只断言 preview 的 `validation` 形状。
  4. `/files/roots` + list + write/read + `../`/反斜杠/盘符逃逸 400 + 删除到 trash（temp home）；经 core 的 multipart 上传一个小文件成功，经 core 的 5 MiB JSON `/files/write` 成功（验证 parser/bodyLimit）。
  5. `/tasks` 创建（cron `*/5 * * * *`）+ run-now + 轮询 history 到 success（命令用 `node --version`，跨平台、无引号转义问题）。
  6. `/terminal/sessions` 创建/列出/删除；WS ticket 后连接并收到 `ready`（无 PTY 也可）；core 代理 WS 用 core ticket 成功连接同一 terminal 并收到 `ready`；http 直连 worker 的 WS 使用 Bearer header（服务端到服务端）成功。
  7. `/databases/profiles` 创建 + handoff；`POST /databases/handoff/redeem` body `{ticket}` 返回临时密码（不连接目标）；经 core proxy 的 redeem 无 session 可成功；重复 redeem 404，超限返回 401+retryAfterSec。
  8. core 登录：`POST /auth/login` 返回 `Set-Cookie`，带 cookie `GET /auth/me` 成功，`POST /auth/logout` 后 cookie 失效；再验证 `MPANEL_CORE_TOKEN` Bearer 可用。
  9. core：Bearer token 创建 http 机器（指向 worker），等待 online，`system/overview`、`proxy/system/info`、`proxy/sites` 成功；创建 stdio 机器（spawn 第二个 worker，临时 home）等待 online 并 `proxy/system/info`；创建 reverse-ws 机器并用 enrollment 启动第三个 worker 拨号，等待 online 并 `proxy/system/info`；删除机器。
  10. 静态头：core `GET /` 断言 CSP、X-Content-Type-Options、Referrer-Policy 存在。
  11. 裸连 core 代理 WS 无 ticket 被 401/close 4401；healthz 与 login 在无 cookie 时不被 401。
- 清理：SIGTERM、等待退出、删除临时目录（`--keep` 保留）；任何未捕获错误打印后退出 1；总超时 180s。
- 不启动 Docker/Caddy/Postgres/Redis；缺少这些时断言降级形状，而不是失败或跳过。
- Node 24 内置 `fetch`/`WebSocket`；不依赖 vitest/jest。

### 5.4 前端路由表（`web/src/routes.tsx`）

| 路径 | 页面 |
|---|---|
| `/` | DashboardPage |
| `/login` | LoginPage |
| `/machines` | MachinesPage（仅 core） |
| `/machines/:id` | MachineDetailPage（仅 core） |
| `/sites` | SitesPage |
| `/sites/new` | SiteEditorPage |
| `/sites/:id` | SiteEditorPage |
| `/certs` | CertsPage |
| `/databases` | DatabasesPage |
| `/containers` | ContainersPage |
| `/containers/:id` | ContainersPage（drawer） |
| `/images` | ImagesPage |
| `/stacks` | StacksPage |
| `/stacks/:name` | StackDetailPage |
| `/stacks/:name/edit` | StackEditorPage |
| `/files` | FilesPage |
| `/terminal` | TerminalPage |
| `/tasks` | TasksPage |
| `/tasks/new` | TaskEditorPage |
| `/tasks/:id` | TaskEditorPage |
| `/settings` | SettingsPage |
| `*` | NotFoundPage |

## 6. 依赖清单（脚手架照此创建）

### 6.1 server/shared

`dependencies`: `zod@^4.6.7`。
`devDependencies`: `typescript@5.9.3`。

### 6.2 server/worker

`dependencies`：
`@fastify/cors@^11.4.3`、`@fastify/multipart@^10.1.9`、`@fastify/websocket@^11.3.7`、`fastify@^5.12.8`、`ioredis@^6.1.0`、`pg@^8.23.1`、`croner@^11.0.1`、`ws@^8.23.0`、`@mpanel/shared@workspace:*`。
`optionalDependencies`: `node-pty@^1.1.0`。
`devDependencies`: `@types/node@^24.19.3`、`@types/pg@^8.23.1`、`@types/ws@^8.18.2`、`tsx@^4.23.15`、`typescript@5.9.3`。

### 6.3 server/core

`dependencies`：
`@fastify/cors@^11.4.3`、`@fastify/static@^10.1.12`、`@fastify/websocket@^11.3.7`、`fastify@^5.12.8`、`ws@^8.23.0`、`@mpanel/shared@workspace:*`。
`devDependencies`：`@types/node@^24.19.3`、`@types/ws@^8.18.2`、`tsx@^4.23.15`、`typescript@5.9.3`。

### 6.4 web

`dependencies`：
`react@18.3.1`、`react-dom@18.3.1`、`react-router-dom@^6.30.6`、`@tanstack/react-query@^5.108.4`、`zustand@^5.1.0`、`xterm@5.3.0`、`@xterm/addon-fit@^0.11.0`、`lucide-react@^1.80.0`、`@uiw/react-codemirror@^4.25.13`。
`devDependencies`：
`vite@^6.4.6`、`@vitejs/plugin-react@^4.7.0`、`tailwindcss@^3.4.19`、`postcss@^8.5.6`、`autoprefixer@^10.4.21`、`typescript@5.9.3`、`@types/react@^18.3.32`、`@types/react-dom@^18.3.7`、`@types/node@^24.19.3`。

> 固定栈未列 `ws`（`@fastify/websocket` 的底层，core/worker 直接使用）、`react-router-dom`（路由，不是 UI 组件库）、`tsx`（dev 运行 TS）。已在 architecture §14 记录为补充依赖。不引入任何 UI 组件库。

## 7. 构建顺序与依赖方向

```
shared (tsc) ──> worker (tsc) ──> deploy
      └────────> core (tsc)  ──> deploy
web (vite) ──独立──> core static 或任意静态服务器
scripts/check, smoke ──> 依赖全部 dist
```

- shared 只能依赖 zod；core/worker 可依赖 shared；web 不得依赖 shared。
- 模块间：worker 模块不得互相 import；共享能力（paths/store/exec）在 worker 核心。core 的 auth 与 machines 通过 `MachineService`/`AuthService` 注入，不互相 import 实现。
- 页面间不互相 import；共享 UI 在 `web/src/components`。

## 8. 禁止事项（合并自 13 条轨道）

1. 不新增 owner，不跨目录写文件；需要新文件先改本表。
2. 不改 `server/shared` 的字段/错误码/帧 kind 而不改文档；shared 由架构轨道统一改。
3. web 不 import server 代码/types；只 import `web/src/api/types.ts`。
4. worker/core 不拼接 shell 字符串；任务 shell 例外仅 `tasks/runner.ts`。
5. 不把 worker token、core 密码、DB 密码、machine secret 写入日志或 URL；worker token 默认 sessionStorage，localStorage 必须显式 opt-in 并警告；连接对象本身不含 token。
6. 不在 stdio 模式的 stdout 打印日志/调试。
7. 不让 core 代理泄露 cookie/authorization 给 worker。
8. 不在 `web/src/pages` 之间共享文件；共享组件上移。
9. 不引入 UI 组件库、vitest/jest、原生数据库依赖。
10. 不把 Caddyfile 原文作为站点输入；只走结构化配置。

## 9. 实现轨道启动顺序建议

1. `脚手架` 创建 workspace/包清单/tsconfig；`架构` 的 shared 已就绪。
2. `worker 核心`（config/http/auth/registry/capabilities/exec/paths/store/transports）先行；其他 worker 轨道可并行写模块，但联合调试依赖核心。
3. `core 认证与网关` 与 `core 主机与代理` 并行，接口以 §3/§5.1 为准。
4. `前端外壳` 先出连接/布局/类型/客户端；页面轨道并行。
5. `集成` 最后跑 check/smoke，修跨端契约。

若出现接口不一致，按 `docs/api-contract.md` > `docs/protocol.md` > 本文件 > `docs/architecture.md` 裁决，并以 `server/shared` 的实现类型为准；先改契约，再改实现。

## 10. 实现注意事项（跨轨道踩坑清单）

1. **路由顺序/重叠**：Fastify/find-my-way 对静态段优先于参数段，但为可读性仍把 `GET /sites/export`、`GET /tasks/runs`、`GET /files/roots`、`GET /databases/backups/:id` 等静态路由注册在 `/:id` 之前；`GET /tasks/runs` 与 `GET /tasks/:id` 同层，必须确认 `runs` 不被当成任务 id。core 的代理 HTTP wildcard `/api/v1/machines/:id/proxy/*` 不得吞掉 `/proxy/ws/*`：WS 用更具体的 `GET .../proxy/ws/*`（`websocket:true`）注册，HTTP handler 对 `/ws/` 后缀返回 404；worker 的 `/ws/*` gateway 同理。
2. **全局鉴权作用域/例外**：REST hook 只挂 `/api/v1` 子作用域；core 精确放行 `POST /api/v1/auth/login` 与 `POST /api/v1/machines/:id/proxy/databases/handoff/redeem`，worker 精确放行 `POST /api/v1/databases/handoff/redeem`。`/healthz`、core 静态、`/ws/worker`、worker `/ws/*`、core 代理 WS 不挂 REST hook；`/ws/worker` 用 machine secret，WS gateway 自己消费 ticket/token。generic proxy 路由不得在 hook 之前读 body。
3. **core 代理 parser/body**：core 不要注册 `@fastify/multipart`；代理路由放在独立封装插件，加 catch-all no-op content-type parser、route `bodyLimit>=110 MiB`，只从 `req.raw` 读原始 body；否则默认 JSON 1.2 MiB/multipart 415 会破坏上传。413/415/404 统一错误处理器映射为 BAD_REQUEST/NOT_FOUND 信封。worker 全局 JSON 8 MiB、files/write 20 MiB、multipart 100 MiB。
4. **stdio/reverse-ws 的 loopback**：只允许 `127.0.0.1`；传输必须先 `listen({port:0})` 取得端口再创建 TunnelBridge（不能提前构造）；桥必须带 `Authorization: Bearer <MPANEL_TOKEN>` 调 loopback HTTP、`?token=` 调 loopback WS，否则 worker auth 会拒绝。不要直接调用 WsBridge 绕过 loopback 鉴权；端口不能配置成 `0.0.0.0`。
5. **stdio stdout**：`index.ts` 的 `token generate`/help、`transports/http.ts` 的 listening JSON 是唯一允许写 stdout 的地方；其余一律 stderr/pino。check 脚本按此白名单 grep。
6. **JSON store 锁**：worker 用 `state/.worker.lock`、core 用 `state/.core.lock`（可按角色共享 `MPANEL_HOME`）；同角色测试/冒烟必须使用独立 `MPANEL_HOME`，否则第二个进程会退出。core/worker 共享 home 时 `secrets.key` 必须 `open(...,'wx',0o600)` 原子创建，EEXIST 读取已有，避免各生成一把 key 导致密文不可解。
7. **Windows 路径**：路径前缀比较用 `path.relative` + 大小写归一化；不要用字符串 `startsWith`。Caddy 目录替换按 architecture §8.1 的“旧目录改名→新目录改名”处理，失败回滚。
8. **证书扫描**：只解析 `.crt`/`.pem` 中的 `CERTIFICATE` 块；遇到私钥/损坏文件跳过，不可让单个文件使列表 500。caddy 二进制缺失不影响扫描 data 目录。
9. **Redis 恢复**：`logical` 备份可在线 `RESTORE`；`rdb` 只能离线恢复，API 必须返回 `UNAVAILABLE` 而不是尝试 `CONFIG SET`/`DEBUG RELOAD`。
10. **图片 pull**：core 代理与 web client 对该路由单独 620 s 超时；其他 API 保持 120 s。
11. **WS ticket 绑定**：规范化 `path + 业务 query`（剔除 `ticket`/`token`，其余参数排序）后比较；前端取票与建连的业务参数必须一致，连接 URL 额外带 ticket 不影响匹配。
12. **前端查询键**：`api/*` 文件集中定义 query keys；切换连接/机器时 `queryClient.clear()`，避免旧机器数据串台。
13. **包清单所有权**：`server/shared/package.json` 已由架构轨道创建，脚手架不要覆盖其 exports/依赖；其余包清单由脚手架创建。
14. **共享类型变更**：任何 shared 字段/枚举/错误码变更都必须同时更新 `docs/api-contract.md`、`docs/protocol.md`、`server/shared/src` 和 `web/src/api/types.ts` 镜像；否则 check 失败。
15. **能力探测缓存**：`createCapabilityService` 的 30 s 缓存必须在 `system/info?refresh=1` 和模块写操作前可强制刷新；探测命令失败不能抛出到 Fastify 全局错误处理器。
16. **代理头/凭据/query**：core 不透传 `set-cookie`，worker 不依赖 `x-forwarded-*` 做授权；代理 HTTP/WS 必须转发**原始 query 字符串**（保留重复参数与编码），不要用 Fastify 解析后的对象重建；代理 WS 连接 worker 前移除用户 `ticket`/`token`，并透传关闭码。
17. **一次性 secret UI**：reverse-ws enrollment、secret rotate、terminal ticket、handoff ticket 都只显示/使用一次；前端不得把 secret 写入全局 store 持久化。
18. **任务进程树**：超时/删除任务必须 kill 整个进程树（Windows `taskkill /T /F`，POSIX `process.kill(-pid)` 或递归），避免遗留子进程。
19. **终端 WS 断开不杀 PTY**：只有 DELETE 会话或空闲 GC 才 kill；WS 重连使用新 ticket。
20. **dbx iframe**：CSP/`sandbox` 需允许 dbx 源与脚本；`VITE_DBX_URL` 缺失时不得让数据库页崩溃，只禁用 iframe。

21. **模块前缀**：`ModuleRegistration.prefixes` 是数组；registry 只在 `/api/v1` 挂一次，模块注册完整路径。containers 必须能在同一个 `register()` 中注册 `/containers`、`/images`、`/stacks`，不要按单个 prefix 自动包一层。
22. **能力不得快照**：模块 context 的 `capabilities` 是 `CapabilityProvider`；写前 `await ctx.capabilities.get(true)`，列表用 `get()`。`requires` 只做诊断，不得在注册期拒绝启动。
23. **代理 mapper**：`mapProxyHttpRequest(rawUrl)` / `mapProxyWsRequest(rawUrl)` 接收 `req.raw.url`，保留原始 query（重复参数/编码），只剥离 core 前缀与用户 ticket/token；不要用 Fastify 解析后的 query 对象重建。
24. **WsBridge**：`open` 抛 `PanelError`；direct adapter 用 `wsCloseCodeForError`，tunnel adapter 用 `wsHttpStatusForError` + accepted:false。open 的 `path` 是 pathname，`rawQuery` 单独传；不要把 query 拼进 pathname 或丢重复参数。
25. **handoff**：ticket 只放 JSON body；redeem 路径固定 `/databases/handoff/redeem`；core/worker 日志与 audit 只记录 ticket 哈希前 8 位，禁止 body/URL secret；限速默认 10/min，超限 401 + retryAfterSec。
26. **desiredState**：Machine 输出必须有 `desiredState`；connect 设 running，disconnect 设 stopped；驱动只在 `enabled && desiredState==='running'` 时启动/重连。PATCH 不改 desiredState，只改 enabled/连接参数。
27. **Audit 注入**：`CoreAppDeps`、`registerMachineRoutes`、`registerProxyRoutes` 都必须接收 `AuditLog`；机器创建/删除/轮换与代理写请求在签名内写审计，不能靠全局 hook 猜 machine id。
28. **静态安全头**：core `registerStatic` 与 deploy Caddy 都必须设置 CSP（frame-src 含 dbx）、nosniff、Referrer-Policy；smoke 断言头存在。
29. **发布物**：core/worker 必须用 `pnpm deploy` 产出 dist+生产 node_modules；systemd/README 不得只复制 dist。smoke 在空 cwd 运行 deploy 产物验证 @mpanel/shared/zod 可解析。
30. **类型镜像**：`web/src/api/types.ts` 必须覆盖 API §15 `// TypeName` 全部名称；check 逐名校验，页面轨道不得各自复制/改写共享类型。

## 边缘节点（v0.2 新增，owner 见下）

| 路径 | owner | 说明 |
|---|---|---|
| `server/shared/src/{schemas,models,index}.ts` | 边缘节点后端 | 只做新增：EdgeKey / EdgeJob / SystemSnapshot；Machine 增加 edge/group/edgeKeyId/snapshot |
| `server/core/src/edge/` | 边缘节点后端 | keys store、EdgeService、/edge 路由、作业调度循环、快照刷新 |
| `server/core/src/machines/{service,store,types,routes}.ts` | 边缘节点后端 | 记录字段与快照写入；PATCH 支持 group |
| `server/core/src/app.ts` | 边缘节点后端 | 挂载 /edge 与服务生命周期 |
| `server/worker/src/edge/` | 边缘节点后端 | 入网客户端与 `edge.json` 身份存储 |
| `server/worker/src/modules/system/` | 边缘节点后端 | `/system/snapshot`、`/system/metrics` |
| `web/src/pages/edge/` | 边缘节点与概览前端 | 边缘节点页 |
| `web/src/pages/dashboard/` | 边缘节点与概览前端 | 1Panel 风格概览 |
| `web/src/api/{edge.ts,system.ts,types.ts}` | 边缘节点与概览前端 | 契约镜像新增 |

边缘相关的额外约束：

31. **入网不新增帧**：边缘注册只能走 `POST /api/v1/edge/enroll` + 既有 `/ws/worker` 握手；不要改 `protocol.ts` 的帧集合。
32. **身份持久化**：worker 的 `edge.json` 必须 0600、原子写；secret 不得出现在日志、`doctor` 输出与错误响应里。
33. **作业串行**：同一机器的边缘作业必须串行执行；离线保持 `pending`，重连后按 `createdAt` 升序补跑；结果截断 16KB 并标 `truncated`。
34. **快照失败不改变节点状态**：快照失败只记 `lastError`，不得把 online 节点标成 offline。
