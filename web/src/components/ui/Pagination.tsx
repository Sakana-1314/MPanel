import { Button } from './Button';

export interface PaginationProps {
  nextCursor?: string | null;
  onNext: (cursor: string) => void;
  onReset?: () => void;
  loading?: boolean;
  /** 已加载条数，仅用于展示。 */
  loaded?: number;
  className?: string;
}

/** 契约使用不透明 cursor 分页；客户端不解析 cursor。 */
export function Pagination(props: PaginationProps): JSX.Element {
  const hasNext = typeof props.nextCursor === 'string' && props.nextCursor.length > 0;
  return (
    <div className={`mt-3 flex items-center justify-between gap-2 ${props.className ?? ''}`}>
      <span className="text-xs text-app-muted">
        {props.loaded === undefined ? null : `已加载 ${props.loaded} 条`}
      </span>
      <div className="flex items-center gap-2">
        {props.onReset === undefined ? null : (
          <Button variant="ghost" size="sm" onClick={props.onReset} disabled={props.loading}>
            重置
          </Button>
        )}
        <Button
          variant="secondary"
          size="sm"
          disabled={!hasNext || props.loading}
          loading={props.loading}
          onClick={() => {
            if (hasNext && props.nextCursor !== null && props.nextCursor !== undefined) {
              props.onNext(props.nextCursor);
            }
          }}
        >
          {hasNext ? '加载更多' : '已到末尾'}
        </Button>
      </div>
    </div>
  );
}
