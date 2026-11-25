import { Button } from './Button';
import { CodeBlock } from './CodeBlock';

export interface SecretRevealProps {
  value: string;
  title: string;
  onDone: () => void;
  /** 额外说明，默认提示只显示一次。 */
  description?: string;
  confirmLabel?: string;
}

/** 一次性 secret（enrollment / rotate / ticket）展示；关闭后不再可取回。 */
export function SecretReveal(props: SecretRevealProps): JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-lg border border-app-warning/40 bg-app-warning/10 px-3 py-2 text-xs text-app-warning">
        该密钥只显示这一次。请立即复制并妥善保存；关闭后无法再次查看。
      </div>
      <p className="text-sm font-medium text-app-text">{props.title}</p>
      <CodeBlock code={props.value} maxHeight={180} />
      {props.description === undefined ? null : (
        <p className="text-xs text-app-muted">{props.description}</p>
      )}
      <div className="flex justify-end">
        <Button size="sm" onClick={props.onDone}>
          {props.confirmLabel ?? '我已保存'}
        </Button>
      </div>
    </div>
  );
}
