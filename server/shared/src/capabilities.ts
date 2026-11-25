import { z } from 'zod';

export const CAPABILITY_NAMES = ['caddy', 'docker', 'postgres', 'redis', 'pty'] as const;

export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

/**
 * A capability is a host-level probe. It is intentionally independent from any
 * individual resource profile: `postgres.available=false` means the driver or
 * required tools are missing, not that a particular database is down.
 */
export const capabilityStatusSchema = z.object({
  available: z.boolean(),
  version: z.string().optional(),
  reason: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export type CapabilityStatus = z.infer<typeof capabilityStatusSchema>;

export const capabilitiesSchema = z.object({
  caddy: capabilityStatusSchema,
  docker: capabilityStatusSchema,
  postgres: capabilityStatusSchema,
  redis: capabilityStatusSchema,
  pty: capabilityStatusSchema,
});

export type Capabilities = z.infer<typeof capabilitiesSchema>;

/**
 * Request-time capability source. Modules receive this provider (not a
 * startup snapshot) so installing Caddy/Docker or a transient probe failure
 * is reflected without restarting the worker.
 */
export interface CapabilityProvider {
  get(force?: boolean): Promise<Capabilities>;
  snapshot(): Capabilities;
}


export function availableCapability(version?: string, details?: Record<string, unknown>): CapabilityStatus {
  return {
    available: true,
    ...(version === undefined ? {} : { version }),
    ...(details === undefined ? {} : { details }),
  };
}

export function unavailableCapability(reason: string, details?: Record<string, unknown>): CapabilityStatus {
  return {
    available: false,
    reason,
    ...(details === undefined ? {} : { details }),
  };
}

/** Used by core, which has no local feature capabilities. */
export function allCapabilitiesUnavailable(reason: string): Capabilities {
  return {
    caddy: unavailableCapability(reason),
    docker: unavailableCapability(reason),
    postgres: unavailableCapability(reason),
    redis: unavailableCapability(reason),
    pty: unavailableCapability(reason),
  };
}

export function isCapabilityAvailable(capabilities: Capabilities, name: CapabilityName): boolean {
  return capabilities[name].available;
}
