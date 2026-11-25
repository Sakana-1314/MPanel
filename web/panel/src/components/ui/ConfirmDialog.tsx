import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from './Button';
import { Modal } from './Modal';

export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}

/** 危险操作确认；onConfirm 可返回 Promise，内部显示 loading 并防重复点击。 */
export function ConfirmDialog(props: ConfirmDialogProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const loading = props.loading === true || busy;

  useEffect(() => {
    if (!props.open) setBusy(false);
  }, [props.open]);

  const handleConfirm = async (): Promise<void> => {
    if (loading) return;
    setBusy(true);
    try {
      await props.onConfirm();
    } catch {
      // 失败时保持对话框打开，错误提示由调用方（mutation/toast）负责。
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={props.open}
      onClose={loading ? () => undefined : props.onCancel}
      title={props.title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={props.onCancel} disabled={loading}>
            {props.cancelLabel ?? '取消'}
          </Button>
          <Button
            variant={props.danger === false ? 'primary' : 'danger'}
            size="sm"
            loading={loading}
            onClick={() => {
              void handleConfirm();
            }}
          >
            {props.confirmLabel ?? '确认'}
          </Button>
        </>
      }
    >
      <div className="text-sm leading-relaxed text-app-muted">{props.message}</div>
    </Modal>
  );
}
