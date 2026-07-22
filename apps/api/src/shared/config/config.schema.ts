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
    DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),
    DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

    // ── Valkey ───────────────────────────────────────────────────────────────
    VALKEY_URL: z.url(),

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

    // ── Auth ─────────────────────────────────────────────────────────────────
    JWT_ACCESS_SECRET: secretSchema,
    JWT_REFRESH_SECRET: secretSchema,
    JWT_ACCESS_TTL_SECONDS: durationSeconds(600),
    JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),
    DRIVER_ACCESS_TTL_SECONDS: durationSeconds(3600),
    DRIVER_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(90),
    TRACKING_TOKEN_SECRET: secretSchema,
    TRACKING_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

    // ── Notifications ────────────────────────────────────────────────────────
    // Provider selection is late-bound on purpose: the Tunisian sender-ID
    // registration takes ~18 days and must never block development.
    // `console` writes to the log instead of sending — the default for dev/test.
    NOTIFICATION_SMS_PROVIDER: z.enum(["console", "http"]).default("console"),
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
  // The two database roles must be distinct. Pointing both at the same
  // superuser silently disables Row-Level Security, which is the single
  // highest-severity failure this platform can have.
  .refine((config) => config.DATABASE_URL !== config.MIGRATION_DATABASE_URL, {
    message:
      "DATABASE_URL and MIGRATION_DATABASE_URL must differ — the app role must not have migration privileges (RLS depends on it)",
    path: ["DATABASE_URL"],
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
