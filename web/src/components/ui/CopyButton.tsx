import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from './Button';
import type { ButtonProps } from './Button';

export interface CopyButtonProps {
  value: string;
  label?: string;
  /** 不传 label 时使用纯图标按钮。 */
  size?: ButtonProps['size'];
  variant?: ButtonProps['variant'];
  className?: string;
  title?: string;
  onCopied?: () => void;
}

export function CopyButton(props: CopyButtonProps): JSX.Element {
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    const ok = await copyText(props.value);
    if (!ok) return;
    setCopied(true);
    props.onCopied?.();
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Button
      variant={props.variant ?? 'ghost'}
      size={props.size ?? (props.label === undefined ? 'icon' : 'sm')}
      className={props.className}
      title={props.title ?? '复制'}
      aria-label={props.title ?? '复制'}
      icon={copied ? <Check className="h-3.5 w-3.5 text-app-success" /> : <Copy className="h-3.5 w-3.5" />}
      onClick={() => {
        void copy();
      }}
    >
      {props.label === undefined ? undefined : copied ? '已复制' : props.label}
    </Button>
  );
}

export async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard !== undefined && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // 回退到 execCommand。
  }
  try {
    const area = document.createElement('textarea');
    area.value = value;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
