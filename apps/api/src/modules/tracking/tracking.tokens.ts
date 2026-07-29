/**
 * The telemetry connection pool (ADR-005 requirement 4).
 *
 * Physically separate from `POSTGRES_CLIENT` so a burst of GPS ingest cannot
 * exhaust the connections the business API needs, and a slow business
 * transaction cannot stall position writes. Same `dp_app` role — RLS applies
 * identically; this is pool isolation, not a second identity.
 */
export const TELEMETRY_POSTGRES_CLIENT = Symbol("TELEMETRY_POSTGRES_CLIENT");

/**
 * A dedicated Valkey connection for realtime pub/sub.
 *
 * A client in subscriber mode may only issue subscribe/unsubscribe commands, so
 * it cannot be the shared `VALKEY_CLIENT` that presence, dedup, and the feature
 * cache all run their ordinary GET/SET traffic through.
 */
export const REALTIME_SUBSCRIBER = Symbol("REALTIME_SUBSCRIBER");
