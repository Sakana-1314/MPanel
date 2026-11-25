import { useQuery } from '@tanstack/react-query';
import { containersKeys, getStack } from '../../api/containers';
import { isAppError } from '../../api/errors';
import { Drawer } from '../../components/ui/Drawer';
import { Button } from '../../components/ui/Button';
import { ErrorState, LoadingSkeleton } from '../../components/ui/ErrorState';
import { UnavailableAlert } from '../../components/ui/Alert';
import { StackLogsPanel } from './StackLogsPanel';

export interface StackLogsDrawerProps {
  open: boolean;
  /** 编排项目名；为 null 时不请求。 */
  name: string | null;
  onClose: () => void;
}

/** 编排列表页的日志聚合抽屉。 */
export function StackLogsDrawer(props: StackLogsDrawerProps): JSX.Element {
  const stackQuery = useQuery({
    queryKey: containersKeys.stack(props.name ?? ''),
    queryFn: async () => {
      if (props.name === null) throw new Error('未选择编排项目');
      return getStack(props.name);
    },
    enabled: props.open && props.name !== null,
    retry: 1,
  });

  const stack = stackQuery.data;

  return (
    <Drawer
      open={props.open}
      onClose={props.onClose}
      title={props.name === null ? '编排日志' : `编排日志 · ${props.name}`}
      description="聚合项目内各容器的实时日志（按到达顺序）"
      size="xl"
      footer={
        <Button variant="ghost" size="sm" onClick={props.onClose}>
          关闭
        </Button>
      }
    >
      {stackQuery.isLoading ? (
        <LoadingSkeleton rows={6} />
      ) : isAppError(stackQuery.error, 'UNAVAILABLE') ? (
        <UnavailableAlert
          error={stackQuery.error}
          title="Docker 不可用"
          hint="请确认目标机器的 Docker daemon 正在运行后重试。"
        />
      ) : stackQuery.error !== null && stackQuery.error !== undefined ? (
        <ErrorState
          error={stackQuery.error}
          onRetry={() => {
            void stackQuery.refetch();
          }}
        />
      ) : stack === undefined ? (
        <ErrorState error={new Error('未找到编排项目')} title="未找到编排" />
      ) : (
        <StackLogsPanel key={stack.name} stack={stack} height="60vh" />
      )}
    </Drawer>
  );
}
