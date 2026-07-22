import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Ambient tenant context.
 *
 * Tenant identity is established ONCE at the request boundary and flows
 * implicitly through every layer. It is deliberately not threaded through
 * function signatures: any design that requires developers to remember to pass
 * `tenantId` will leak within months, and the leak appears in the least-tested
 * code paths (docs/07-security-architecture.md §5.3).
 *
 * The value here is what gets written to `app.current_tenant_id` inside each
 * transaction, which is what PostgreSQL Row-Level Security reads.
 */

/** Branded so a raw string cannot be passed where a tenant id is expected. */
export type TenantId = string & { readonly __brand: "TenantId" };

export function asTenantId(value: string): TenantId {
  return value as TenantId;
}

/**
 * The all-zero UUID. `dp_app` defaults to this at the role level, so a query
 * that somehow runs without a tenant context matches zero rows rather than
 * every row — fail closed, not open.
 */
export const NO_TENANT = asTenantId("00000000-0000-0000-0000-000000000000");

export interface TenantContextState {
  readonly tenantId: TenantId;
  /** Present for authenticated actors; absent for system/background work. */
  readonly actorId?: string;
  readonly actorType?: "user" | "driver" | "system" | "api_client";
  /** Correlates a request with everything it causes, including async fan-out. */
  readonly requestId?: string;
}

const storage = new AsyncLocalStorage<TenantContextState>();

export const TenantContext = {
  /** Runs `fn` with the given tenant context bound to the async execution path. */
  run<T>(state: TenantContextState, fn: () => T): T {
    return storage.run(state, fn);
  },

  /** Current context, or `undefined` outside any bound scope. */
  current(): TenantContextState | undefined {
    return storage.getStore();
  },

  /**
   * Current tenant id, throwing when absent.
   *
   * Used by the database layer: rather than silently falling back to
   * NO_TENANT and returning an empty result set that looks like "no data",
   * an unbound query is a programming error and fails loudly.
   */
  requireTenantId(): TenantId {
    const state = storage.getStore();
    if (state === undefined) {
      throw new Error(
        "No tenant context bound. Every tenant-scoped operation must run inside TenantContext.run(). " +
          "Background jobs and event consumers must re-establish context from the job/event payload.",
      );
    }
    return state.tenantId;
  },
} as const;
