import { z } from 'zod';
import { capabilitiesSchema } from './capabilities.js';
import { ERROR_CODES } from './errors.js';
import { workerDescriptorSchema } from './protocol.js';

/* ------------------------------------------------------------------ */
/* Common                                                              */
/* ------------------------------------------------------------------ */

export const isoDateTimeSchema = z.string().datetime();
export const idSchema = z.string().min(1).max(128);
export const displayNameSchema = z.string().min(1).max(120);

const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

/** Absolute or relative host path (terminal/task cwd, Caddy root). No control chars. */
export const hostPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !CONTROL_CHAR_PATTERN.test(value), 'Path may not contain control characters');

/** Absolute host path for Caddy file_server.root. */
export const absoluteHostPathSchema = hostPathSchema.refine(
  (value) => /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(value),
  'Path must be absolute',
);

/** Root-relative, POSIX-style virtual path used by file APIs. */
export const virtualFilePathSchema = z
  .string()
  .max(4096)
  .refine((value) => !CONTROL_CHAR_PATTERN.test(value), 'Path may not contain control characters')
  .refine((value) => !value.includes('\\'), 'Virtual paths use / separators only')
  .refine((value) => !value.startsWith('//'), 'Virtual paths may not be UNC paths')
  .refine((value) => !/^[A-Za-z]:/.test(value), 'Virtual paths may not contain drive letters')
  .refine(
    (value) => !value.split('/').some((segment) => segment === '..'),
    'Virtual paths may not contain .. segments',
  );

export const booleanQuerySchema = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).max(512).optional(),
});

export function listResultSchema<T extends z.ZodType>(itemSchema: T) {
  return z.object({
    available: z.boolean(),
    reason: z.string().optional(),
    items: z.array(itemSchema),
    nextCursor: z.string().nullable().optional(),
    total: z.number().int().nonnegative().optional(),
  });
}

export const okResultSchema = z.object({ ok: z.boolean() });

/* ------------------------------------------------------------------ */
/* System                                                              */
/* ------------------------------------------------------------------ */

export const systemRoleSchema = z.enum(['worker', 'core']);

export const systemInfoSchema = z.object({
  role: systemRoleSchema,
  name: z.string().min(1),
  version: z.string().min(1),
  apiVersion: z.literal(1),
  protocolVersion: z.literal(1),
  nodeVersion: z.string().min(1),
  platform: z.string().min(1),
  arch: z.string().min(1),
  hostname: z.string().min(1),
  startedAt: isoDateTimeSchema,
  uptimeSec: z.number().nonnegative(),
  capabilities: capabilitiesSchema,
  worker: workerDescriptorSchema.optional(),
  features: z.object({
    dbxHandoff: z.boolean(),
    websocket: z.boolean(),
    pty: z.boolean(),
  }),
  paths: z
    .object({
      home: z.string(),
      caddyConfig: z.string().optional(),
      caddyData: z.string().optional(),
      filesRoots: z.array(z.string()).optional(),
      backups: z.string().optional(),
      stacks: z.string().optional(),
    })
    .optional(),
});

export const machineCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  online: z.number().int().nonnegative(),
  offline: z.number().int().nonnegative(),
  starting: z.number().int().nonnegative(),
  degraded: z.number().int().nonnegative(),
  error: z.number().int().nonnegative(),
});

export const systemOverviewSchema = z.object({
  core: systemInfoSchema,
  machines: machineCountsSchema,
  workers: z.array(z.lazy(() => machineSchema)),
  generatedAt: isoDateTimeSchema,
});

/* ------------------------------------------------------------------ */
/* Sites                                                               */
/* ------------------------------------------------------------------ */

/**
 * Hostname, optional leading wildcard label, or "localhost". IDN, IP literals
 * and trailing dots are rejected in v1. Caddy site addresses are built from
 * this value, so it is also the primary Caddyfile injection boundary.
 */
export const SITE_DOMAIN_PATTERN =
  /^(?:\*\.)?(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

export const siteDomainSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(SITE_DOMAIN_PATTERN, 'Invalid domain; use hostnames, localhost, or a leading *.');

/** Caddy bind address, e.g. ":8443", "127.0.0.1:8443", "[::1]:8443". */
export const siteListenSchema = z
  .string()
  .max(128)
  .regex(/^(?::\d{1,5}|(?:\[[0-9a-fA-F:]+\]|[0-9.]+):\d{1,5})$/, 'Invalid listen address');

export const siteLoadBalanceSchema = z.enum(['round_robin', 'random', 'least_conn', 'uri_hash']);

export const siteHeaderNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/, 'Invalid HTTP header name');

export const siteHeaderValueSchema = z
  .string()
  .max(4096)
  .refine((value) => !CONTROL_CHAR_PATTERN.test(value), 'Header values may not contain control characters');

export const siteHeadersSchema = z.record(siteHeaderNameSchema, siteHeaderValueSchema);

/** Single-line Caddy token text; quoteCaddyToken() additionally escapes quotes/backslashes. */
export const caddyTokenTextSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !CONTROL_CHAR_PATTERN.test(value), 'Caddy value may not contain control characters');

export const caddyUpstreamSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (value) => !/[\s\u0000-\u001f\u007f"'{}]/.test(value),
    'Invalid upstream; whitespace, quotes, braces and control characters are rejected',
  );

export const caddyHealthUriSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine(
    (value) => !/[\s\u0000-\u001f\u007f"'{}]/.test(value),
    'Invalid health URI; whitespace, quotes, braces and control characters are rejected',
  );

export const reverseProxyHandlerSchema = z.object({
  type: z.literal('reverse_proxy'),
  upstreams: z.array(caddyUpstreamSchema).min(1).max(32),
  loadBalance: siteLoadBalanceSchema.optional(),
  headers: siteHeadersSchema.optional(),
  websocket: z.boolean().optional(),
  tlsSkipVerify: z.boolean().optional(),
  healthUri: caddyHealthUriSchema.optional(),
});

export const fileServerHandlerSchema = z.object({
  type: z.literal('file_server'),
  root: absoluteHostPathSchema,
  indexNames: z.array(caddyTokenTextSchema.max(255)).max(10).optional(),
  browse: z.boolean().optional(),
  spa: z.boolean().optional(),
  precompressed: z.array(z.enum(['gzip', 'zstd'])).max(2).optional(),
});

export const redirectHandlerSchema = z.object({
  type: z.literal('redirect'),
  to: z
    .string()
    .min(1)
    .max(2048)
    .refine(
      (value) => !CONTROL_CHAR_PATTERN.test(value) && !/["\r\n]/.test(value),
      'Redirect target may not contain control characters or quotes',
    ),
  permanent: z.boolean().optional(),
  preserveQuery: z.boolean().optional(),
});

export const siteHandlerSchema = z.discriminatedUnion('type', [
  reverseProxyHandlerSchema,
  fileServerHandlerSchema,
  redirectHandlerSchema,
]);

export const siteTlsSchema = z.object({
  mode: z.enum(['auto', 'internal', 'off']),
  email: z.string().email().max(320).optional(),
});

export const siteConfigSchema = z.object({
  domains: z.array(siteDomainSchema).min(1).max(50),
  listen: z.array(siteListenSchema).max(8).optional(),
  handler: siteHandlerSchema,
  tls: siteTlsSchema.optional(),
  headers: siteHeadersSchema.optional(),
  encode: z.array(z.enum(['gzip', 'zstd'])).max(2).optional(),
  log: z.boolean().optional(),
});

export const siteStatusSchema = z.enum(['draft', 'pending', 'applied', 'error', 'disabled']);

export const siteApplySummarySchema = z.object({
  at: isoDateTimeSchema,
  ok: z.boolean(),
  revision: z.number().int().nonnegative(),
  error: z.string().optional(),
  caddyfileHash: z.string().optional(),
});

export const siteSchema = z.object({
  id: idSchema,
  name: displayNameSchema,
  enabled: z.boolean(),
  config: siteConfigSchema,
  revision: z.number().int().nonnegative(),
  appliedRevision: z.number().int().nonnegative().nullable(),
  status: siteStatusSchema,
  lastApply: siteApplySummarySchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export const siteCreateSchema = z.object({
  name: displayNameSchema,
  enabled: z.boolean().optional(),
  config: siteConfigSchema,
});

export const siteUpdateSchema = z
  .object({
    name: displayNameSchema.optional(),
    enabled: z.boolean().optional(),
    config: siteConfigSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const sitePreviewRequestSchema = z
  .object({
    site: siteConfigSchema.optional(),
    siteId: idSchema.optional(),
    validate: z.boolean().optional(),
  })
  .refine((value) => (value.site === undefined) !== (value.siteId === undefined), {
    message: 'Provide exactly one of site or siteId',
  });

export const sitePreviewResultSchema = z.object({
  caddyfile: z.string(),
  warnings: z.array(z.string()),
  validation: z
    .object({
      ok: z.boolean(),
      output: z.string(),
    })
    .nullable(),
  validationUnavailableReason: z.string().optional(),
});

export const siteApplyRequestSchema = z.object({
  siteIds: z.array(idSchema).max(200).optional(),
  force: z.boolean().optional(),
});

export const siteApplyResultSchema = z.object({
  revision: z.number().int().nonnegative(),
  appliedAt: isoDateTimeSchema,
  caddyfilePath: z.string(),
  backupPath: z.string().nullable(),
  reloaded: z.boolean(),
  rolledBack: z.boolean(),
  sites: z.array(
    z.object({
      id: idSchema,
      name: z.string(),
      status: siteStatusSchema,
    }),
  ),
  warnings: z.array(z.string()),
  caddyOutput: z.string(),
});

export const siteExportBundleSchema = z.object({
  version: z.literal(1),
  exportedAt: isoDateTimeSchema,
  sites: z.array(
    z.object({
      name: displayNameSchema,
      enabled: z.boolean(),
      config: siteConfigSchema,
    }),
  ),
});

export const siteImportRequestSchema = z.object({
  bundle: siteExportBundleSchema,
  mode: z.enum(['merge', 'replace']).optional(),
});

export const siteImportResultSchema = z.object({
  imported: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  errors: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      name: z.string().optional(),
      message: z.string(),
    }),
  ),
});

/* ------------------------------------------------------------------ */
/* Certificates                                                        */
/* ------------------------------------------------------------------ */

export const certificateStatusSchema = z.enum(['valid', 'expiring', 'expired', 'unknown']);

export const certificateSchema = z.object({
  id: z.string().min(1),
  domains: z.array(z.string()),
  commonName: z.string().nullable(),
  issuer: z.string(),
  subject: z.string(),
  notBefore: isoDateTimeSchema,
  notAfter: isoDateTimeSchema,
  daysRemaining: z.number().int(),
  serialNumber: z.string(),
  fingerprintSha256: z.string(),
  keyType: z.string().nullable(),
  source: z.enum(['local', 'acme', 'unknown']),
  path: z.string(),
  status: certificateStatusSchema,
});

/* ------------------------------------------------------------------ */
/* Databases                                                           */
/* ------------------------------------------------------------------ */

export const databaseKindSchema = z.enum(['postgres', 'redis']);

export const databaseCheckSchema = z.object({
  at: isoDateTimeSchema,
  ok: z.boolean(),
  latencyMs: z.number().nonnegative(),
  serverVersion: z.string().optional(),
  message: z.string().optional(),
});

export const databaseProfileSchema = z.object({
  id: idSchema,
  name: displayNameSchema,
  kind: databaseKindSchema,
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().nullable(),
  database: z.string().nullable(),
  tls: z.boolean(),
  redisDb: z.number().int().min(0).max(15).nullable(),
  hasPassword: z.boolean(),
  lastCheck: databaseCheckSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export const databaseProfileCreateSchema = z.object({
  name: displayNameSchema,
  kind: databaseKindSchema,
  host: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().max(255).optional(),
  password: z.string().max(1024).optional(),
  database: z.string().max(255).optional(),
  tls: z.boolean().optional(),
  redisDb: z.number().int().min(0).max(15).optional(),
});

export const databaseProfileUpdateSchema = z
  .object({
    name: displayNameSchema.optional(),
    host: z.string().min(1).max(255).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    username: z.string().max(255).nullable().optional(),
    password: z.string().max(1024).nullable().optional(),
    database: z.string().max(255).nullable().optional(),
    tls: z.boolean().optional(),
    redisDb: z.number().int().min(0).max(15).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const databaseTestResultSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().nonnegative(),
  serverVersion: z.string().optional(),
  message: z.string().optional(),
});

export const handoffRequestSchema = z.object({
  ttlSec: z.number().int().min(10).max(300).optional(),
});

export const handoffRedeemRequestSchema = z.object({
  ticket: z.string().min(16).max(512),
});

export const handoffTicketSchema = z.object({
  ticket: z.string().min(16),
  expiresAt: isoDateTimeSchema,
  redeemUrl: z.string().min(1),
  kind: databaseKindSchema,
});

export const handoffPayloadSchema = z.object({
  profileId: idSchema,
  name: z.string(),
  kind: databaseKindSchema,
  host: z.string(),
  port: z.number().int(),
  username: z.string().nullable(),
  password: z.string().nullable(),
  database: z.string().nullable(),
  tls: z.boolean(),
  redisDb: z.number().int().nullable(),
  connectionString: z.string().optional(),
});

export const postgresStatsSchema = z.object({
  kind: z.literal('postgres'),
  version: z.string(),
  uptimeSec: z.number().nonnegative(),
  connections: z.object({
    total: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    idle: z.number().int().nonnegative(),
    idleInTransaction: z.number().int().nonnegative(),
  }),
  databaseSizeBytes: z.number().nonnegative(),
  cacheHitRatio: z.number().nullable(),
  transactionsPerSec: z.number().nullable().optional(),
});

export const redisStatsSchema = z.object({
  kind: z.literal('redis'),
  version: z.string(),
  uptimeSec: z.number().nonnegative(),
  role: z.enum(['master', 'replica', 'sentinel', 'unknown']),
  connectedClients: z.number().int().nonnegative(),
  usedMemoryBytes: z.number().nonnegative(),
  maxMemoryBytes: z.number().nonnegative().nullable(),
  opsPerSec: z.number().nonnegative().nullable(),
  keyspace: z.array(
    z.object({
      db: z.number().int().nonnegative(),
      keys: z.number().int().nonnegative(),
      expires: z.number().int().nonnegative(),
    }),
  ),
});

export const databaseStatsSchema = z.discriminatedUnion('kind', [
  postgresStatsSchema,
  redisStatsSchema,
]);

export const backupFormatSchema = z.enum(['custom', 'plain', 'rdb', 'logical']);

export const backupRequestSchema = z.object({
  format: backupFormatSchema.optional(),
  label: z.string().max(120).optional(),
});

export const backupRecordSchema = z.object({
  id: idSchema,
  profileId: idSchema,
  kind: databaseKindSchema,
  format: backupFormatSchema,
  label: z.string().nullable().optional(),
  fileName: z.string(),
  sizeBytes: z.number().nonnegative(),
  status: z.enum(['running', 'success', 'failed']),
  createdAt: isoDateTimeSchema,
  finishedAt: isoDateTimeSchema.nullable().optional(),
  error: z.string().nullable().optional(),
});

export const restoreRequestSchema = z.object({
  backupId: idSchema,
  confirm: z.literal(true),
});

export const databaseJobSchema = z.object({
  id: idSchema,
  profileId: idSchema,
  type: z.enum(['backup', 'restore']),
  status: z.enum(['queued', 'running', 'success', 'failed']),
  backupId: z.string().nullable().optional(),
  startedAt: isoDateTimeSchema.nullable().optional(),
  finishedAt: isoDateTimeSchema.nullable().optional(),
  progress: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
});

/* ------------------------------------------------------------------ */
/* Containers / images / stacks                                        */
/* ------------------------------------------------------------------ */

export const containerPortSchema = z.object({
  ip: z.string().optional(),
  privatePort: z.number().int().min(1).max(65535),
  publicPort: z.number().int().min(1).max(65535).optional(),
  type: z.enum(['tcp', 'udp', 'sctp']),
});

export const containerSummarySchema = z.object({
  id: z.string().min(1),
  names: z.array(z.string()),
  image: z.string(),
  imageId: z.string().optional(),
  command: z.string().optional(),
  created: z.string(),
  state: z.string(),
  status: z.string(),
  ports: z.array(containerPortSchema),
  labels: z.record(z.string(), z.string()),
  composeProject: z.string().nullable().optional(),
  composeService: z.string().nullable().optional(),
});

export const containerMountSchema = z.object({
  type: z.string(),
  source: z.string().optional(),
  destination: z.string(),
  mode: z.string().optional(),
  rw: z.boolean(),
});

export const containerDetailSchema = containerSummarySchema.extend({
  env: z.array(z.string()),
  mounts: z.array(containerMountSchema),
  restartPolicy: z.string().optional(),
  platform: z.string().optional(),
  networkMode: z.string().optional(),
  health: z.string().nullable().optional(),
});

export const containerStatsSchema = z.object({
  cpuPercent: z.number().nonnegative(),
  memoryUsageBytes: z.number().nonnegative(),
  memoryLimitBytes: z.number().nonnegative(),
  memoryPercent: z.number().nonnegative(),
  networkRxBytes: z.number().nonnegative(),
  networkTxBytes: z.number().nonnegative(),
  blockReadBytes: z.number().nonnegative(),
  blockWriteBytes: z.number().nonnegative(),
  pids: z.number().int().nonnegative(),
  readAt: isoDateTimeSchema,
});

export const containerActionSchema = z.object({
  timeoutSec: z.number().int().min(0).max(600).optional(),
});

export const execRequestSchema = z.object({
  command: z.array(z.string().min(1).max(4096)).min(1).max(64),
  timeoutMs: z.number().int().min(100).max(300_000).optional(),
  workdir: z.string().max(4096).optional(),
  user: z.string().max(128).optional(),
});

export const execResultSchema = z.object({
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().nonnegative(),
  truncated: z.boolean(),
});

export const imageSummarySchema = z.object({
  id: z.string(),
  repoTags: z.array(z.string()),
  repoDigests: z.array(z.string()),
  sizeBytes: z.number().nonnegative(),
  createdAt: z.string(),
  labels: z.record(z.string(), z.string()),
  dangling: z.boolean(),
});

export const imagePullRequestSchema = z.object({
  reference: z
    .string()
    .min(1)
    .max(512)
    .refine((value) => !/^\s*-/.test(value) && !/\s/.test(value), 'Invalid image reference'),
});

export const imagePruneRequestSchema = z.object({
  danglingOnly: z.boolean().optional(),
});

export const STACK_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;
export const stackNameSchema = z.string().regex(STACK_NAME_PATTERN, 'Invalid stack name');

export const stackSummarySchema = z.object({
  name: stackNameSchema,
  status: z.string(),
  configFiles: z.array(z.string()),
  containerCount: z.number().int().nonnegative(),
  runningCount: z.number().int().nonnegative(),
  updatedAt: z.string().nullable().optional(),
});

export const stackDetailSchema = stackSummarySchema.extend({
  composePath: z.string(),
  composeYaml: z.string(),
  containers: z.array(containerSummarySchema),
});

export const stackCreateSchema = z.object({
  name: stackNameSchema,
  composeYaml: z.string().min(1).max(1_048_576),
});

export const stackUpdateSchema = z.object({
  composeYaml: z.string().min(1).max(1_048_576),
});

export const stackActionSchema = z.object({
  removeVolumes: z.boolean().optional(),
  removeImages: z.boolean().optional(),
  build: z.boolean().optional(),
  forceRecreate: z.boolean().optional(),
});

/* ------------------------------------------------------------------ */
/* Files                                                               */
/* ------------------------------------------------------------------ */

export const fileRootNameSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,31}$/, 'Invalid file root name');

/** Root-relative, POSIX-style virtual path. Leading slash is optional. */
export const filePathSchema = virtualFilePathSchema;

export const fileTypeSchema = z.enum(['file', 'directory', 'symlink', 'other']);

export const fileRootSchema = z.object({
  name: fileRootNameSchema,
  path: z.string(),
  writable: z.boolean(),
  freeBytes: z.number().nonnegative().nullable().optional(),
  totalBytes: z.number().nonnegative().nullable().optional(),
});

export const fileItemSchema = z.object({
  name: z.string(),
  root: fileRootNameSchema,
  path: z.string(),
  type: fileTypeSchema,
  size: z.number().nonnegative(),
  mtime: z.string(),
  ctime: z.string(),
  mode: z.string(),
  readonly: z.boolean(),
  isSymlink: z.boolean(),
  targetType: fileTypeSchema.nullable().optional(),
});

export const fileListResultSchema = listResultSchema(fileItemSchema).extend({
  root: fileRootNameSchema,
  path: z.string(),
});

export const fileSearchResultSchema = listResultSchema(fileItemSchema).extend({
  query: z.string(),
  truncated: z.boolean(),
});

export const fileReadResultSchema = z.object({
  content: z.string(),
  encoding: z.enum(['utf8', 'base64']),
  size: z.number().nonnegative(),
  truncated: z.boolean(),
  mtime: z.string(),
  isBinary: z.boolean(),
});

export const fileWriteRequestSchema = z.object({
  root: fileRootNameSchema,
  path: filePathSchema,
  content: z.string().max(16 * 1024 * 1024),
  encoding: z.enum(['utf8', 'base64']).optional(),
  create: z.boolean().optional(),
  overwrite: z.boolean().optional(),
  expectedMtime: z.string().optional(),
});

export const fileMkdirRequestSchema = z.object({
  root: fileRootNameSchema,
  path: filePathSchema,
  recursive: z.boolean().optional(),
  mode: z.string().regex(/^[0-7]{3,4}$/).optional(),
});

export const fileRenameRequestSchema = z.object({
  root: fileRootNameSchema,
  from: filePathSchema,
  to: filePathSchema,
  overwrite: z.boolean().optional(),
});

export const fileCopyRequestSchema = z.object({
  root: fileRootNameSchema,
  from: filePathSchema,
  to: filePathSchema,
  overwrite: z.boolean().optional(),
});

export const fileChmodRequestSchema = z.object({
  root: fileRootNameSchema,
  path: filePathSchema,
  mode: z.string().regex(/^[0-7]{3,4}$/, 'Mode must be 3 or 4 octal digits'),
});

export const fileDeleteQuerySchema = z.object({
  root: fileRootNameSchema,
  path: filePathSchema,
  permanent: booleanQuerySchema.optional(),
});

export const trashEntrySchema = z.object({
  id: idSchema,
  root: fileRootNameSchema,
  originalPath: z.string(),
  trashedAt: isoDateTimeSchema,
  sizeBytes: z.number().nonnegative(),
  type: fileTypeSchema,
});

export const trashRestoreRequestSchema = z.object({
  trashId: idSchema,
  overwrite: z.boolean().optional(),
});

export const trashEmptyRequestSchema = z
  .object({
    trashIds: z.array(idSchema).max(500).optional(),
    all: z.boolean().optional(),
  })
  .refine((value) => value.all === true || (value.trashIds !== undefined && value.trashIds.length > 0), {
    message: 'Provide trashIds or all=true',
  });

export const fileUploadQuerySchema = z.object({
  root: fileRootNameSchema,
  path: filePathSchema,
  overwrite: booleanQuerySchema.optional(),
});

export const fileDownloadQuerySchema = z.object({
  root: fileRootNameSchema,
  path: filePathSchema,
});

export const fileArchiveRequestSchema = z.object({
  root: fileRootNameSchema,
  paths: z.array(filePathSchema).min(1).max(200),
  destination: filePathSchema,
  format: z.enum(['zip', 'tar', 'tar.gz']),
});

export const fileExtractRequestSchema = z.object({
  root: fileRootNameSchema,
  path: filePathSchema,
  destination: filePathSchema,
  format: z.enum(['zip', 'tar', 'tar.gz']).optional(),
});

export const fileSearchQuerySchema = z.object({
  root: fileRootNameSchema,
  path: filePathSchema.optional(),
  q: z.string().min(1).max(256),
  mode: z.enum(['name', 'content']).optional(),
  caseSensitive: booleanQuerySchema.optional(),
  includeHidden: booleanQuerySchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const fileArchiveResultSchema = z.object({
  path: z.string(),
  format: z.enum(['zip', 'tar', 'tar.gz']),
  sizeBytes: z.number().nonnegative(),
  entries: z.number().int().nonnegative(),
});

export const fileExtractResultSchema = z.object({
  destination: z.string(),
  entries: z.number().int().nonnegative(),
});

/* ------------------------------------------------------------------ */
/* Terminal                                                            */
/* ------------------------------------------------------------------ */

export const terminalSessionSchema = z.object({
  id: idSchema,
  shell: z.string(),
  cwd: z.string(),
  cols: z.number().int().min(2).max(500),
  rows: z.number().int().min(2).max(300),
  pty: z.boolean(),
  status: z.enum(['running', 'exited']),
  exitCode: z.number().int().nullable(),
  createdAt: isoDateTimeSchema,
  lastActivityAt: isoDateTimeSchema,
});

export const terminalCreateSchema = z.object({
  shell: z.string().max(1024).optional(),
  cwd: hostPathSchema.optional(),
  cols: z.number().int().min(2).max(500).optional(),
  rows: z.number().int().min(2).max(300).optional(),
  env: z.record(z.string().max(128), z.string().max(4096)).optional(),
});

export const shellInfoSchema = z.object({
  path: z.string(),
  name: z.string(),
});

export const terminalClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string().max(1_048_576) }),
  z.object({
    type: z.literal('resize'),
    cols: z.number().int().min(2).max(500),
    rows: z.number().int().min(2).max(300),
  }),
  z.object({ type: z.literal('ping') }),
]);

export const terminalServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), session: terminalSessionSchema }),
  z.object({ type: z.literal('output'), data: z.string() }),
  z.object({ type: z.literal('exit'), code: z.number().int().nullable(), signal: z.string().nullable().optional() }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
  z.object({ type: z.literal('pong') }),
]);

export const containerLogsQuerySchema = z.object({
  follow: booleanQuerySchema.optional(),
  tail: z.coerce.number().int().min(0).max(10_000).optional(),
  since: z.string().max(64).optional(),
  timestamps: booleanQuerySchema.optional(),
  stdout: booleanQuerySchema.optional(),
  stderr: booleanQuerySchema.optional(),
});

export const containerLogsClientMessageSchema = z.object({
  type: z.literal('close'),
});

export const containerLogsServerMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('log'),
    stream: z.enum(['stdout', 'stderr']),
    data: z.string(),
    ts: z.string().optional(),
  }),
  z.object({ type: z.literal('end') }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
]);

/* ------------------------------------------------------------------ */
/* Tasks                                                               */
/* ------------------------------------------------------------------ */

export const taskOverlapSchema = z.enum(['skip', 'allow']);
export const taskRunStatusSchema = z.enum(['running', 'success', 'failed', 'timeout', 'skipped']);

export const taskRunSummarySchema = z.object({
  id: idSchema,
  taskId: idSchema,
  status: taskRunStatusSchema,
  triggeredBy: z.enum(['schedule', 'manual']),
  startedAt: isoDateTimeSchema,
  finishedAt: isoDateTimeSchema.nullable().optional(),
  exitCode: z.number().int().nullable().optional(),
  durationMs: z.number().nonnegative().nullable().optional(),
});

export const taskRunSchema = taskRunSummarySchema.extend({
  stdoutTail: z.string(),
  stderrTail: z.string(),
  truncated: z.boolean(),
  logPath: z.string().nullable().optional(),
});

export const taskSchema = z.object({
  id: idSchema,
  name: displayNameSchema,
  description: z.string().max(2000).nullable(),
  schedule: z.string().min(1).max(128),
  timezone: z.string().max(64).nullable(),
  command: z.string().min(1).max(65_536),
  cwd: z.string().nullable(),
  env: z.record(z.string(), z.string()),
  enabled: z.boolean(),
  timeoutSec: z.number().int().min(1).max(86_400),
  overlap: taskOverlapSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  nextRunAt: isoDateTimeSchema.nullable(),
  lastRun: taskRunSummarySchema.nullable(),
});

export const taskCreateSchema = z.object({
  name: displayNameSchema,
  description: z.string().max(2000).optional(),
  schedule: z.string().min(1).max(128),
  timezone: z.string().max(64).optional(),
  command: z.string().min(1).max(65_536),
  cwd: hostPathSchema.optional(),
  env: z.record(z.string().max(128), z.string().max(4096)).optional(),
  enabled: z.boolean().optional(),
  timeoutSec: z.number().int().min(1).max(86_400).optional(),
  overlap: taskOverlapSchema.optional(),
});

export const taskUpdateSchema = z
  .object({
    name: displayNameSchema.optional(),
    description: z.string().max(2000).nullable().optional(),
    schedule: z.string().min(1).max(128).optional(),
    timezone: z.string().max(64).nullable().optional(),
    command: z.string().min(1).max(65_536).optional(),
    cwd: hostPathSchema.nullable().optional(),
    env: z.record(z.string().max(128), z.string().max(4096)).optional(),
    enabled: z.boolean().optional(),
    timeoutSec: z.number().int().min(1).max(86_400).optional(),
    overlap: taskOverlapSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const taskRunNowResultSchema = z.object({
  run: taskRunSchema,
});

export const taskNextRunsResultSchema = z.object({
  nextRuns: z.array(z.object({ at: isoDateTimeSchema })),
});

/* ------------------------------------------------------------------ */
/* Machines (core only)                                                */
/* ------------------------------------------------------------------ */

export const machineTransportSchema = z.enum(['stdio', 'http', 'reverse-ws']);
export const machineStatusSchema = z.enum(['online', 'offline', 'starting', 'degraded', 'error']);

/** docs/api-contract.md §5.4: core-driven node snapshot (worker GET /system/snapshot). */
export const systemSnapshotSchema = z.object({
  collectedAt: isoDateTimeSchema,
  hostname: z.string(),
  platform: z.string(),
  arch: z.string(),
  release: z.string(),
  nodeVersion: z.string(),
  workerVersion: z.string(),
  uptimeSec: z.number().nonnegative(),
  cpuCount: z.number().int().nonnegative(),
  loadavg: z.tuple([z.number(), z.number(), z.number()]).nullable(),
  memTotalBytes: z.number().nonnegative(),
  memFreeBytes: z.number().nonnegative(),
  diskTotalBytes: z.number().nonnegative().nullable(),
  diskFreeBytes: z.number().nonnegative().nullable(),
  ips: z.array(z.string()),
  transport: z.string(),
  pty: z.boolean(),
});

/** docs/api-contract.md §5.5: worker GET /system/metrics. */
export const systemMetricsSchema = z.object({
  collectedAt: isoDateTimeSchema,
  cpuPercent: z.number().nonnegative().nullable(),
  cpuCount: z.number().int().nonnegative(),
  loadavg: z.tuple([z.number(), z.number(), z.number()]).nullable(),
  memTotalBytes: z.number().nonnegative(),
  memFreeBytes: z.number().nonnegative(),
  diskTotalBytes: z.number().nonnegative().nullable(),
  diskFreeBytes: z.number().nonnegative().nullable(),
  uptimeSec: z.number().nonnegative(),
});

export const machineSchema = z.object({
  id: idSchema,
  name: displayNameSchema,
  transport: machineTransportSchema,
  status: machineStatusSchema,
  enabled: z.boolean(),
  desiredState: z.enum(['running', 'stopped']),
  endpoint: z.string().nullable(),
  hasToken: z.boolean(),
  worker: workerDescriptorSchema.nullable(),
  capabilities: capabilitiesSchema.nullable(),
  lastSeenAt: isoDateTimeSchema.nullable(),
  lastError: z.string().nullable(),
  reconnectAttempts: z.number().int().nonnegative().optional(),
  /** Edge enrollment fields (docs/api-contract.md §5.4). Defaults keep old records parseable. */
  edge: z.boolean().default(false),
  group: z.string().max(120).nullable().default(null),
  edgeKeyId: z.string().nullable().default(null),
  snapshot: systemSnapshotSchema.nullable().default(null),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

const machineBaseFields = {
  name: displayNameSchema,
  enabled: z.boolean().optional(),
};

export const machineCreateSchema = z.discriminatedUnion('transport', [
  z.object({
    ...machineBaseFields,
    transport: z.literal('http'),
    url: z.string().url().max(2048),
    token: z.string().min(8).max(512),
  }),
  z.object({
    ...machineBaseFields,
    transport: z.literal('stdio'),
    command: z.string().min(1).max(1024).optional(),
    args: z.array(z.string().max(4096)).max(64).optional(),
    env: z.record(z.string().max(128), z.string().max(8192)).optional(),
    token: z.string().min(8).max(512),
  }),
  z.object({
    ...machineBaseFields,
    transport: z.literal('reverse-ws'),
  }),
]);

export const machineUpdateSchema = z
  .object({
    name: displayNameSchema.optional(),
    enabled: z.boolean().optional(),
    url: z.string().url().max(2048).optional(),
    token: z.string().min(8).max(512).optional(),
    command: z.string().min(1).max(1024).optional(),
    args: z.array(z.string().max(4096)).max(64).optional(),
    env: z.record(z.string().max(128), z.string().max(8192)).optional(),
    /** Edge group; additive to the frozen v1 update input (docs/api-contract.md §5.2). */
    group: z
      .string()
      .min(1)
      .max(120)
      .refine((value) => !CONTROL_CHAR_PATTERN.test(value), 'Group may not contain control characters')
      .nullable()
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const machineEnrollmentSchema = z.object({
  machineId: idSchema,
  url: z.string(),
  secret: z.string(),
  workerEnv: z.record(z.string(), z.string()),
});

export const machineCreateResultSchema = z.object({
  machine: machineSchema,
  enrollment: machineEnrollmentSchema.optional(),
});

export const machineTestResultSchema = z.object({
  reachable: z.boolean(),
  latencyMs: z.number().nonnegative().nullable().optional(),
  info: systemInfoSchema.nullable().optional(),
  error: z.string().optional(),
});

export const machineHealthSchema = z.object({
  machineId: idSchema,
  status: machineStatusSchema,
  lastSeenAt: isoDateTimeSchema.nullable(),
  latencyMs: z.number().nonnegative().nullable().optional(),
  consecutiveFailures: z.number().int().nonnegative(),
  lastError: z.string().nullable().optional(),
  checkedAt: isoDateTimeSchema,
});

/* ------------------------------------------------------------------ */
/* Edge nodes (core only, docs/api-contract.md §5.4 / §5.5)            */
/* ------------------------------------------------------------------ */

/** Edge machine name: 1..120 chars, no control characters, non-blank. */
export const edgeMachineNameSchema = z
  .string()
  .min(1)
  .max(120)
  .refine((value) => value.trim().length > 0, 'Name may not be blank')
  .refine((value) => !CONTROL_CHAR_PATTERN.test(value), 'Name may not contain control characters');

export const edgeGroupSchema = z
  .string()
  .min(1)
  .max(120)
  .refine((value) => !CONTROL_CHAR_PATTERN.test(value), 'Group may not contain control characters');

export const edgeKeySchema = z.object({
  id: idSchema,
  name: displayNameSchema,
  group: z.string().nullable(),
  expiresAt: isoDateTimeSchema.nullable(),
  maxUses: z.number().int().nonnegative(),
  uses: z.number().int().nonnegative(),
  revokedAt: isoDateTimeSchema.nullable(),
  lastUsedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
});

export const edgeKeyCreateSchema = z.object({
  name: displayNameSchema,
  group: edgeGroupSchema.nullable().optional(),
  ttlSec: z.number().int().min(1).max(31_536_000).optional(),
  maxUses: z.number().int().min(0).max(100_000).optional(),
});

export const edgeKeyCreateResultSchema = z.object({
  key: edgeKeySchema,
  secret: z.string().min(1),
});

export const edgeEnrollRequestSchema = z.object({
  key: z.string().min(1).max(512),
  name: edgeMachineNameSchema.optional(),
  platform: z.string().min(1).max(64),
  arch: z.string().min(1).max(64),
  version: z.string().min(1).max(64),
});

export const edgeEnrollResultSchema = z.object({
  machine: machineSchema,
  secret: z.string().min(1),
  wsUrl: z.string().min(1),
});

export const edgeJobKindSchema = z.enum(['snapshot', 'run-task', 'apply-site']);
export const edgeJobStatusSchema = z.enum(['pending', 'running', 'succeeded', 'failed', 'canceled']);

export const edgeJobSchema = z.object({
  id: idSchema,
  machineId: idSchema,
  kind: edgeJobKindSchema,
  payload: z.record(z.string(), z.unknown()),
  status: edgeJobStatusSchema,
  createdAt: isoDateTimeSchema,
  startedAt: isoDateTimeSchema.nullable(),
  finishedAt: isoDateTimeSchema.nullable(),
  httpStatus: z.number().int().nullable(),
  result: z.unknown(),
  error: z.string().nullable(),
});

export const edgeJobCreateSchema = z.object({
  machineId: idSchema,
  kind: edgeJobKindSchema,
  payload: z.record(z.string(), z.unknown()).optional(),
});

/* ------------------------------------------------------------------ */
/* Auth / WS tickets                                                   */
/* ------------------------------------------------------------------ */

export const authUserSchema = z.object({
  id: idSchema,
  username: z.string().min(1).max(64),
  displayName: z.string().max(120).nullable(),
  role: z.enum(['admin', 'operator']),
});

export const loginRequestSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(1024),
});

export const loginResultSchema = z.object({
  user: authUserSchema,
  expiresAt: isoDateTimeSchema,
});

export const authMeSchema = z.object({
  authenticated: z.literal(true),
  role: systemRoleSchema,
  authType: z.enum(['token', 'session']),
  user: authUserSchema.optional(),
});

export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(10).max(1024),
});

export const wsTicketRequestSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(2048)
    .regex(/^\/(?:ws\/|api\/v1\/machines\/[^/]+\/proxy\/ws\/)/, 'Path must target a /ws/ endpoint'),
  machineId: idSchema.optional(),
});

export const wsTicketSchema = z.object({
  ticket: z.string().min(16),
  expiresAt: isoDateTimeSchema,
  path: z.string(),
  machineId: z.string().nullable().optional(),
});

/** Re-exported so consumers can build exhaustive error-code switches. */
export const errorCodesSchema = z.enum(ERROR_CODES);
