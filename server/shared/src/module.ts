import type { CapabilityName, CapabilityProvider } from './capabilities.js';

export interface ModuleLogger {
  debug(message: string, details?: Record<string, unknown>): void;
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

/**
 * Worker modules are registered exactly once, after the HTTP app is built and
 * before any transport starts. `prefixes` is advisory metadata for diagnostics
 * and ownership checks; the registry mounts `register()` once inside a child
 * Fastify instance rooted at /api/v1. Modules therefore register full
 * API-relative paths (e.g. '/containers', '/images', '/stacks') and may own
 * several prefixes. TApp is FastifyInstance in the worker; it is generic here
 * so @mpanel/shared does not depend on fastify.
 */
export interface ModuleRegistration<
  TApp = unknown,
  TContext extends ModuleContext<TApp> = ModuleContext<TApp>,
> {
  /** Stable module name used in logs and diagnostics. */
  name: string;
  /** One or more API-relative prefixes owned by this module, e.g. ['/containers','/images','/stacks']. */
  prefixes: readonly string[];
  /** Advisory capability list; never used to abort worker startup. */
  requires?: readonly CapabilityName[];
  register(context: TContext): void | Promise<void>;
}

export interface ModuleContext<TApp = unknown> {
  /** Fastify instance already scoped to /api/v1. */
  app: TApp;
  /** Request-time capability provider; do not cache the result across requests. */
  capabilities: CapabilityProvider;
  homeDir: string;
  logger: ModuleLogger;
}
