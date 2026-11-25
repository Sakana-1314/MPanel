import { useQuery } from '@tanstack/react-query';
import { getSystemInfo, systemKeys } from '../../api/system';
import { getRuntimeConfig } from '../../lib/runtime-config';
import { useActiveConnection, useSelectedMachineId } from '../../lib/connection-store';
import { useSession } from '../../lib/use-session';
import { Badge } from '../../components/ui/Badge';
import { Spinner } from '../../components/ui/Spinner';

/** 关于面板：运行时配置、版本与连接上下文。 */
export function AboutPanel(): JSX.Element {
  const config = getRuntimeConfig();
  const connection = useActiveConnection();
  const machineId = useSelectedMachineId();
  const session = useSession();
  const info = useQuery({
    queryKey: systemKeys.info(),
    queryFn: () => getSystemInfo(),
    enabled: connection !== undefined && session.status === 'authenticated',
    staleTime: 60_000,
    retry: 1,
  });

  return (
    <dl className="grid grid-cols-[7rem_1fr] items-center gap-y-2 text-sm">
      <dt className="text-xs text-app-muted">应用名</dt>
      <dd className="text-app-text">{config.appName ?? 'MPanel'}</dd>
      <dt className="text-xs text-app-muted">API 版本</dt>
      <dd className="text-app-text">v{info.data?.apiVersion ?? 1}</dd>
      <dt className="text-xs text-app-muted">协议版本</dt>
      <dd className="text-app-text">v{info.data?.protocolVersion ?? 1}</dd>
      <dt className="text-xs text-app-muted">后端</dt>
      <dd className="flex flex-wrap items-center gap-2 text-app-text">
        {connection === undefined ? (
          '未连接'
        ) : (
          <>
            <Badge tone={connection.kind === 'core' ? 'accent' : 'info'}>{connection.kind}</Badge>
            <span className="break-all font-mono text-xs">{connection.baseUrl}</span>
          </>
        )}
      </dd>
      <dt className="text-xs text-app-muted">机器</dt>
      <dd className="font-mono text-xs text-app-text">{machineId ?? '—（worker 直连或未选择）'}</dd>
      <dt className="text-xs text-app-muted">版本信息</dt>
      <dd className="text-app-text">
        {info.isLoading ? (
          <Spinner size="sm" />
        ) : info.data === undefined ? (
          '—'
        ) : (
          <span className="text-xs">
            {info.data.name} v{info.data.version} · node {info.data.nodeVersion} ·{' '}
            {info.data.platform}/{info.data.arch}
          </span>
        )}
      </dd>
      <dt className="text-xs text-app-muted">dbx</dt>
      <dd className="break-all font-mono text-xs text-app-text">{config.dbxUrl ?? '未配置'}</dd>
      <dt className="text-xs text-app-muted">默认连接</dt>
      <dd className="text-xs text-app-text">
        {config.backendSeeds === undefined || config.backendSeeds.length === 0
          ? '无（可手动新增）'
          : config.backendSeeds.map((seed) => seed.name).join('、')}
      </dd>
    </dl>
  );
}
