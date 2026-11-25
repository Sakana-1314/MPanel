export function joinUrl(base: string, path: string): string {
  if (base.length === 0) return path;
  const trimmed = base.endsWith('/') ? base.slice(0, -1) : base;
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${trimmed}${suffix}`;
}

export function toWsUrl(base: string): string {
  if (base.startsWith('https://')) return `wss://${base.slice('https://'.length)}`;
  if (base.startsWith('http://')) return `ws://${base.slice('http://'.length)}`;
  if (base.startsWith('wss://') || base.startsWith('ws://')) return base;
  if (typeof window !== 'undefined') {
    const origin = window.location.origin;
    return toWsUrl(joinUrl(origin, base));
  }
  return base;
}

/** Absolute redeem URLs are used as-is; relative ones are joined to the API base. */
export function resolveRedeemUrl(redeemUrl: string, basePath: string): string {
  if (redeemUrl.startsWith('http://') || redeemUrl.startsWith('https://')) return redeemUrl;
  return joinUrl(basePath, redeemUrl);
}

/** dbx reads the ticket from the URL fragment so it never reaches access logs. */
export function buildHandoffFrameUrl(dbxUrl: string, endpoint: string, ticket: string): string {
  const separator = dbxUrl.includes('#') ? '&' : '#';
  return `${dbxUrl}${separator}handoff=${encodeURIComponent(ticket)}&endpoint=${encodeURIComponent(endpoint)}`;
}
