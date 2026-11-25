/**
 * TypeScript mirrors of the zod schemas in schemas.ts and the tunnel protocol.
 * Models are inferred from a single source of truth so the worker, core and
 * generated API documentation cannot drift.
 */
import type { z } from 'zod';
import type * as S from './schemas.js';

/* -------------------------------- Common -------------------------------- */

export interface ListResult<T> {
  available: boolean;
  reason?: string;
  items: T[];
  nextCursor?: string | null;
  total?: number;
}

export interface PageQuery {
  limit?: number;
  cursor?: string;
}

export type SystemRole = z.infer<typeof S.systemRoleSchema>;
export type SystemInfo = z.infer<typeof S.systemInfoSchema>;
export type MachineCounts = z.infer<typeof S.machineCountsSchema>;
export type SystemOverview = z.infer<typeof S.systemOverviewSchema>;

/* --------------------------------- Sites -------------------------------- */

export type SiteDomain = z.infer<typeof S.siteDomainSchema>;
export type SiteLoadBalance = z.infer<typeof S.siteLoadBalanceSchema>;
export type ReverseProxyHandler = z.infer<typeof S.reverseProxyHandlerSchema>;
export type FileServerHandler = z.infer<typeof S.fileServerHandlerSchema>;
export type RedirectHandler = z.infer<typeof S.redirectHandlerSchema>;
export type SiteHandler = z.infer<typeof S.siteHandlerSchema>;
export type SiteTls = z.infer<typeof S.siteTlsSchema>;
export type SiteConfig = z.infer<typeof S.siteConfigSchema>;
export type SiteStatus = z.infer<typeof S.siteStatusSchema>;
export type SiteApplySummary = z.infer<typeof S.siteApplySummarySchema>;
export type Site = z.infer<typeof S.siteSchema>;
export type SiteCreateInput = z.input<typeof S.siteCreateSchema>;
export type SiteUpdateInput = z.input<typeof S.siteUpdateSchema>;
export type SitePreviewRequest = z.input<typeof S.sitePreviewRequestSchema>;
export type SitePreviewResult = z.infer<typeof S.sitePreviewResultSchema>;
export type SiteApplyRequest = z.input<typeof S.siteApplyRequestSchema>;
export type SiteApplyResult = z.infer<typeof S.siteApplyResultSchema>;
export type SiteExportBundle = z.infer<typeof S.siteExportBundleSchema>;
export type SiteImportRequest = z.input<typeof S.siteImportRequestSchema>;
export type SiteImportResult = z.infer<typeof S.siteImportResultSchema>;

/* ------------------------------ Certificates ---------------------------- */

export type CertificateStatus = z.infer<typeof S.certificateStatusSchema>;
export type CertificateInfo = z.infer<typeof S.certificateSchema>;

/* -------------------------------- Database ------------------------------ */

export type DatabaseKind = z.infer<typeof S.databaseKindSchema>;
export type DatabaseCheck = z.infer<typeof S.databaseCheckSchema>;
export type DatabaseProfile = z.infer<typeof S.databaseProfileSchema>;
export type DatabaseProfileCreateInput = z.input<typeof S.databaseProfileCreateSchema>;
export type DatabaseProfileUpdateInput = z.input<typeof S.databaseProfileUpdateSchema>;
export type DatabaseTestResult = z.infer<typeof S.databaseTestResultSchema>;
export type HandoffRequest = z.input<typeof S.handoffRequestSchema>;
export type HandoffRedeemRequest = z.infer<typeof S.handoffRedeemRequestSchema>;
export type HandoffTicket = z.infer<typeof S.handoffTicketSchema>;
export type HandoffPayload = z.infer<typeof S.handoffPayloadSchema>;
export type PostgresStats = z.infer<typeof S.postgresStatsSchema>;
export type RedisStats = z.infer<typeof S.redisStatsSchema>;
export type DatabaseStats = z.infer<typeof S.databaseStatsSchema>;
export type BackupFormat = z.infer<typeof S.backupFormatSchema>;
export type BackupRequest = z.input<typeof S.backupRequestSchema>;
export type BackupRecord = z.infer<typeof S.backupRecordSchema>;
export type RestoreRequest = z.input<typeof S.restoreRequestSchema>;
export type DatabaseJob = z.infer<typeof S.databaseJobSchema>;

/* ------------------------------- Containers ----------------------------- */

export type ContainerPort = z.infer<typeof S.containerPortSchema>;
export type ContainerSummary = z.infer<typeof S.containerSummarySchema>;
export type ContainerMount = z.infer<typeof S.containerMountSchema>;
export type ContainerDetail = z.infer<typeof S.containerDetailSchema>;
export type ContainerStats = z.infer<typeof S.containerStatsSchema>;
export type ContainerActionInput = z.input<typeof S.containerActionSchema>;
export type ExecRequest = z.input<typeof S.execRequestSchema>;
export type ExecResult = z.infer<typeof S.execResultSchema>;
export type ImageSummary = z.infer<typeof S.imageSummarySchema>;
export type ImagePullRequest = z.input<typeof S.imagePullRequestSchema>;
export type ImagePruneRequest = z.input<typeof S.imagePruneRequestSchema>;
export type StackSummary = z.infer<typeof S.stackSummarySchema>;
export type StackDetail = z.infer<typeof S.stackDetailSchema>;
export type StackCreateInput = z.input<typeof S.stackCreateSchema>;
export type StackUpdateInput = z.input<typeof S.stackUpdateSchema>;
export type StackActionInput = z.input<typeof S.stackActionSchema>;

/* --------------------------------- Files -------------------------------- */

export type FileRootName = z.infer<typeof S.fileRootNameSchema>;
export type FileType = z.infer<typeof S.fileTypeSchema>;
export type FileRoot = z.infer<typeof S.fileRootSchema>;
export type FileItem = z.infer<typeof S.fileItemSchema>;
export type FileListResult = z.infer<typeof S.fileListResultSchema>;
export type FileSearchResult = z.infer<typeof S.fileSearchResultSchema>;
export type FileReadResult = z.infer<typeof S.fileReadResultSchema>;
export type FileWriteRequest = z.input<typeof S.fileWriteRequestSchema>;
export type FileMkdirRequest = z.input<typeof S.fileMkdirRequestSchema>;
export type FileRenameRequest = z.input<typeof S.fileRenameRequestSchema>;
export type FileCopyRequest = z.input<typeof S.fileCopyRequestSchema>;
export type FileChmodRequest = z.input<typeof S.fileChmodRequestSchema>;
export type FileDeleteQuery = z.input<typeof S.fileDeleteQuerySchema>;
export type TrashEntry = z.infer<typeof S.trashEntrySchema>;
export type TrashRestoreRequest = z.input<typeof S.trashRestoreRequestSchema>;
export type TrashEmptyRequest = z.input<typeof S.trashEmptyRequestSchema>;
export type FileUploadQuery = z.input<typeof S.fileUploadQuerySchema>;
export type FileDownloadQuery = z.input<typeof S.fileDownloadQuerySchema>;
export type FileArchiveRequest = z.input<typeof S.fileArchiveRequestSchema>;
export type FileExtractRequest = z.input<typeof S.fileExtractRequestSchema>;
export type FileSearchQuery = z.input<typeof S.fileSearchQuerySchema>;
export type FileArchiveResult = z.infer<typeof S.fileArchiveResultSchema>;
export type FileExtractResult = z.infer<typeof S.fileExtractResultSchema>;

/* -------------------------------- Terminal ------------------------------ */

export type TerminalSession = z.infer<typeof S.terminalSessionSchema>;
export type TerminalCreateInput = z.input<typeof S.terminalCreateSchema>;
export type ShellInfo = z.infer<typeof S.shellInfoSchema>;
export type TerminalClientMessage = z.infer<typeof S.terminalClientMessageSchema>;
export type TerminalServerMessage = z.infer<typeof S.terminalServerMessageSchema>;
export type ContainerLogsQuery = z.input<typeof S.containerLogsQuerySchema>;
export type ContainerLogsClientMessage = z.infer<typeof S.containerLogsClientMessageSchema>;
export type ContainerLogsServerMessage = z.infer<typeof S.containerLogsServerMessageSchema>;

/* ---------------------------------- Tasks ------------------------------- */

export type TaskOverlap = z.infer<typeof S.taskOverlapSchema>;
export type TaskRunStatus = z.infer<typeof S.taskRunStatusSchema>;
export type TaskRunSummary = z.infer<typeof S.taskRunSummarySchema>;
export type TaskRun = z.infer<typeof S.taskRunSchema>;
export type Task = z.infer<typeof S.taskSchema>;
export type TaskCreateInput = z.input<typeof S.taskCreateSchema>;
export type TaskUpdateInput = z.input<typeof S.taskUpdateSchema>;
export type TaskRunNowResult = z.infer<typeof S.taskRunNowResultSchema>;
export type TaskNextRunsResult = z.infer<typeof S.taskNextRunsResultSchema>;

/* --------------------------------- Machines ----------------------------- */

export type MachineTransport = z.infer<typeof S.machineTransportSchema>;
export type MachineStatus = z.infer<typeof S.machineStatusSchema>;
export type MachineDesiredState = z.infer<typeof S.machineSchema>['desiredState'];
export type Machine = z.infer<typeof S.machineSchema>;
export type MachineCreateInput = z.input<typeof S.machineCreateSchema>;
export type MachineUpdateInput = z.input<typeof S.machineUpdateSchema>;
export type MachineEnrollment = z.infer<typeof S.machineEnrollmentSchema>;
export type MachineCreateResult = z.infer<typeof S.machineCreateResultSchema>;
export type MachineTestResult = z.infer<typeof S.machineTestResultSchema>;
export type MachineHealth = z.infer<typeof S.machineHealthSchema>;

/* --------------------------------- Edge --------------------------------- */

export type SystemSnapshot = z.infer<typeof S.systemSnapshotSchema>;
export type SystemMetrics = z.infer<typeof S.systemMetricsSchema>;
export type EdgeKey = z.infer<typeof S.edgeKeySchema>;
export type EdgeKeyCreateInput = z.input<typeof S.edgeKeyCreateSchema>;
export type EdgeKeyCreateResult = z.infer<typeof S.edgeKeyCreateResultSchema>;
export type EdgeEnrollRequest = z.input<typeof S.edgeEnrollRequestSchema>;
export type EdgeEnrollResult = z.infer<typeof S.edgeEnrollResultSchema>;
export type EdgeJobKind = z.infer<typeof S.edgeJobKindSchema>;
export type EdgeJobStatus = z.infer<typeof S.edgeJobStatusSchema>;
export type EdgeJob = z.infer<typeof S.edgeJobSchema>;
export type EdgeJobCreateInput = z.input<typeof S.edgeJobCreateSchema>;

/* ---------------------------------- Auth -------------------------------- */

export type AuthUser = z.infer<typeof S.authUserSchema>;
export type LoginInput = z.input<typeof S.loginRequestSchema>;
export type LoginResult = z.infer<typeof S.loginResultSchema>;
export type AuthMe = z.infer<typeof S.authMeSchema>;
export type ChangePasswordInput = z.input<typeof S.changePasswordRequestSchema>;
export type WsTicketRequest = z.input<typeof S.wsTicketRequestSchema>;
export type WsTicket = z.infer<typeof S.wsTicketSchema>;
