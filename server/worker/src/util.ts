import { PanelError } from '@mpanel/shared';
import type { CapabilityName, CapabilityProvider, ListResult } from '@mpanel/shared';

export function listResult<T>(items: T[], extra?: Partial<ListResult<T>>): ListResult<T> {
  return { available: true, items, ...(extra ?? {}) };
}

export function unavailableList<T>(reason: string): ListResult<T> {
  return { available: false, reason, items: [] };
}

export function parsePage(q: { limit?: unknown; cursor?: unknown }): {
  limit: number;
  cursor?: string;
} {
  const limit = typeof q.limit === 'number' ? q.limit : Number(q.limit ?? 50);
  const normalized =
    Number.isInteger(limit) && limit >= 1 && limit <= 200 ? limit : 50;
  return typeof q.cursor === 'string' && q.cursor.length > 0
    ? { limit: normalized, cursor: q.cursor }
    : { limit: normalized };
}

export function isTruthyQuery(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    return value === 'true' || value === '1';
  }
  return false;
}

/** Request-time capability gate for module writes. */
export async function assertCapability(
  caps: CapabilityProvider,
  name: CapabilityName,
): Promise<void> {
  const capabilities = await caps.get();
  const status = capabilities[name];
  if (!status.available) {
    throw new PanelError(
      'UNAVAILABLE',
      `${name} is not available on this worker`,
      {
        capability: name,
        reason: status.reason,
        hint: `Install/configure ${name} on the worker host, then retry.`,
      },
    );
  }
}

export function toIso(value: Date | number): string {
  return new Date(value).toISOString();
}
