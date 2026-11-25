import type { EdgeJob, EdgeKey, Machine, SystemSnapshot } from '@mpanel/shared';
import type { MachineHttpRequest, MachineHttpResponse } from '../machines/types.js';

/**
 * Edge node models (docs/api-contract.md §5.4).
 * Persisted records extend the public models with the enrollment secret hash;
 * the plaintext key/secret never touches disk.
 */

export interface EdgeKeyRecord extends EdgeKey {
  /** SHA-256 hex of the one-time enrollment secret. */
  secretHash: string;
}

export interface EdgeKeyFile {
  schemaVersion: number;
  keys: EdgeKeyRecord[];
}

export interface EdgeJobFile {
  schemaVersion: number;
  jobs: EdgeJob[];
}

export interface EdgeKeyStore {
  list(): Promise<EdgeKeyRecord[]>;
  get(id: string): Promise<EdgeKeyRecord | undefined>;
  findBySecretHash(hash: string): Promise<EdgeKeyRecord | undefined>;
  create(record: EdgeKeyRecord): Promise<EdgeKeyRecord>;
  update(id: string, patch: Partial<EdgeKeyRecord>): Promise<EdgeKeyRecord>;
}

export interface EdgeJobStore {
  list(): Promise<EdgeJob[]>;
  get(id: string): Promise<EdgeJob | undefined>;
  create(job: EdgeJob): Promise<EdgeJob>;
  update(id: string, patch: Partial<EdgeJob>): Promise<EdgeJob>;
  remove(id: string): Promise<void>;
}

/** Subset of MachineService used by the edge subsystem (keeps cycles out). */
export interface EdgeMachinePort {
  get(id: string): Promise<Machine>;
  listAll(): Promise<Machine[]>;
  request(id: string, req: MachineHttpRequest): Promise<MachineHttpResponse>;
  updateSnapshot(id: string, snapshot: SystemSnapshot | null): Promise<Machine>;
  createEdgeMachine(
    input: { name: string; group: string | null; edgeKeyId: string },
    wsUrl?: string,
  ): Promise<{ machine: Machine; secret: string; wsUrl: string }>;
}

export interface EdgeEnrollContext {
  ip?: string;
  /** Request origin used to derive `wsUrl` when MPANEL_PUBLIC_URL is absent. */
  origin?: string;
}

export interface EdgeAuditDetails {
  keyId: string;
  machineId: string;
  ip?: string;
  platform?: string;
  arch?: string;
  version?: string;
  name?: string;
}
