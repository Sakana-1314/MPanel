import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, Plus, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import type { BackupFormat, BackupRecord, DatabaseJob } from '../../api/types';
import {
  backupDownloadUrl,
  createBackup,
  databasesKeys,
  deleteBackup,
  getProfile,
  listBackups,
  restoreBackup,
} from '../../api/databases';
import { getSystemInfo, systemKeys } from '../../api/system';
import { describeError } from '../../api/errors';
import { downloadRaw } from '../../lib/download';
import { toastError, useAppMutation } from '../../lib/mutations';
import { formatBytes, formatDate } from '../../lib/format';
import { useToast } from '../../components/ui/Toast';
import {
  Alert,
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  FormField,
  Input,
  Modal,
  Pagination,
  Select,
  StatusBadge,
  Toolbar,
  type Column,
} from '../../components/ui';
import { JobProgress } from './JobProgress';
import {
  BACKUP_FORMAT_DESCRIPTION,
  BACKUP_FORMAT_LABEL,
  ENGINE_LABEL,
  ENGINE_TONE,
  backupFormatsFor,
  capabilityHint,
  defaultBackupFormat,
  isCapabilityPending,
  readPostgresTools,
  readRedisTools,
} from './ProfileList';

const PAGE_LIMIT = 50;

function backupDisplayName(backup: BackupRecord): string {
  const label = backup.label;
  return label !== null && label !== undefined && label.length > 0 ? label : backup.fileName;
}

interface BackupBlock {
  title: string;
  reason: string;
  hint: string;
}

/**
 * 备份/恢复面板：
 * - 列表展示大小、时间、状态，支持创建、下载、删除；
 * - 恢复需要输入档案名，然后再经过一次危险操作确认；
 * - pg_dump 缺失时禁用创建并解释；Redis rdb 依赖 redis-cli 且只能离线恢复。
 */
export function BackupPanel(props: { profileId: string }): JSX.Element {
  const toast = useToast();
  const [cursor, setCursor] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [format, setFormat] = useState<BackupFormat>('custom');
  const [label, setLabel] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<BackupRecord | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<BackupRecord | null>(null);
  const [confirmRestoreOpen, setConfirmRestoreOpen] = useState(false);
  const [typedName, setTypedName] = useState('');
  const [activeJob, setActiveJob] = useState<DatabaseJob | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<unknown>(null);

  useEffect(() => {
    setCursor(null);
    setCreateOpen(false);
    setDeleteTarget(null);
    setRestoreTarget(null);
    setConfirmRestoreOpen(false);
    setTypedName('');
    setActiveJob(null);
    setDownloadError(null);
  }, [props.profileId]);

  const profileQuery = useQuery({
    queryKey: databasesKeys.profile(props.profileId),
    queryFn: () => getProfile(props.profileId),
    staleTime: 60_000,
    retry: 0,
  });
  const systemQuery = useQuery({
    queryKey: systemKeys.info(),
    queryFn: () => getSystemInfo(),
    staleTime: 30_000,
    retry: 0,
  });
  const backupsQuery = useQuery({
    queryKey: databasesKeys.backups(props.profileId, { limit: PAGE_LIMIT, cursor }),
    queryFn: () =>
      listBackups(
        props.profileId,
        cursor === null ? { limit: PAGE_LIMIT } : { limit: PAGE_LIMIT, cursor },
      ),
    refetchInterval: (current) =>
      current.state.data?.items.some((item) => item.status === 'running') ? 2000 : false,
  });

  const profile = profileQuery.data;
  const kind = profile?.kind;
  const capabilities = systemQuery.data?.capabilities;
  const pgTools = readPostgresTools(capabilities?.postgres);
  const redisTools = readRedisTools(capabilities?.redis);
  const redisRdbAvailable =
    redisTools?.rdbAvailable ?? redisTools?.cli?.available ?? true;
  const backups = backupsQuery.data?.items ?? [];

  const backupBlock: BackupBlock | undefined = (() => {
    if (kind === 'postgres') {
      const capability = capabilities?.postgres;
      const pgDump = pgTools?.pgDump;
      if (pgDump !== undefined && !pgDump.available) {
        return {
          title: 'pg_dump 不可用，无法创建 PostgreSQL 备份',
          reason: pgDump.reason ?? 'worker 未找到 pg_dump 可执行文件。',
          hint:
            capabilityHint(capability) ??
            '在 worker 主机安装 PostgreSQL 客户端，或把 MPANEL_PG_DUMP_BIN 指向 pg_dump 绝对路径；修改后刷新系统状态再试。',
        };
      }
      if (
        capability !== undefined &&
        !capability.available &&
        pgDump === undefined &&
        !isCapabilityPending(capability)
      ) {
        return {
          title: 'PostgreSQL 能力不可用',
          reason: capability.reason ?? '能力探测失败。',
          hint:
            capabilityHint(capability) ??
            '检查 pg 驱动与 MPANEL_PG_DUMP_BIN / MPANEL_PSQL_BIN 配置后重试。',
        };
      }
    }
    if (kind === 'redis') {
      const capability = capabilities?.redis;
      if (capability !== undefined && !capability.available && !isCapabilityPending(capability)) {
        return {
          title: 'Redis 能力不可用，无法创建备份',
          reason: capability.reason ?? 'worker 无法加载 ioredis。',
          hint:
            capabilityHint(capability) ??
            '重新安装 worker 依赖（ioredis）并重启 worker；redis-cli 只影响 rdb 快照。',
        };
      }
    }
    return undefined;
  })();

  const createMutation = useAppMutation<
    { job: DatabaseJob },
    { format: BackupFormat; label: string }
  >({
    mutationFn: (input) =>
      createBackup(props.profileId, {
        format: input.format,
        label: input.label.trim().length > 0 ? input.label.trim() : undefined,
      }),
    successMessage: '已提交备份任务',
    successDescription: '备份在 worker 后台执行；列表会随作业状态自动刷新。',
    invalidate: [
      databasesKeys.backups(props.profileId),
      databasesKeys.jobs({ profileId: props.profileId }),
    ],
    onSuccess: ({ job }) => {
      setActiveJob(job);
      setCreateOpen(false);
      setLabel('');
    },
  });

  const restoreMutation = useAppMutation<{ job: DatabaseJob }, BackupRecord>({
    mutationFn: (backup) =>
      restoreBackup(props.profileId, { backupId: backup.id, confirm: true }),
    successMessage: (_, backup) => `已提交恢复任务：${backup.fileName}`,
    successDescription: '恢复会覆盖目标数据库内容；请在作业进度中查看结果。',
    invalidate: [
      databasesKeys.backups(props.profileId),
      databasesKeys.jobs({ profileId: props.profileId }),
    ],
    onSuccess: ({ job }) => {
      setActiveJob(job);
      setRestoreTarget(null);
      setConfirmRestoreOpen(false);
      setTypedName('');
    },
  });

  const deleteMutation = useAppMutation<{ deleted: true }, BackupRecord>({
    mutationFn: (backup) => deleteBackup(backup.id),
    successMessage: (_, backup) => `已删除备份 ${backup.fileName}`,
    successDescription: '备份文件会从 worker 的备份目录移除。',
    invalidate: [databasesKeys.backups(props.profileId)],
    onSuccess: () => setDeleteTarget(null),
  });

  // 重新打开表单时清掉上次提交的错误，避免误以为本次也失败。
  useEffect(() => {
    if (createOpen) createMutation.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createOpen]);

  useEffect(() => {
    if (restoreTarget !== null) restoreMutation.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreTarget?.id]);

  const openCreate = (): void => {
    if (kind !== undefined) setFormat(defaultBackupFormat(kind));
    setLabel('');
    setCreateOpen(true);
  };

  const handleDownload = async (backup: BackupRecord): Promise<void> => {
    setDownloadingId(backup.id);
    setDownloadError(null);
    try {
      await downloadRaw(backupDownloadUrl(backup.id), backup.fileName);
    } catch (error) {
      setDownloadError(error);
      toastError(toast, error);
    } finally {
      setDownloadingId(null);
    }
  };

  const restoreBlockedReason = (backup: BackupRecord): string | undefined => {
    if (backup.status !== 'success') return '只能恢复状态为成功的备份。';
    if (backup.kind === 'redis' && backup.format === 'rdb') {
      return 'rdb 物理快照只能停止 Redis 后离线恢复；API 对 rdb 恢复会返回 UNAVAILABLE。';
    }
    if (backup.kind === 'redis' && capabilities?.redis.available === false) {
      if (isCapabilityPending(capabilities.redis)) return undefined;
      return `Redis 能力不可用：${capabilities.redis.reason ?? 'ioredis 不可加载'}；修复后才能恢复 logical 备份。`;
    }
    if (backup.kind === 'postgres') {
      if (
        capabilities?.postgres.available === false &&
        pgTools === undefined &&
        !isCapabilityPending(capabilities.postgres)
      ) {
        return `PostgreSQL 能力不可用：${capabilities.postgres.reason ?? '能力探测失败'}。`;
      }
      if (backup.format === 'custom') {
        if (pgTools?.pgRestore?.available === false || pgTools?.pgRestoreAvailable === false) {
          return `缺少 pg_restore：${pgTools?.pgRestore?.reason ?? '未找到可执行文件'}；设置 MPANEL_PG_RESTORE_BIN 后重试。`;
        }
      } else if (backup.format === 'plain') {
        if (pgTools?.psql?.available === false) {
          return `缺少 psql：${pgTools.psql.reason ?? '未找到可执行文件'}；设置 MPANEL_PSQL_BIN 后重试。`;
        }
      }
    }
    return undefined;
  };

  const formatOptions =
    kind === undefined
      ? []
      : backupFormatsFor(kind).map((value) => ({
          value,
          label: BACKUP_FORMAT_LABEL[value],
          disabled: value === 'rdb' && !redisRdbAvailable,
        }));

  const targetBlockedReason =
    restoreTarget === null ? undefined : restoreBlockedReason(restoreTarget);
  const nameMatches =
    restoreTarget !== null && profile !== undefined && typedName.trim() === profile.name;

  const columns: Column<BackupRecord>[] = [
    {
      key: 'file',
      header: '备份',
      sortable: true,
      sortValue: (row) => backupDisplayName(row),
      render: (row) => (
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-1.5">
            <Badge tone={ENGINE_TONE[row.kind]}>{ENGINE_LABEL[row.kind]}</Badge>
            <span className="max-w-[18rem] truncate text-sm font-medium text-app-text">
              {backupDisplayName(row)}
            </span>
          </span>
          <span
            className="max-w-[24rem] truncate font-mono text-[10px] text-app-muted"
            title={row.fileName}
          >
            {row.fileName}
          </span>
        </div>
      ),
    },
    {
      key: 'format',
      header: '格式',
      render: (row) => (
        <Badge tone="neutral" title={BACKUP_FORMAT_DESCRIPTION[row.format]}>
          {row.format}
        </Badge>
      ),
    },
    {
      key: 'sizeBytes',
      header: '大小',
      align: 'right',
      sortable: true,
      sortValue: (row) => row.sizeBytes,
      render: (row) => (
        <span className="tabular-nums">{row.status === 'running' ? '—' : formatBytes(row.sizeBytes)}</span>
      ),
    },
    {
      key: 'status',
      header: '状态',
      sortable: true,
      sortValue: (row) => row.status,
      render: (row) => (
        <div className="flex flex-col gap-0.5">
          <StatusBadge status={row.status} title={row.error ?? undefined} />
          {row.error === null || row.error === undefined ? null : (
            <span
              className="max-w-[14rem] truncate text-[10px] text-app-danger"
              title={row.error}
            >
              {row.error}
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'createdAt',
      header: '创建时间',
      sortable: true,
      sortValue: (row) => row.createdAt,
      render: (row) => (
        <span className="flex flex-col gap-0.5">
          <span className="text-xs tabular-nums" title={formatDate(row.createdAt)}>
            {row.createdAt === '' ? '—' : formatDate(row.createdAt)}
          </span>
          {row.finishedAt === null || row.finishedAt === undefined ? null : (
            <span className="text-[10px] text-app-muted">完成 {formatDate(row.finishedAt)}</span>
          )}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '操作',
      align: 'right',
      render: (row) => {
        const blocked = restoreBlockedReason(row);
        return (
          <span className="flex items-center justify-end gap-1">
            <Button
              size="icon"
              variant="ghost"
              title={
                row.status === 'success'
                  ? '下载备份文件'
                  : '只有成功的备份才能下载'
              }
              aria-label="下载备份"
              disabled={row.status !== 'success'}
              loading={downloadingId === row.id}
              icon={<Download className="h-3.5 w-3.5" />}
              onClick={() => void handleDownload(row)}
            />
            <Button
              size="icon"
              variant="ghost"
              title={blocked ?? '恢复此备份（需要输入档案名确认）'}
              aria-label="恢复备份"
              disabled={blocked !== undefined}
              onClick={() => {
                setTypedName('');
                setRestoreTarget(row);
              }}
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="text-app-danger"
              title={row.status === 'running' ? '运行中的备份不能删除' : '删除备份'}
              aria-label="删除备份"
              disabled={row.status === 'running'}
              onClick={() => setDeleteTarget(row)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </span>
        );
      },
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <Toolbar
        bordered
        left={
          <span className="text-xs text-app-muted">
            共 {backups.length} 条备份
            {backupsQuery.isFetching ? ' · 刷新中…' : ''}
          </span>
        }
        right={
          <>
            <Button
              size="xs"
              variant="ghost"
              icon={<RefreshCw className="h-3 w-3" />}
              loading={backupsQuery.isFetching}
              onClick={() => void backupsQuery.refetch()}
            >
              刷新
            </Button>
            <Button
              size="sm"
              icon={<Plus className="h-3.5 w-3.5" />}
              disabled={backupBlock !== undefined || kind === undefined}
              title={
                backupBlock?.reason ??
                (kind === undefined ? '正在读取数据库档案…' : '创建新的备份作业')
              }
              onClick={openCreate}
            >
              创建备份
            </Button>
          </>
        }
      />

      {backupBlock === undefined ? null : (
        <Alert
          tone="warning"
          title={backupBlock.title}
          hint={backupBlock.hint}
          action={
            <Button size="xs" variant="ghost" onClick={() => void systemQuery.refetch()}>
              重新探测
            </Button>
          }
        >
          {backupBlock.reason}
        </Alert>
      )}

      {profileQuery.isError ? (
        <ErrorState
          error={profileQuery.error}
          title={`读取档案信息失败 · ${describeError(profileQuery.error).code}`}
          onRetry={() => void profileQuery.refetch()}
        />
      ) : null}

      {systemQuery.isError ? (
        <Alert
          tone="warning"
          title={describeError(systemQuery.error, '能力探测失败').title}
          hint={`${describeError(systemQuery.error, '能力探测失败').hint} 仍可尝试创建备份，后端会返回 UNAVAILABLE 与具体 hint。`}
          action={
            <Button size="xs" variant="ghost" onClick={() => void systemQuery.refetch()}>
              重试
            </Button>
          }
        >
          {describeError(systemQuery.error, '能力探测失败').description}
        </Alert>
      ) : null}

      {downloadError === null ? null : (
        <Alert
          tone="danger"
          title={describeError(downloadError).title}
          hint={describeError(downloadError).hint}
          action={
            <Button size="xs" variant="ghost" onClick={() => setDownloadError(null)}>
              知道了
            </Button>
          }
        >
          {describeError(downloadError).description}
        </Alert>
      )}

      {backupsQuery.data?.available === false ? (
        <Alert
          tone="warning"
          title="备份存储不可用"
          hint="检查 worker 的 MPANEL_HOME、备份目录与磁盘权限。"
        >
          {backupsQuery.data.reason ?? '后端返回 available=false。'}
        </Alert>
      ) : null}

      {activeJob === null ? null : (
        <JobProgress
          jobId={activeJob.id}
          onDone={() => void backupsQuery.refetch()}
          onDismiss={() => setActiveJob(null)}
        />
      )}

      {backupsQuery.isError ? (
        <ErrorState
          error={backupsQuery.error}
          title={`读取备份列表失败 · ${describeError(backupsQuery.error).code}`}
          onRetry={() => void backupsQuery.refetch()}
        />
      ) : backups.length === 0 && !backupsQuery.isLoading ? (
        <EmptyState
          compact
          title="还没有备份"
          description={
            kind === 'redis'
              ? 'Redis logical 备份可在线上执行；rdb 快照需要 redis-cli 且只能离线恢复。'
              : 'PostgreSQL 备份使用 pg_dump；创建后任务在 worker 后台执行。'
          }
          action={
            backupBlock === undefined && kind !== undefined ? (
              <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={openCreate}>
                创建第一个备份
              </Button>
            ) : undefined
          }
        />
      ) : (
        <DataTable
          columns={columns}
          rows={backups}
          rowKey={(row) => row.id}
          loading={backupsQuery.isLoading}
          dense
          empty="暂无备份。"
        />
      )}

      {backups.length === 0 && cursor === null ? null : (
        <Pagination
          nextCursor={backupsQuery.data?.nextCursor ?? null}
          onNext={(next) => setCursor(next)}
          onReset={cursor === null ? undefined : () => setCursor(null)}
          loading={backupsQuery.isFetching}
          loaded={backups.length}
        />
      )}

      <Modal
        open={createOpen}
        onClose={createMutation.isPending ? () => undefined : () => setCreateOpen(false)}
        title="创建备份"
        description={
          kind === undefined || profile === undefined
            ? undefined
            : `${ENGINE_LABEL[kind]} · ${profile.name}`
        }
        size="sm"
        footer={
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={createMutation.isPending}
              onClick={() => setCreateOpen(false)}
            >
              取消
            </Button>
            <Button
              size="sm"
              loading={createMutation.isPending}
              disabled={kind === undefined}
              onClick={() => createMutation.mutate({ format, label })}
            >
              开始备份
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <FormField
            label="格式"
            htmlFor="db-backup-format"
            description={BACKUP_FORMAT_DESCRIPTION[format]}
          >
            <Select
              id="db-backup-format"
              value={format}
              disabled={createMutation.isPending || kind === undefined}
              options={formatOptions}
              onChange={(event) => {
                const value = event.target.value;
                if (value === 'custom' || value === 'plain' || value === 'rdb' || value === 'logical') {
                  setFormat(value);
                }
              }}
            />
          </FormField>
          <FormField
            label="标签（可选）"
            htmlFor="db-backup-label"
            description="写入备份记录，便于在列表中识别。"
          >
            <Input
              id="db-backup-label"
              value={label}
              maxLength={120}
              placeholder="例如：发布前快照"
              disabled={createMutation.isPending}
              onChange={(event) => setLabel(event.target.value)}
            />
          </FormField>
          {kind === 'redis' && format === 'rdb' && !redisRdbAvailable ? (
            <Alert tone="warning" title="rdb 快照不可用" hint="缺少 redis-cli；改用 logical 格式可在线备份。">
              worker 的 redis-cli 能力探测失败，rdb 物理快照需要该工具。
            </Alert>
          ) : null}
          <Alert
            tone="info"
            title="后台异步执行"
            hint="同一档案同一时间只允许一个作业；重复提交会返回 409。"
          >
            备份期间可以继续使用其他页面；作业完成或失败后列表会自动刷新。
          </Alert>
          {createMutation.error === null ? null : (
            <Alert
              tone="danger"
              title={describeError(createMutation.error).title}
              hint={describeError(createMutation.error).hint}
            >
              {describeError(createMutation.error).description}
            </Alert>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除备份"
        danger
        confirmLabel="删除"
        loading={deleteMutation.isPending}
        message={
          <span>
            确定删除备份{' '}
            <strong className="text-app-text">
              {deleteTarget === null ? '' : backupDisplayName(deleteTarget)}
            </strong>
            ？文件会从 worker 备份目录移除，此操作不可撤销。
          </span>
        }
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget !== null) deleteMutation.mutate(deleteTarget);
        }}
      />

      <Modal
        open={restoreTarget !== null}
        onClose={
          restoreMutation.isPending
            ? () => undefined
            : () => {
                setRestoreTarget(null);
                setTypedName('');
              }
        }
        title="恢复备份"
        size="md"
        footer={
          <>
            <Button
              variant="ghost"
              size="sm"
              disabled={restoreMutation.isPending}
              onClick={() => {
                setRestoreTarget(null);
                setTypedName('');
              }}
            >
              取消
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={!nameMatches || targetBlockedReason !== undefined || restoreMutation.isPending}
              onClick={() => setConfirmRestoreOpen(true)}
            >
              继续确认
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Alert
            tone="warning"
            title="恢复会覆盖目标数据库的现有数据"
            hint="PostgreSQL custom 备份使用 pg_restore --clean --if-exists；plain 使用 psql；Redis logical 会重放 key（同名覆盖）。"
          >
            这是破坏性操作，执行前请确认已无写入流量，并保留当前备份。
          </Alert>

          {restoreTarget === null ? null : (
            <dl className="grid grid-cols-[5.5rem_1fr] gap-y-1 text-xs">
              <dt className="text-app-muted">文件</dt>
              <dd className="break-all font-mono">{restoreTarget.fileName}</dd>
              <dt className="text-app-muted">格式</dt>
              <dd>{BACKUP_FORMAT_LABEL[restoreTarget.format]}</dd>
              <dt className="text-app-muted">大小</dt>
              <dd>{formatBytes(restoreTarget.sizeBytes)}</dd>
              <dt className="text-app-muted">创建时间</dt>
              <dd>{formatDate(restoreTarget.createdAt)}</dd>
            </dl>
          )}

          <FormField
            label={`输入档案名${profile === undefined ? '' : `“${profile.name}”`}以确认`}
            htmlFor="db-restore-confirm-name"
            error={
              typedName.length > 0 && profile !== undefined && !nameMatches
                ? '名称不匹配。'
                : undefined
            }
            description="必须与档案名称完全一致；这一步用于防止误操作。"
          >
            <Input
              id="db-restore-confirm-name"
              value={typedName}
              autoFocus
              disabled={restoreMutation.isPending}
              placeholder={profile?.name ?? '请输入档案名'}
              onChange={(event) => setTypedName(event.target.value)}
            />
          </FormField>

          {targetBlockedReason === undefined ? null : (
            <Alert tone="danger" title="无法恢复该备份" hint="请修复工具/格式限制后重试。">
              {targetBlockedReason}
            </Alert>
          )}

          {restoreMutation.error === null ? null : (
            <Alert
              tone="danger"
              title={describeError(restoreMutation.error).title}
              hint={describeError(restoreMutation.error).hint}
            >
              {describeError(restoreMutation.error).description}
            </Alert>
          )}
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmRestoreOpen}
        danger
        title="再次确认恢复"
        confirmLabel="立即恢复"
        loading={restoreMutation.isPending}
        message={
          <span>
            将使用{' '}
            <strong className="text-app-text">{restoreTarget?.fileName ?? '所选备份'}</strong>{' '}
            覆盖 <strong className="text-app-text">{profile?.name ?? '目标档案'}</strong>{' '}
            的数据库内容，过程中可能有写入中断。此操作不可撤销，确认继续？
          </span>
        }
        onCancel={() => setConfirmRestoreOpen(false)}
        onConfirm={async () => {
          if (restoreTarget === null) return;
          await restoreMutation.mutateAsync(restoreTarget);
          setConfirmRestoreOpen(false);
        }}
      />
    </div>
  );
}
