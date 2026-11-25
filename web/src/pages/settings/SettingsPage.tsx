import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { changePassword } from '../../api/auth';
import { useSession } from '../../lib/use-session';
import { useActiveConnection } from '../../lib/connection-store';
import { useAppMutation } from '../../lib/mutations';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Card, CardBody, CardHeader, PageHeader } from '../../components/ui';
import { FormField } from '../../components/ui/FormField';
import { Input } from '../../components/ui/Input';
import { AboutPanel } from './AboutPanel';
import { ConnectionsPanel } from './ConnectionsPanel';

export default function SettingsPage(): JSX.Element {
  const connection = useActiveConnection();
  const session = useSession();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const canChangePassword =
    connection?.kind === 'core' && session.status === 'authenticated' && session.me?.authType === 'session';

  const mutation = useAppMutation({
    mutationFn: () => changePassword({ currentPassword, newPassword }),
    successMessage: '密码已更新',
    successDescription: '其他会话已失效，当前会话保持登录。',
    onSuccess: () => {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    },
  });

  const submit = (): void => {
    if (newPassword.length < 10) {
      setError('新密码至少 10 个字符。');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致。');
      return;
    }
    setError(null);
    mutation.mutate();
  };

  return (
    <div>
      <PageHeader title="设置" description="连接、账号安全与构建信息。" />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="连接"
            description="worker token 默认只保存在当前浏览器会话中。"
            actions={<Badge tone="neutral">{session.me?.role ?? connection?.kind ?? '—'}</Badge>}
          />
          <CardBody>
            <ConnectionsPanel />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="关于" description="当前后端版本与运行时配置。" />
          <CardBody>
            <AboutPanel />
          </CardBody>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader
            title="修改密码"
            description="仅 core 会话登录可用；静态 Bearer token 无法修改密码。"
          />
          <CardBody>
            {canChangePassword ? (
              <form
                className="grid gap-3 md:grid-cols-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  submit();
                }}
              >
                <FormField label="当前密码" required htmlFor="current-password">
                  <Input
                    id="current-password"
                    type="password"
                    value={currentPassword}
                    autoComplete="current-password"
                    onChange={(event) => setCurrentPassword(event.target.value)}
                  />
                </FormField>
                <FormField label="新密码" required htmlFor="new-password" description="至少 10 个字符。">
                  <Input
                    id="new-password"
                    type="password"
                    value={newPassword}
                    autoComplete="new-password"
                    onChange={(event) => setNewPassword(event.target.value)}
                  />
                </FormField>
                <FormField label="确认新密码" required htmlFor="confirm-password" error={error}>
                  <Input
                    id="confirm-password"
                    type="password"
                    value={confirmPassword}
                    autoComplete="new-password"
                    onChange={(event) => setConfirmPassword(event.target.value)}
                  />
                </FormField>
                <div className="flex items-end md:col-span-3">
                  <Button
                    type="submit"
                    size="sm"
                    icon={<KeyRound className="h-3.5 w-3.5" />}
                    loading={mutation.isPending}
                    disabled={
                      currentPassword.length === 0 ||
                      newPassword.length === 0 ||
                      confirmPassword.length === 0
                    }
                  >
                    更新密码
                  </Button>
                </div>
              </form>
            ) : (
              <p className="text-xs text-app-muted">
                当前连接不是 core 会话登录（可能是 worker 直连或静态 token），因此无法通过面板修改密码。
              </p>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
