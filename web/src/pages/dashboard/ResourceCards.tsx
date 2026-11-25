import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import type { ListResult } from '../../api/types';
import { describeError } from '../../api/errors';
import { Card, CardBody } from '../../components/ui/Card';

export interface ResourceCardItem {
  key: string;
  label: string;
  icon: ReactNode;
  /** 列表页路径（卡片右下角“查看”）。 */
  to: string;
  loading: boolean;
  error: unknown;
  /** worker 直连或 core 已选择机器。 */
  enabled: boolean;
  data?: ListResult<unknown>;
  value: ReactNode;
  hint: ReactNode;
  /** available=false 时可执行的提示。 */
  unavailableHint: string;
}

function ResourceCard(props: ResourceCardItem): JSX.Element {
  const errorInfo = props.error === undefined || props.error === null
    ? undefined
    : describeError(props.error);
  const unavailable = props.data?.available === false;

  return (
    <Card className="flex h-full flex-col">
      <CardBody className="flex h-full flex-col p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-xs font-medium text-app-muted">
            <span className="text-app-muted">{props.icon}</span>
            {props.label}
          </span>
        </div>

        <div className="mt-2 flex flex-1 flex-col justify-start gap-1">
          {!props.enabled ? (
            <>
              <span className="text-xl font-semibold text-app-muted">—</span>
              <span className="text-xs leading-relaxed text-app-muted">
                需要先选择目标机器（core 连接）。
              </span>
            </>
          ) : props.loading ? (
            <>
              <span className="skeleton inline-block h-7 w-16" />
              <span className="skeleton inline-block h-2.5 w-3/4" />
            </>
          ) : errorInfo !== undefined ? (
            <>
              <span className="text-xl font-semibold text-app-danger">不可用</span>
              <span className="text-[10px] font-medium text-app-danger">{errorInfo.title}</span>
              <span className="break-words text-xs leading-relaxed text-app-muted">
                {errorInfo.description}
              </span>
              <span className="break-words text-xs leading-relaxed text-app-text">
                {errorInfo.hint}
              </span>
            </>
          ) : unavailable ? (
            <>
              <span className="text-xl font-semibold text-app-warning">不可用</span>
              <span className="break-words text-xs leading-relaxed text-app-muted">
                {props.data?.reason ?? '后端返回 available=false，未给出原因。'}
              </span>
              <span className="break-words text-xs leading-relaxed text-app-text">
                {props.unavailableHint}
              </span>
            </>
          ) : (
            <>
              <span className="text-2xl font-semibold tabular-nums text-app-text">
                {props.value}
              </span>
              <span className="text-xs leading-relaxed text-app-muted">{props.hint}</span>
            </>
          )}
        </div>

        <div className="mt-2 flex justify-end border-t border-app-border/60 pt-2">
          <Link
            to={props.to}
            className="inline-flex items-center gap-0.5 text-[11px] text-app-muted transition-colors hover:text-app-accent"
          >
            查看
            <ChevronRight className="h-3 w-3" />
          </Link>
        </div>
      </CardBody>
    </Card>
  );
}

export function ResourceCards(props: { items: readonly ResourceCardItem[] }): JSX.Element {
  return (
    <section>
      <div className="mb-2">
        <h2 className="text-sm font-semibold text-app-text">资源</h2>
        <p className="text-xs text-app-muted">
          复用既有列表端点；单个卡片不可用不会影响整页，其他卡片仍可正常显示。
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
        {props.items.map((item) => (
          <ResourceCard {...item} key={item.key} />
        ))}
      </div>
    </section>
  );
}
