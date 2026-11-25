import { ExternalLink } from 'lucide-react';
import type { HandoffTicket } from '../../api/types';
import { createHandoff } from '../../api/databases';
import { formatDate } from '../../lib/format';
import { useAppMutation } from '../../lib/mutations';
import { Button } from '../../components/ui/Button';

export interface HandoffButtonProps {
  profileId: string;
  onTicket: (ticket: HandoffTicket) => void;
  /** 返回的票据交给调用方渲染 dbx iframe。 */
  label?: string;
  className?: string;
  disabled?: boolean;
}

/**
 * 点击后向后端申请一次性 handoff 票据（POST /databases/profiles/:id/handoff），
 * 票据只通过回调交给页面（随后放入 iframe URL fragment / postMessage），不写入任何 store。
 */
export function HandoffButton(props: HandoffButtonProps): JSX.Element {
  const mutation = useAppMutation<HandoffTicket, void>({
    mutationFn: () => createHandoff(props.profileId),
    successMessage: '已生成一次性 dbx 票据',
    successDescription: (ticket) =>
      `有效期至 ${formatDate(ticket.expiresAt)}；票据只能兑换一次，密码只在兑换时返回。`,
    onSuccess: (ticket) => props.onTicket(ticket),
  });

  return (
    <Button
      size="sm"
      variant="secondary"
      className={props.className}
      icon={<ExternalLink className="h-3.5 w-3.5" />}
      loading={mutation.isPending}
      disabled={props.disabled === true}
      title="申请一次性 handoff 票据并加载 dbx 控制台"
      onClick={() => mutation.mutate()}
    >
      {props.label ?? '打开 dbx'}
    </Button>
  );
}
