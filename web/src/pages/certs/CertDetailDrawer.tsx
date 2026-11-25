import type { ReactNode } from 'react';
import type { CertificateInfo } from '../../api/types';
import { formatDate, formatDaysRemaining } from '../../lib/format';
import { Alert } from '../../components/ui/Alert';
import { CopyButton } from '../../components/ui/CopyButton';
import { Drawer } from '../../components/ui/Drawer';
import { StatusBadge } from '../../components/ui/StatusBadge';

export interface CertDetailDrawerProps {
  cert: CertificateInfo | null;
  onClose: () => void;
}

/** 证书详情（只读）：域名、颁发者、有效期、指纹与来源路径。 */
export function CertDetailDrawer(props: CertDetailDrawerProps): JSX.Element {
  const cert = props.cert;

  return (
    <Drawer
      open={cert !== null}
      onClose={props.onClose}
      title={cert?.commonName ?? cert?.domains[0] ?? '证书详情'}
      description="只读信息：扫描自 Caddy 数据目录，不读取私钥。"
      size="lg"
      footer={
        <button
          type="button"
          onClick={props.onClose}
          className="rounded-md border border-app-border bg-app-elevated px-3 py-1.5 text-sm text-app-text hover:bg-app-surface"
        >
          关闭
        </button>
      }
    >
      {cert === null ? null : (
        <div className="flex flex-col gap-3">
          {cert.status === 'expired' ? (
            <Alert tone="danger" title="证书已过期" hint="Caddy 通常会自动续期；请检查 Caddy 日志与 ACME 验证是否可达。">
              {formatDaysRemaining(cert.daysRemaining)}
            </Alert>
          ) : cert.daysRemaining <= 14 ? (
            <Alert tone="warning" title="证书即将到期" hint="若 Caddy 自动续期失败，请在 Caddy 侧排查 ACME 挑战。">
              {formatDaysRemaining(cert.daysRemaining)}
            </Alert>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={cert.status} />
            <span className="text-xs text-app-muted">{formatDaysRemaining(cert.daysRemaining)}</span>
          </div>

          <dl className="grid grid-cols-[6.5rem_1fr] gap-y-2 text-sm">
            <Row label="域名">
              <div className="flex flex-wrap gap-1">
                {cert.domains.length === 0 ? (
                  '—'
                ) : (
                  cert.domains.map((domain) => (
                    <span
                      key={domain}
                      className="rounded border border-app-border bg-app-elevated px-1.5 py-0.5 font-mono text-[11px]"
                    >
                      {domain}
                    </span>
                  ))
                )}
              </div>
            </Row>
            <Row label="Common Name">{cert.commonName ?? '—'}</Row>
            <Row label="颁发者">{cert.issuer}</Row>
            <Row label="主题">{cert.subject}</Row>
            <Row label="生效时间">{formatDate(cert.notBefore)}</Row>
            <Row label="到期时间">
              <span className={cert.status === 'expired' ? 'text-app-danger' : ''}>
                {formatDate(cert.notAfter)}
              </span>
            </Row>
            <Row label="剩余天数">
              <span className="tabular-nums">{cert.daysRemaining} 天</span>
            </Row>
            <Row label="密钥类型">{cert.keyType ?? '—'}</Row>
            <Row label="来源">
              <span className="font-mono text-xs">{cert.source}</span>
            </Row>
            <Row label="序列号">
              <span className="flex items-center gap-1">
                <span className="break-all font-mono text-[11px]">{cert.serialNumber}</span>
                <CopyButton value={cert.serialNumber} title="复制序列号" />
              </span>
            </Row>
            <Row label="SHA-256 指纹">
              <span className="flex items-start gap-1">
                <span className="break-all font-mono text-[11px]">{cert.fingerprintSha256}</span>
                <CopyButton value={cert.fingerprintSha256} title="复制指纹" />
              </span>
            </Row>
            <Row label="路径">
              <span className="flex items-start gap-1">
                <span className="break-all font-mono text-[11px]">{cert.path}</span>
                <CopyButton value={cert.path} title="复制路径" />
              </span>
            </Row>
          </dl>
        </div>
      )}
    </Drawer>
  );
}

function Row(props: { label: string; children: ReactNode }): JSX.Element {
  return (
    <>
      <dt className="pt-0.5 text-xs text-app-muted">{props.label}</dt>
      <dd className="min-w-0 text-app-text">{props.children}</dd>
    </>
  );
}
