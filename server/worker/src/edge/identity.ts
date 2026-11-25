import { chmod, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '../store.js';

/**
 * `$MPANEL_HOME/edge.json` — locally persisted edge identity.
 *
 * Written atomically (tmp + fsync + rename) with mode 0600. It stores the
 * one-time machine secret plus the loopback MPANEL_TOKEN so an offline node
 * restarts with the same identity (docs/api-contract.md §5.4 design).
 */

export interface EdgeIdentity {
  schemaVersion: 1;
  /** SHA-256 of MPANEL_EDGE_KEY; a changed key forces re-enrollment. */
  keyFingerprint: string;
  machineId: string;
  secret: string;
  wsUrl: string;
  /** Core HTTP(S) base used for this enrollment (diagnostics only). */
  coreUrl: string;
  /** Worker-local loopback token (MPANEL_TOKEN); never sent to core. */
  token: string;
  platform: string;
  arch: string;
  version: string;
  enrolledAt: string;
  updatedAt: string;
}

export function edgeIdentityPath(home: string): string {
  return path.join(home, 'edge.json');
}

export async function readEdgeIdentity(home: string): Promise<EdgeIdentity | null> {
  let raw: string;
  try {
    raw = await readFile(edgeIdentityPath(home), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    if (parsed.schemaVersion !== 1) return null;
    const identity: EdgeIdentity = {
      schemaVersion: 1,
      keyFingerprint: requiredString(parsed.keyFingerprint),
      machineId: requiredString(parsed.machineId),
      secret: requiredString(parsed.secret),
      wsUrl: requiredString(parsed.wsUrl),
      coreUrl: requiredString(parsed.coreUrl),
      token: requiredString(parsed.token),
      platform: typeof parsed.platform === 'string' ? parsed.platform : process.platform,
      arch: typeof parsed.arch === 'string' ? parsed.arch : process.arch,
      version: typeof parsed.version === 'string' ? parsed.version : '0.0.0',
      enrolledAt: requiredString(parsed.enrolledAt),
      updatedAt: requiredString(parsed.updatedAt),
    };
    return identity;
  } catch {
    return null;
  }
}

export async function writeEdgeIdentity(home: string, identity: EdgeIdentity): Promise<void> {
  const file = edgeIdentityPath(home);
  await writeFileAtomic(file, `${JSON.stringify(identity, null, 2)}\n`);
  await chmod(file, 0o600).catch(() => undefined);
}

export async function removeEdgeIdentity(home: string): Promise<void> {
  await rm(edgeIdentityPath(home), { force: true }).catch(() => undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('invalid edge identity');
  return value;
}
