import { z } from "zod";

/**
 * Runtime configuration schema.
 *
 * Every environment variable the application reads is declared here and
 * validated once, at startup. If configuration is wrong the process refuses to
 * boot — a service that starts with a missing JWT secret or an unreachable
 * database is far more dangerous than one that fails immediately.
 *
 * `process.env` is banned everywhere else (enforced by the `no-restricted-properties`
 * ESLint rule). This module is the single boundary between the environment and
 * the application.
 */

/** Deployment topology. The platform ships in two shapes from one codebase. */
export const DeploymentMode = {
  /** Multi-tenant SaaS: many courier companies, self-serve signup, platform admin. */
  Saas: "saas",
  /** Single-tenant instance owned and run by one courier company. */
  Dedicated: "dedicated",
} as const;

export type DeploymentMode = (typeof DeploymentMode)[keyof typeof DeploymentMode];

const nodeEnvSchema = z.enum(["development", "test", "production"]);
export type NodeEnv = z.infer<typeof nodeEnvSchema>;

/** True when `value` is base64 that decodes to exactly `n` bytes. */
function decodesToBytes(value: string, n: number): boolean {
  try {
    return Buffer.from(value, "base64").length === n;
  } catch {
    return false;
  }
}

/** Secrets must be long enough to be meaningful and must not be the shipped defaults. */
const secretSchema = z
  .string()
  .min(32, "must be at least 32 characters")
  .refine((value) => !value.startsWith("dev_only_change_me"), {
    message: "must not use the placeholder value from .env.example",
  });

/** Postgres connection string, required to name a database. */
const postgresUrlSchema = z.string().refine(
  (value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "postgresql:" || url.protocol === "postgres:") &&
        url.pathname.replace(/^\//, "").length > 0
      );
    } catch {
      return false;
    }
  },
  { message: "must be a postgresql:// URL including a database name" },
);

const port = (fallback: number) => z.coerce.number().int().min(1).max(65_535).default(fallback);

const durationSeconds = (fallback: number) => z.coerce.number().int().positive().default(fallback);

export const configSchema = z
  .object({
    // ── Runtime ──────────────────────────────────────────────────────────────
    NODE_ENV: nodeEnvSchema.default("development"),
    DEPLOYMENT_MODE: z
      .enum([DeploymentMode.Saas, DeploymentMode.Dedicated])
      .default(DeploymentMode.Saas),
    PORT: port(3000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    API_BASE_URL: z.url(),
    CORS_ALLOWED_ORIGINS: z
      .string()
      .default("")
      .transform((value) =>
        value
          .split(",")
          .map((origin) => origin.trim())
          .filter((origin) => origin.length > 0),
      ),

    // ── Database ─────────────────────────────────────────────────────────────
    // Two connection strings by design: the application connects as a role
    // WITHOUT BYPASSRLS, migrations as an elevated role. See
    // docs/07-security-architecture.md §5.
    DATABASE_URL: postgresUrlSchema,
    MIGRATION_DATABASE_URL: postgresUrlSchema,
    // The outbox relay connects as `dp_relay`: a login role with SELECT+UPDATE on
    // `outbox` ONLY and a permissive RLS policy scoped to that one table, so it
    // can read every tenant's events (the relay is cross-tenant by nature) while
    // holding none of the migrator's schema power. See migration 0004 and
    // docs/07-security-architecture.md §5.
    RELAY_DATABASE_URL: postgresUrlSchema,
    DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),
    DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

    // ── Telemetry pool (ADR-005 requirement 4) ───────────────────────────────
    // GPS ingest gets its OWN connection pool, physically separate from the
    // transactional one. This is the plane separation from Blueprint §5.2 — the
    // load-bearing decision that survives even inside a single process: a burst
    // of telemetry must never exhaust the connections the business API needs,
    // and a slow business transaction must never stall position writes.
    //
    // Same `dp_app` role, so RLS applies identically — this is pool isolation,
    // not a new identity. Defaults to DATABASE_URL when unset, which keeps
    // local development a one-variable setup while production separates them.
    TELEMETRY_DATABASE_URL: postgresUrlSchema.optional(),
    TELEMETRY_POOL_MAX: z.coerce.number().int().positive().max(100).default(4),
    // How long a buffered batch may wait before it is flushed, and how many rows
    // force an early flush. docs/06-database-design.md §5.1: "flushed every 1 s
    // or 1,000 rows — never row-at-a-time INSERT. This single decision is the
    // difference between 10k/sec working and not."
    TELEMETRY_FLUSH_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),
    TELEMETRY_FLUSH_ROWS: z.coerce.number().int().positive().max(10_000).default(1_000),
    // Hard ceiling on buffered rows. A queue that grows without limit while the
    // database is slow is an out-of-memory crash, not a buffer. Past this the
    // writer sheds oldest-first: positions sample a continuous signal, so losing
    // the oldest beats losing the process.
    TELEMETRY_BUFFER_MAX_ROWS: z.coerce.number().int().positive().default(50_000),
    // Positions worse than this are rejected. A 500 m fix is noise that would
    // drag a map marker across town.
    TELEMETRY_MAX_ACCURACY_M: z.coerce.number().positive().default(200),
    // How long a driver's last-known position stays live in Valkey. Expiry IS
    // the offline signal (docs/06 §5.3), so there is no separate reaper.
    TELEMETRY_PRESENCE_TTL_S: z.coerce.number().int().positive().default(90),

    // ── Valkey ───────────────────────────────────────────────────────────────
    VALKEY_URL: z.url(),
    // Bounds how long a single Valkey command may run. The relay holds a Postgres
    // transaction (and its row locks) across the publish, so an unbounded Valkey
    // call would pin those locks indefinitely — this is the backstop.
    VALKEY_COMMAND_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

    // ── Outbox relay (docs/03-event-storming.md §2.3) ─────────────────────────
    // The Valkey Stream every relayed domain event is appended to. A single
    // stream at MVP: consumers route by the `tenantId` field in the envelope,
    // and per-tenant topics arrive with Redpanda in V2 (ADR-004).
    OUTBOX_STREAM_KEY: z.string().min(1).default("outbox.events"),
    // Approximate MAXLEN trim: the durable log is the Postgres `outbox` table and
    // (V2) Redpanda, so the stream is a delivery buffer, not the system of record.
    OUTBOX_STREAM_MAXLEN: z.coerce.number().int().positive().default(100_000),
    OUTBOX_RELAY_BATCH_SIZE: z.coerce.number().int().positive().max(1_000).default(100),
    OUTBOX_RELAY_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),
    OUTBOX_RELAY_BASE_BACKOFF_MS: z.coerce.number().int().positive().default(1_000),
    OUTBOX_RELAY_MAX_BACKOFF_MS: z.coerce.number().int().positive().default(60_000),
    // Oldest unpublished row older than this is logged at WARN — a stalled relay
    // is silent and severe (docs/06-database-design.md §4.8).
    OUTBOX_RELAY_ALERT_AGE_SECONDS: z.coerce.number().int().positive().default(60),

    // ── Event stream consumers (docs/03-event-storming.md §2.3) ────────────────
    // Consumers read the outbox stream with XREADGROUP. COUNT/BLOCK bound each
    // poll; a message redelivered more than MAX_DELIVERIES times is a poison
    // message and is routed to the per-tenant DLQ rather than blocking the group.
    EVENT_CONSUMER_BATCH_SIZE: z.coerce.number().int().positive().max(1_000).default(50),
    EVENT_CONSUMER_BLOCK_MS: z.coerce.number().int().positive().default(5_000),
    EVENT_CONSUMER_MAX_DELIVERIES: z.coerce.number().int().positive().default(5),
    // Pending entries idle longer than this are reclaimed (XPENDING/XCLAIM) from a
    // consumer that crashed mid-processing, so no message is stranded.
    EVENT_CONSUMER_CLAIM_MIN_IDLE_MS: z.coerce.number().int().positive().default(60_000),

    // ── Object storage ───────────────────────────────────────────────────────
    S3_ENDPOINT: z.url(),
    S3_REGION: z.string().min(1),
    S3_BUCKET: z.string().min(1),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    S3_FORCE_PATH_STYLE: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),

    // ── Routing ──────────────────────────────────────────────────────────────
    OSRM_URL: z.url(),
    /**
     * Which optimiser sequences route stops.
     *
     * `haversine` by DEFAULT, for the same fail-safe reason the notification
     * channels default to `console`: OSRM needs a preprocessed Maghreb extract
     * (`pnpm dev:infra --profile routing`), and a box without one must degrade to
     * the always-available deterministic sequencer rather than fail to plan a
     * route. `osrm` opts in to real road distances; it still falls back per
     * request if OSRM is unreachable (domain §3.9 rule 8).
     */
    ROUTING_OPTIMIZER: z.enum(["haversine", "osrm"]).default("haversine"),

    // ── Auth ─────────────────────────────────────────────────────────────────
    JWT_ACCESS_SECRET: secretSchema,
    JWT_REFRESH_SECRET: secretSchema,
    JWT_ACCESS_TTL_SECONDS: durationSeconds(600),
    JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),
    DRIVER_ACCESS_TTL_SECONDS: durationSeconds(3600),
    DRIVER_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(90),
    TRACKING_TOKEN_SECRET: secretSchema,
    TRACKING_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
    /**
     * The name shown beside the code in the user's authenticator app, and the
     * `issuer` in the `otpauth://` URI. Deployments run several environments
     * against the same phone, so this must distinguish them — three identical
     * "Delivery Platform" entries is how someone types a staging code into
     * production.
     */
    MFA_ISSUER: z.string().trim().min(1).default("Delivery Platform"),

    // ── Encryption (field-level PII at rest) ─────────────────────────────────
    // AES-256-GCM key as base64-encoded 32 bytes. Encrypts driver PII
    // (nationalId, licenceNumber) and MFA secrets before they reach the column.
    // Never the shipped placeholder; supplied by the secret store, never committed.
    FIELD_ENCRYPTION_KEY: z
      .string()
      .refine((value) => decodesToBytes(value, 32), "must be a base64-encoded 32-byte key")
      .refine((value) => !value.startsWith("dev_only_change_me"), {
        message: "must not use the placeholder value from .env.example",
      }),

    // ── Notifications ────────────────────────────────────────────────────────
    // Provider selection is late-bound on purpose: the Tunisian sender-ID
    // registration takes ~18 days and must never block development.
    // `console` writes to the log instead of sending — the default for dev/test.
    NOTIFICATION_SMS_PROVIDER: z.enum(["console", "http"]).default("console"),
    /**
     * Driver push. `console` by default for the same reason as SMS: a
     * misconfigured staging box must not reach a real driver's handset.
     */
    NOTIFICATION_PUSH_PROVIDER: z.enum(["console", "fcm"]).default("console"),
    FCM_PROJECT_ID: z.string().default(""),
    FCM_CLIENT_EMAIL: z.string().default(""),
    /** Service-account private key (PEM). Literal `\n` is un-escaped at read. */
    FCM_PRIVATE_KEY: z.string().default(""),
    SMS_SENDER_ID: z.string().default(""),
    SMS_API_KEY: z.string().default(""),
    SMS_API_SECRET: z.string().default(""),
    SMS_BASE_URL: z.string().default(""),

    // ── Observability ────────────────────────────────────────────────────────
    OTEL_SERVICE_NAME: z.string().default("core-api"),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().default(""),
    SENTRY_DSN: z.string().default(""),
  })
  // A provider that actually sends messages needs credentials. Catching this at
  // boot beats discovering it when the first customer notification silently fails.
  .refine(
    (config) =>
      config.NOTIFICATION_SMS_PROVIDER !== "http" ||
      (config.SMS_API_KEY.length > 0 &&
        config.SMS_BASE_URL.length > 0 &&
        config.SMS_SENDER_ID.length > 0),
    {
      message:
        "NOTIFICATION_SMS_PROVIDER=http requires SMS_API_KEY, SMS_BASE_URL and SMS_SENDER_ID to be set",
      path: ["NOTIFICATION_SMS_PROVIDER"],
    },
  )
  // Same reasoning for push: a driver app that silently receives nothing is
  // indistinguishable from one with no work assigned.
  .refine(
    (config) =>
      config.NOTIFICATION_PUSH_PROVIDER !== "fcm" ||
      (config.FCM_PROJECT_ID.length > 0 &&
        config.FCM_CLIENT_EMAIL.length > 0 &&
        config.FCM_PRIVATE_KEY.length > 0),
    {
      message:
        "NOTIFICATION_PUSH_PROVIDER=fcm requires FCM_PROJECT_ID, FCM_CLIENT_EMAIL and FCM_PRIVATE_KEY to be set",
      path: ["NOTIFICATION_PUSH_PROVIDER"],
    },
  )
  // The three database roles must be distinct. Pointing any two at the same
  // superuser silently disables Row-Level Security, which is the single
  // highest-severity failure this platform can have. The app role must not have
  // migration privileges; the relay role must have neither, holding only
  // cross-tenant access to the one `outbox` table.
  .refine((config) => config.DATABASE_URL !== config.MIGRATION_DATABASE_URL, {
    message:
      "DATABASE_URL and MIGRATION_DATABASE_URL must differ — the app role must not have migration privileges (RLS depends on it)",
    path: ["DATABASE_URL"],
  })
  .refine(
    (config) =>
      config.RELAY_DATABASE_URL !== config.DATABASE_URL &&
      config.RELAY_DATABASE_URL !== config.MIGRATION_DATABASE_URL,
    {
      message:
        "RELAY_DATABASE_URL must differ from both DATABASE_URL and MIGRATION_DATABASE_URL — the relay role is a distinct least-privilege identity (dp_relay)",
      path: ["RELAY_DATABASE_URL"],
    },
  )
  .refine(
    (config) =>
      config.TELEMETRY_DATABASE_URL === undefined ||
      config.TELEMETRY_DATABASE_URL !== config.MIGRATION_DATABASE_URL,
    {
      message:
        "TELEMETRY_DATABASE_URL must not be the migration role — telemetry writes as dp_app so RLS applies",
      path: ["TELEMETRY_DATABASE_URL"],
    },
  )
  .refine((config) => config.OUTBOX_RELAY_BASE_BACKOFF_MS <= config.OUTBOX_RELAY_MAX_BACKOFF_MS, {
    message: "OUTBOX_RELAY_BASE_BACKOFF_MS must not exceed OUTBOX_RELAY_MAX_BACKOFF_MS",
    path: ["OUTBOX_RELAY_BASE_BACKOFF_MS"],
  })
  .refine((config) => config.NODE_ENV !== "production" || config.CORS_ALLOWED_ORIGINS.length > 0, {
    message: "CORS_ALLOWED_ORIGINS must be set explicitly in production",
    path: ["CORS_ALLOWED_ORIGINS"],
  });

export type AppConfig = z.infer<typeof configSchema>;

/**
 * Validates raw environment input, throwing a readable aggregate error listing
 * every problem at once rather than failing on the first.
 */
export function validateConfig(raw: Record<string, unknown>): AppConfig {
  const result = configSchema.safeParse(raw);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid application configuration:\n${details}`);
  }

  return result.data;
}
