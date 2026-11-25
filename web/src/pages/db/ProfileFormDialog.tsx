import { useEffect, useState } from 'react';
import { Eye, EyeOff, Save } from 'lucide-react';
import type {
  DatabaseProfile,
  DatabaseProfileCreateInput,
  DatabaseProfileUpdateInput,
} from '../../api/types';
import { createProfile, databasesKeys, updateProfile } from '../../api/databases';
import { AppError, describeError } from '../../api/errors';
import { useAppMutation } from '../../lib/mutations';
import { formatDate } from '../../lib/format';
import { Alert } from '../../components/ui/Alert';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Drawer } from '../../components/ui/Drawer';
import { FormField } from '../../components/ui/FormField';
import { Input } from '../../components/ui/Input';
import { Select } from '../../components/ui/Select';
import { Switch } from '../../components/ui/Switch';
import { Textarea } from '../../components/ui/Textarea';
import {
  DEFAULT_PORT,
  ENGINE_LABEL,
  profileNotes,
  type DatabaseKind,
} from './ProfileList';

interface DraftState {
  name: string;
  kind: DatabaseKind;
  host: string;
  port: string;
  username: string;
  password: string;
  database: string;
  redisDb: string;
  tls: boolean;
  notes: string;
}

type FieldErrors = Partial<Record<'name' | 'host' | 'port' | 'redisDb', string>>;

const EMPTY_DRAFT: DraftState = {
  name: '',
  kind: 'postgres',
  host: '',
  port: String(DEFAULT_PORT.postgres),
  username: '',
  password: '',
  database: '',
  redisDb: '0',
  tls: false,
  notes: '',
};

function draftFromProfile(profile: DatabaseProfile): DraftState {
  return {
    name: profile.name,
    kind: profile.kind,
    host: profile.host,
    port: String(profile.port),
    username: profile.username ?? '',
    password: '',
    database: profile.database ?? '',
    redisDb: String(profile.redisDb ?? 0),
    tls: profile.tls,
    notes: profileNotes(profile),
  };
}

function validate(draft: DraftState): FieldErrors {
  const errors: FieldErrors = {};
  if (draft.name.trim().length === 0) errors.name = '请输入档案名称。';
  if (draft.host.trim().length === 0) errors.host = '请输入主机地址（IP 或域名）。';
  const port = Number(draft.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    errors.port = '端口需为 1–65535 的整数。';
  }
  if (draft.kind === 'redis') {
    const redisDb = Number(draft.redisDb);
    if (!Number.isInteger(redisDb) || redisDb < 0 || redisDb > 15) {
      errors.redisDb = 'Redis DB 需为 0–15 的整数。';
    }
  }
  return errors;
}

type ProfileCreateBody = DatabaseProfileCreateInput & { notes?: string | null };
type ProfileUpdateBody = DatabaseProfileUpdateInput & { notes?: string | null };

function toCreateInput(draft: DraftState): ProfileCreateBody {
  const input: ProfileCreateBody = {
    name: draft.name.trim(),
    kind: draft.kind,
    host: draft.host.trim(),
    port: Number(draft.port),
    tls: draft.tls,
    notes: draft.notes.trim().length > 0 ? draft.notes.trim() : null,
  };
  const username = draft.username.trim();
  if (username.length > 0) input.username = username;
  if (draft.password.length > 0) input.password = draft.password;
  if (draft.kind === 'postgres') {
    const database = draft.database.trim();
    if (database.length > 0) input.database = database;
  } else {
    input.redisDb = Number(draft.redisDb);
  }
  return input;
}

function toUpdateInput(draft: DraftState, clearPassword: boolean): ProfileUpdateBody {
  const username = draft.username.trim();
  const input: ProfileUpdateBody = {
    name: draft.name.trim(),
    host: draft.host.trim(),
    port: Number(draft.port),
    username: username.length > 0 ? username : null,
    tls: draft.tls,
    database: draft.kind === 'postgres' ? draft.database.trim() || null : null,
    redisDb: draft.kind === 'redis' ? Number(draft.redisDb) : null,
    notes: draft.notes.trim().length > 0 ? draft.notes.trim() : null,
  };
  if (clearPassword) input.password = null;
  else if (draft.password.length > 0) input.password = draft.password;
  return input;
}

export interface ProfileFormDialogProps {
  open: boolean;
  onClose: () => void;
  profile?: DatabaseProfile;
  onSaved: (profile: DatabaseProfile) => void;
}

/** 新建/编辑数据库档案抽屉。密码只写不读，输入框默认隐藏并可临时明文显示。 */
export function ProfileFormDialog(props: ProfileFormDialogProps): JSX.Element {
  const editing = props.profile !== undefined;
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [revealed, setRevealed] = useState(false);
  const [clearPassword, setClearPassword] = useState(false);

  const createMutation = useAppMutation<DatabaseProfile, DraftState>({
    mutationFn: (value) => createProfile(toCreateInput(value)),
    successMessage: (saved) => `已创建数据库档案 ${saved.name}`,
    successDescription: '密码只写不读；保存后 API 不会返回明文密码。',
    invalidate: [databasesKeys.profiles()],
    onSuccess: (saved) => {
      props.onSaved(saved);
      props.onClose();
    },
  });

  const editingId = props.profile?.id;
  const updateMutation = useAppMutation<DatabaseProfile, DraftState>({
    mutationFn: (value) => {
      if (editingId === undefined) {
        return Promise.reject(
          new AppError('INTERNAL', '缺少正在编辑的档案', 0, {
            hint: '请关闭表单后重新打开档案再试。',
          }),
        );
      }
      return updateProfile(editingId, toUpdateInput(value, clearPassword));
    },
    successMessage: (saved) => `已保存档案 ${saved.name}`,
    successDescription: '连接参数已更新；建议重新测试连接并刷新统计。',
    invalidate: [databasesKeys.profiles()],
    onSuccess: (saved) => {
      props.onSaved(saved);
      props.onClose();
    },
  });

  // 打开/切换档案时重置表单与错误，避免带上一次编辑的残留状态。
  useEffect(() => {
    if (!props.open) return;
    setDraft(props.profile === undefined ? EMPTY_DRAFT : draftFromProfile(props.profile));
    setErrors({});
    setRevealed(false);
    setClearPassword(false);
    createMutation.reset();
    updateMutation.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open, props.profile?.id]);

  // 明文密码只在短暂窗口内显示，避免长时间暴露在屏幕上。
  useEffect(() => {
    if (!revealed) return;
    const timer = setTimeout(() => setRevealed(false), 10_000);
    return () => clearTimeout(timer);
  }, [revealed]);

  const busy = createMutation.isPending || updateMutation.isPending;
  const activeError = editing ? updateMutation.error : createMutation.error;

  const patch = (next: Partial<DraftState>): void => {
    setDraft((current) => ({ ...current, ...next }));
  };

  const clearError = (key: keyof FieldErrors): void => {
    setErrors((current) => {
      if (current[key] === undefined) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  const changeKind = (kind: DatabaseKind): void => {
    setDraft((current) => {
      const previousDefault = String(DEFAULT_PORT[current.kind]);
      const keepPort = current.port.trim().length > 0 && current.port !== previousDefault;
      return {
        ...current,
        kind,
        port: keepPort ? current.port : String(DEFAULT_PORT[kind]),
        redisDb: kind === 'redis' && current.redisDb.trim().length === 0 ? '0' : current.redisDb,
      };
    });
  };

  const submit = (): void => {
    const nextErrors = validate(draft);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    if (editing) updateMutation.mutate(draft);
    else createMutation.mutate(draft);
  };

  const errorInfo = activeError === null ? null : describeError(activeError);

  return (
    <Drawer
      open={props.open}
      onClose={busy ? () => undefined : props.onClose}
      title={editing ? `编辑数据库档案：${props.profile?.name ?? ''}` : '新建数据库档案'}
      description="密码只写不读；API 永不返回明文密码。"
      size="lg"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={props.onClose} disabled={busy}>
            取消
          </Button>
          <Button
            type="submit"
            form="db-profile-form"
            size="sm"
            loading={busy}
            icon={<Save className="h-3.5 w-3.5" />}
          >
            {editing ? '保存修改' : '创建档案'}
          </Button>
        </>
      }
    >
      <form
        id="db-profile-form"
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {errorInfo !== null ? (
          <Alert tone="danger" title={errorInfo.title} hint={errorInfo.hint}>
            {errorInfo.description}
          </Alert>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <FormField
            label="名称"
            htmlFor="db-profile-name"
            required
            error={errors.name}
            className="sm:col-span-2"
          >
            <Input
              id="db-profile-name"
              value={draft.name}
              invalid={errors.name !== undefined}
              maxLength={120}
              placeholder="例如：生产主库 / 缓存节点"
              autoFocus
              onChange={(event) => {
                patch({ name: event.target.value });
                clearError('name');
              }}
            />
          </FormField>

          <FormField
            label="引擎"
            htmlFor="db-profile-kind"
            description={
              editing
                ? '引擎类型创建后不可修改（PATCH 不支持 kind）；如需切换请新建档案。'
                : 'PostgreSQL 与 Redis 的默认端口、备份格式不同。'
            }
          >
            <Select
              id="db-profile-kind"
              value={draft.kind}
              disabled={editing}
              options={[
                { value: 'postgres', label: ENGINE_LABEL.postgres },
                { value: 'redis', label: ENGINE_LABEL.redis },
              ]}
              onChange={(event) =>
                changeKind(event.target.value === 'redis' ? 'redis' : 'postgres')
              }
            />
          </FormField>

          <FormField label="主机" htmlFor="db-profile-host" required error={errors.host}>
            <Input
              id="db-profile-host"
              value={draft.host}
              invalid={errors.host !== undefined}
              maxLength={255}
              placeholder="127.0.0.1 或 db.example.com"
              onChange={(event) => {
                patch({ host: event.target.value });
                clearError('host');
              }}
            />
          </FormField>

          <FormField
            label="端口"
            htmlFor="db-profile-port"
            required
            error={errors.port}
            description={`默认端口 ${DEFAULT_PORT[draft.kind]}`}
          >
            <Input
              id="db-profile-port"
              type="number"
              inputMode="numeric"
              min={1}
              max={65535}
              value={draft.port}
              invalid={errors.port !== undefined}
              placeholder={String(DEFAULT_PORT[draft.kind])}
              onChange={(event) => {
                patch({ port: event.target.value });
                clearError('port');
              }}
            />
          </FormField>

          <FormField
            label={draft.kind === 'redis' ? '用户名（ACL，可选）' : '用户名'}
            htmlFor="db-profile-username"
            description={
              draft.kind === 'redis'
                ? 'Redis 6+ ACL 用户名；留空表示 default 用户。'
                : 'PostgreSQL 登录角色；留空时由服务器决定。'
            }
          >
            <Input
              id="db-profile-username"
              value={draft.username}
              autoComplete="off"
              maxLength={255}
              placeholder={draft.kind === 'redis' ? 'default' : 'postgres'}
              onChange={(event) => patch({ username: event.target.value })}
            />
          </FormField>

          <FormField
            label={
              <span className="flex items-center gap-1.5">
                密码
                {editing && props.profile?.hasPassword === true ? (
                  <Badge tone="success">已保存</Badge>
                ) : null}
              </span>
            }
            htmlFor="db-profile-password"
            description={
              revealed
                ? '密码已临时明文显示，10 秒后自动隐藏。'
                : editing && props.profile?.hasPassword === true
                  ? '已保存密码，默认隐藏；留空表示保持不变。'
                  : '密码只写不读，保存后 API 不会返回明文。'
            }
          >
            <Input
              id="db-profile-password"
              type={revealed ? 'text' : 'password'}
              value={draft.password}
              disabled={clearPassword}
              autoComplete="new-password"
              maxLength={1024}
              placeholder={editing && props.profile?.hasPassword === true ? '留空不修改' : '可选'}
              onChange={(event) => {
                const value = event.target.value;
                patch({ password: value });
                if (value.length > 0) setClearPassword(false);
              }}
              trailing={
                <button
                  type="button"
                  className="rounded p-1 hover:bg-app-elevated hover:text-app-text"
                  aria-label={revealed ? '隐藏密码' : '显示密码'}
                  title={revealed ? '隐藏密码' : '临时显示密码（10 秒）'}
                  onClick={() => setRevealed((current) => !current)}
                >
                  {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              }
            />
          </FormField>

          {editing && props.profile?.hasPassword === true ? (
            <div className="sm:col-span-2">
              <Switch
                id="db-profile-clear-password"
                checked={clearPassword}
                label="清除已保存的密码"
                description="保存后将删除密文；目标数据库若要求密码，后续测试/统计/备份会失败。"
                onChange={(checked) => {
                  setClearPassword(checked);
                  if (checked) patch({ password: '' });
                }}
              />
            </div>
          ) : null}

          {draft.kind === 'postgres' ? (
            <FormField
              label="数据库"
              htmlFor="db-profile-database"
              description="留空时连接与用户名同名的数据库（PostgreSQL 默认行为）。"
            >
              <Input
                id="db-profile-database"
                value={draft.database}
                maxLength={255}
                placeholder="postgres"
                onChange={(event) => patch({ database: event.target.value })}
              />
            </FormField>
          ) : (
            <FormField
              label="Redis DB"
              htmlFor="db-profile-redis-db"
              required
              error={errors.redisDb}
              description="逻辑数据库编号 0–15（与 SELECT 的索引一致）。"
            >
              <Input
                id="db-profile-redis-db"
                type="number"
                inputMode="numeric"
                min={0}
                max={15}
                value={draft.redisDb}
                invalid={errors.redisDb !== undefined}
                onChange={(event) => {
                  patch({ redisDb: event.target.value });
                  clearError('redisDb');
                }}
              />
            </FormField>
          )}

          <div className="sm:col-span-2">
            <Switch
              id="db-profile-tls"
              checked={draft.tls}
              label="SSL / TLS"
              description={
                draft.kind === 'postgres'
                  ? '启用后 PostgreSQL 使用 sslmode=require。'
                  : '启用后 Redis 使用 TLS（rediss）连接。'
              }
              onChange={(checked) => patch({ tls: checked })}
            />
          </div>

          <FormField
            label="备注"
            htmlFor="db-profile-notes"
            description="备注随档案保存在 worker 的 notes 字段中，不会写入日志或备份文件名。"
            className="sm:col-span-2"
          >
            <Textarea
              id="db-profile-notes"
              rows={2}
              maxLength={2000}
              value={draft.notes}
              placeholder="例如：仅允许内网访问；变更窗口每周日 02:00"
              onChange={(event) => patch({ notes: event.target.value })}
            />
          </FormField>
        </div>

        {editing ? (
          <p className="text-[11px] text-app-muted">
            创建于 {props.profile === undefined ? '—' : formatDate(props.profile.createdAt)} · 更新于{' '}
            {props.profile === undefined ? '—' : formatDate(props.profile.updatedAt)}
          </p>
        ) : null}
      </form>
    </Drawer>
  );
}
