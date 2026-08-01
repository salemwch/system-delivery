/**
 * The single boundary between the environment and this app.
 *
 * Mirrors the API's `AppConfigService` and the tracking app's equivalent:
 * environment variables are read HERE and nowhere else. `process.env` is banned
 * everywhere else in the repo by lint, and this file is the one exemption.
 *
 * ⚠️ Nothing is `NEXT_PUBLIC_`. The API address and the session secret are
 * server-side only — every API call this portal makes goes through its own
 * server, so the browser never learns where the API lives and never holds a
 * bearer token.
 */

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    // Thrown at first use, not at import: Next evaluates modules during the
    // build, where these are legitimately absent.
    throw new Error(`${name} is not set`);
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? fallback : value.trim();
}

/** Where the API lives. Server-side only. */
export function apiBaseUrl(): string {
  return required("API_BASE_URL").replace(/\/+$/u, "");
}

/**
 * Which courier this portal belongs to.
 *
 * A deployment serves ONE courier, so the merchant types an email and a password
 * — never a tenant UUID, and never a slug they would have to remember. The
 * server resolves this slug to an id once and caches it.
 */
export function tenantSlug(): string {
  return required("MERCHANT_TENANT_SLUG");
}

/**
 * Key for the encrypted session cookie. Minimum 32 bytes.
 *
 * ⚠️ Not the API's JWT secret. This portal signs its own cookie; the API's
 * tokens live inside it. Sharing the secret would mean a compromise of a
 * frontend deployment forges API tokens directly.
 */
export function sessionSecret(): string {
  const secret = required("MERCHANT_SESSION_SECRET");
  if (secret.length < 32) {
    throw new Error("MERCHANT_SESSION_SECRET must be at least 32 characters");
  }
  return secret;
}

/** The courier's IANA zone. Every date renders in it, never the server's. */
export function timezone(): string {
  return optional("MERCHANT_TIMEZONE", "Africa/Tunis");
}

/** True in production — drives the `Secure` flag on the session cookie. */
export function isProduction(): boolean {
  return process.env["NODE_ENV"] === "production";
}
