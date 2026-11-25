import { Database, Lock, Pencil, Trash2, Zap } from 'lucide-react';
import type { BackupFormat, CapabilityStatus, DatabaseProfile } from '../../api/types';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardHeader } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { RelativeTime } from '../../components/ui/RelativeTime';
import { StatusBadge } from '../../components/ui/StatusBadge';
import type { StatusTone } from '../../components/ui/tones';
import { cn } from '../../lib/cn';

/* ---------------------------- 共用展示辅助 ---------------------------- */
/* 文件布局为数据库页只分配了 8 个文件；本文件同时承载页面共用的    */
/* 引擎/格式/能力探测小工具，供 ProfileFormDialog、BackupPanel 等复用。 */

export type DatabaseKind = DatabaseProfile['kind'];

/**
 * worker 在共享 DatabaseProfile 之外额外返回 notes（store.ts 的
 * DatabaseProfileRecord），共享契约镜像没有声明该字段；这里按可选字段读取。
 */
export type DatabaseProfileWithNotes = DatabaseProfile & { notes?: string | null };

export function profileNotes(profile: DatabaseProfile): string {
  const value = (profile as DatabaseProfileWithNotes).notes;
  return typeof value === 'string' ? value : '';
}

export const ENGINE_LABEL: Record<DatabaseKind, string> = {
  postgres: 'PostgreSQL',
  redis: 'Redis',
};

export const ENGINE_TONE: Record<DatabaseKind, StatusTone> = {
  postgres: 'info',
  redis: 'danger',
};

export const DEFAULT_PORT: Record<DatabaseKind, number> = {
  postgres: 5432,
  redis: 6379,
};

export interface ConnectionStateView {
  status: 'online' | 'offline' | 'untested';
  label: string;
  tone: StatusTone;
}

/** 由 lastCheck 推导档案的连通状态（后端没有独立的 status 字段）。 */
export function profileConnectionState(profile: DatabaseProfile): ConnectionStateView {
  const check = profile.lastCheck;
  if (check === null || check === undefined) {
    return { status: 'untested', label: '未测试', tone: 'neutral' };
  }
  if (check.ok) return { status: 'online', label: '连接正常', tone: 'success' };
  return { status: 'offline', label: '连接失败', tone: 'danger' };
}

export const BACKUP_FORMAT_LABEL: Record<BackupFormat, string> = {
  custom: 'custom（pg_dump 自定义格式）',
  plain: 'plain（SQL 文本）',
  logical: 'logical（逐 key 逻辑备份）',
  rdb: 'rdb（RDB 快照）',
};

export const BACKUP_FORMAT_DESCRIPTION: Record<BackupFormat, string> = {
  custom: '压缩、可选择性恢复；恢复需要 pg_restore。',
  plain: '纯 SQL 文本，可人工查看；恢复使用 psql。',
  logical: 'ioredis 逐 key DUMP/RESTORE，可在线恢复；特殊模块 key 会被跳过并给出警告。',
  rdb: 'redis-cli --rdb 生成物理快照；只能停止 Redis 后离线恢复。',
};

export function backupFormatsFor(kind: DatabaseKind): BackupFormat[] {
  return kind === 'postgres' ? ['custom', 'plain'] : ['logical', 'rdb'];
}

export function defaultBackupFormat(kind: DatabaseKind): BackupFormat {
  return kind === 'postgres' ? 'custom' : 'logical';
}

export const REDIS_ROLE_LABEL: Record<string, string> = {
  master: '主节点（master）',
  replica: '从节点（replica）',
  sentinel: '哨兵（sentinel）',
  unknown: '未知',
};

/** Redis slowlog / 其它微秒级耗时。 */
export function formatMicros(us: number): string {
  if (!Number.isFinite(us) || us < 0) return '—';
  if (us < 1000) return `${Math.round(us)} µs`;
  return `${(us / 1000).toFixed(us < 10_000 ? 1 : 0)} ms`;
}

/** SQL / 命令文本截断，避免表格被撑破。 */
export function truncateText(text: string, max = 160): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}…`;
}

export interface ToolStatus {
  available: boolean;
  version?: string;
  reason?: string;
  path?: string;
}

export interface PostgresToolset {
  driver?: ToolStatus;
  pgDump?: ToolStatus;
  pgRestore?: ToolStatus;
  psql?: ToolStatus;
  pgRestoreAvailable?: boolean;
  hint?: string;
}

export interface RedisToolset {
  driver?: ToolStatus;
  cli?: ToolStatus;
  rdbAvailable?: boolean;
  hint?: string;
  note?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readTool(value: unknown): ToolStatus | undefined {
  if (!isRecord(value) || typeof value.available !== 'boolean') return undefined;
  return {
    available: value.available,
    version: readString(value, 'version'),
    reason: readString(value, 'reason'),
    path: readString(value, 'path'),
  };
}

function detailsOf(status: CapabilityStatus | undefined): Record<string, unknown> | undefined {
  if (status === undefined || !isRecord(status.details)) return undefined;
  return status.details;
}

export function capabilityHint(status: CapabilityStatus | undefined): string | undefined {
  const details = detailsOf(status);
  if (details === undefined) return undefined;
  return readString(details, 'hint');
}

/** worker 尚未完成首次探测（能力默认值），此时不应据此禁用按钮。 */
export function isCapabilityPending(status: CapabilityStatus | undefined): boolean {
  return status !== undefined && !status.available && status.reason === '尚未探测';
}

/** 安全读取 postgres 能力 details.tools（形状见 worker capabilities.ts）。 */
export function readPostgresTools(
  status: CapabilityStatus | undefined,
): PostgresToolset | undefined {
  const details = detailsOf(status);
  if (details === undefined) return undefined;
  const tools = details.tools;
  if (!isRecord(tools)) return { hint: capabilityHint(status) };
  return {
    driver: readTool(tools.driver),
    pgDump: readTool(tools.pgDump),
    pgRestore: readTool(tools.pgRestore),
    psql: readTool(tools.psql),
    pgRestoreAvailable:
      typeof details.pgRestoreAvailable === 'boolean' ? details.pgRestoreAvailable : undefined,
    hint: capabilityHint(status),
  };
}

/** 安全读取 redis 能力 details（含 tools.cli 与 rdbAvailable）。 */
export function readRedisTools(status: CapabilityStatus | undefined): RedisToolset | undefined {
  const details = detailsOf(status);
  if (details === undefined) return undefined;
  const tools = details.tools;
  const cli = isRecord(tools) ? readTool(tools.cli) : undefined;
  const driver = isRecord(tools) ? readTool(tools.driver) : undefined;
  return {
    driver,
    cli,
    rdbAvailable:
      typeof details.rdbAvailable === 'boolean' ? details.rdbAvailable : undefined,
    hint: capabilityHint(status),
    note: readString(details, 'note'),
  };
}

/* ------------------------------- 列表组件 ------------------------------- */

export interface ProfileListProps {
  profiles: DatabaseProfile[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onEdit: (profile: DatabaseProfile) => void;
  onDelete: (profile: DatabaseProfile) => void;
  onTest: (profile: DatabaseProfile) => void;
  /** 正在执行连接测试的档案 id（可选，用于行内 loading）。 */
  testingId?: string | null;
}

/** 左侧档案列表：引擎徽标、名称、主机端口、状态与最近测试时间。 */
export function ProfileList(props: ProfileListProps): JSX.Element {
  if (props.profiles.length === 0) {
    return (
      <Card>
        <CardHeader title="数据库档案" description="PostgreSQL / Redis 连接配置" />
        <EmptyState
          compact
          icon={<Database className="h-5 w-5" />}
          title="还没有数据库档案"
          description="创建档案后可以测试连通性、查看统计、执行备份并在 dbx 中查询。"
        />
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader
        title="数据库档案"
        description="点击档案查看统计、备份与 dbx 查询"
        actions={<Badge tone="neutral">{props.profiles.length}</Badge>}
      />
      <ul className="max-h-[calc(100vh-19rem)] min-h-[8rem] divide-y divide-app-border overflow-auto">
        {props.profiles.map((profile) => {
          const selected = profile.id === props.selectedId;
          const state = profileConnectionState(profile);
          const lastCheck = profile.lastCheck;
          const testing = props.testingId === profile.id;
          return (
            <li
              key={profile.id}
              className={cn(
                'flex items-start gap-2 px-3 py-2.5 transition-colors',
                selected ? 'bg-app-accent/10' : 'hover:bg-app-elevated/60',
              )}
            >
              <button
                type="button"
                onClick={() => props.onSelect(profile.id)}
                aria-pressed={selected}
                className="flex min-w-0 flex-1 flex-col gap-1 text-left"
              >
                <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <Badge tone={ENGINE_TONE[profile.kind]}>{ENGINE_LABEL[profile.kind]}</Badge>
                  <span className="truncate text-sm font-medium text-app-text">
                    {profile.name}
                  </span>
                  {profile.hasPassword ? (
                    <span title="已保存密码（不可回显；可在详情中查看一次性密码）">
                      <Lock className="h-3 w-3 shrink-0 text-app-muted" aria-label="已保存密码" />
                    </span>
                  ) : null}
                </span>
                <span className="truncate font-mono text-[11px] text-app-muted">
                  {profile.host}:{profile.port}
                  {profile.kind === 'postgres' && profile.database !== null
                    ? ` / ${profile.database}`
                    : ''}
                  {profile.kind === 'redis' ? ` / db${profile.redisDb ?? 0}` : ''}
                </span>
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <StatusBadge
                    status={state.status}
                    label={state.label}
                    tone={state.tone}
                    size="sm"
                  />
                  <span className="text-[10px] text-app-muted">
                    最近测试：
                    {lastCheck === null || lastCheck === undefined ? (
                      '未测试'
                    ) : (
                      <>
                        <RelativeTime value={lastCheck.at} /> · {lastCheck.latencyMs} ms
                      </>
                    )}
                  </span>
                </span>
              </button>
              <div className="flex shrink-0 flex-col gap-0.5">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  title="测试连接"
                  aria-label={`测试 ${profile.name} 的连接`}
                  loading={testing}
                  icon={<Zap className="h-3.5 w-3.5" />}
                  onClick={() => props.onTest(profile)}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  title="编辑档案"
                  aria-label={`编辑 ${profile.name}`}
                  onClick={() => props.onEdit(profile)}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-app-danger"
                  title="删除档案"
                  aria-label={`删除 ${profile.name}`}
                  onClick={() => props.onDelete(profile)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
