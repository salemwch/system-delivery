/**
 * The single boundary between the environment and this app.
 *
 * Environment variables are read HERE and nowhere else. `process.env` is banned
 * everywhere else by lint. Nothing is `NEXT_PUBLIC_` — every API call goes
 * through the server, so the browser never learns the API address and never
 * holds a bearer token.
 */

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is not set`);
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? fallback : value.trim();
}

export function apiBaseUrl(): string {
  return required("API_BASE_URL").replace(/\/+$/u, "");
}

export function tenantSlug(): string {
  return required("WEB_TENANT_SLUG");
}

export function sessionSecret(): string {
  const secret = required("WEB_SESSION_SECRET");
  if (secret.length < 32) {
    throw new Error("WEB_SESSION_SECRET must be at least 32 characters");
  }
  return secret;
}

export function timezone(): string {
  return optional("WEB_TIMEZONE", "Africa/Tunis");
}

export function isProduction(): boolean {
  return process.env["NODE_ENV"] === "production";
}
