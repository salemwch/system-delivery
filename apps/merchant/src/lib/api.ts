import { apiBaseUrl, tenantSlug } from "./config";
import { readSession, writeSession } from "./session";
import type { Session } from "./session";

/**
 * The server-side API client.
 *
 * ⚠️ Runs ONLY on the server. The browser never holds a bearer token and never
 * learns the API's address: every call originates here, authorised from the
 * encrypted session cookie. That is what makes an XSS in this portal a defacement
 * rather than an account takeover.
 */

/** A request must not hang a merchant's page open indefinitely. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Refresh this long before expiry rather than after a 401.
 *
 * Reacting to a 401 means one request has already failed, and for a POST that
 * means either losing the merchant's work or replaying a mutation. Sixty seconds
 * of slack costs nothing and removes the whole class of problem.
 */
const REFRESH_SKEW_MS = 60_000;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Field-level problems from the API's RFC 9457 body, for form display. */
    readonly fieldErrors: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Raised when there is no usable session — the caller should redirect to login. */
class NotAuthenticatedError extends Error {
  constructor() {
    super("not authenticated");
    this.name = "NotAuthenticatedError";
  }
}

interface RequestOptions {
  readonly method?: "GET" | "POST" | "PATCH" | "DELETE";
  readonly body?: unknown;
  /**
   * Required on every mutation (CLAUDE.md: "every mutating endpoint:
   * Idempotency-Key"). Generated per user action, so a double-submitted form
   * creates one shipment rather than two.
   */
  readonly idempotencyKey?: string;
}

/** The tenant id, resolved once from the configured slug and cached per process. */
let cachedTenant: string | null = null;
let resolving: Promise<string> | null = null;

async function tenantId(): Promise<string> {
  if (cachedTenant !== null) {
    return cachedTenant;
  }
  // Coalesced, so N concurrent cold requests issue ONE lookup rather than N.
  resolving ??= resolveTenant().finally(() => {
    resolving = null;
  });
  return resolving;
}

async function resolveTenant(): Promise<string> {
  const response = await fetch(`${apiBaseUrl()}/v1/tenants/by-slug/${encodeURIComponent(tenantSlug())}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`cannot resolve tenant "${tenantSlug()}": ${String(response.status)}`);
  }
  const body: unknown = await response.json();
  const id = typeof body === "object" && body !== null ? (body as { id?: unknown }).id : undefined;
  if (typeof id !== "string") {
    throw new Error("tenant lookup returned no id");
  }
  cachedTenant = id;
  return id;
}

/** The courier's display name, for the portal header. */
export async function courierName(): Promise<string> {
  const response = await fetch(`${apiBaseUrl()}/v1/tenants/by-slug/${encodeURIComponent(tenantSlug())}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    // Cached for an hour: a courier does not rename itself often, and this is on
    // every page's header.
    next: { revalidate: 3_600 },
  });
  if (!response.ok) {
    return "";
  }
  const body: unknown = await response.json();
  const name = typeof body === "object" && body !== null ? (body as { name?: unknown }).name : "";
  return typeof name === "string" ? name : "";
}

/**
 * Calls the API as the signed-in merchant, refreshing the access token first if
 * it is about to expire.
 */
export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const session = await currentSession();
  return callWith<T>(session.accessToken, path, options);
}

/** The live session, refreshed if needed. Throws when there is none. */
async function currentSession(): Promise<Session> {
  const session = await readSession();
  if (session === null) {
    throw new NotAuthenticatedError();
  }
  if (session.expiresAt - REFRESH_SKEW_MS > Date.now()) {
    return session;
  }

  const refreshed = await refresh(session);
  if (refreshed === null) {
    throw new NotAuthenticatedError();
  }
  await writeSession(refreshed);
  return refreshed;
}

async function refresh(session: Session): Promise<Session | null> {
  try {
    const response = await fetch(`${apiBaseUrl()}/v1/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        tenantId: session.tenantId,
        refreshToken: session.refreshToken,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!response.ok) {
      // A reused or revoked refresh token lands here. The API treats reuse as a
      // compromise and kills the family, which is exactly right — the merchant
      // signs in again.
      return null;
    }
    return toSession(await response.json());
  } catch {
    return null;
  }
}

async function callWith<T>(
  accessToken: string,
  path: string,
  options: RequestOptions,
): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${accessToken}`,
  };
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (options.idempotencyKey !== undefined) {
    headers["idempotency-key"] = options.idempotencyKey;
  }

  const response = await fetch(`${apiBaseUrl()}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    // A merchant's own data changes as couriers move parcels. Nothing here is
    // cacheable without showing stale statuses.
    cache: "no-store",
  });

  if (response.status === 401) {
    throw new NotAuthenticatedError();
  }
  if (!response.ok) {
    throw await toApiError(response);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

/**
 * Turns an RFC 9457 problem document into an error a form can display.
 *
 * The API returns `errors: [{ field, code, detail }]` for validation failures;
 * flattening them to `field -> message` is what a form needs to put a message
 * next to the input that caused it.
 */
async function toApiError(response: Response): Promise<ApiError> {
  let code = "UNKNOWN";
  let detail = `Request failed with status ${String(response.status)}`;
  const fieldErrors: Record<string, string> = {};

  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null) {
      const problem = body as {
        code?: unknown;
        detail?: unknown;
        errors?: unknown;
      };
      if (typeof problem.code === "string") code = problem.code;
      if (typeof problem.detail === "string") detail = problem.detail;
      if (Array.isArray(problem.errors)) {
        for (const entry of problem.errors) {
          if (typeof entry === "object" && entry !== null) {
            const { field, detail: message } = entry as { field?: unknown; detail?: unknown };
            if (typeof field === "string" && typeof message === "string") {
              fieldErrors[field] = message;
            }
          }
        }
      }
    }
  } catch {
    // Not a problem document — the status and a generic message are all we have.
  }
  return new ApiError(response.status, code, detail, fieldErrors);
}

/** Signs in, returning a session ready to be sealed into the cookie. */
export async function login(email: string, password: string): Promise<Session> {
  const id = await tenantId();
  const response = await fetch(`${apiBaseUrl()}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ tenantId: id, email, password }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!response.ok) {
    throw await toApiError(response);
  }
  return toSession(await response.json());
}

function toSession(body: unknown): Session {
  if (typeof body !== "object" || body === null) {
    throw new Error("malformed session response");
  }
  const b = body as {
    accessToken?: unknown;
    refreshToken?: unknown;
    expiresIn?: unknown;
    user?: { id?: unknown; tenantId?: unknown; roles?: unknown; permissions?: unknown };
  };
  if (
    typeof b.accessToken !== "string" ||
    typeof b.refreshToken !== "string" ||
    typeof b.expiresIn !== "number" ||
    typeof b.user?.id !== "string" ||
    typeof b.user.tenantId !== "string"
  ) {
    throw new Error("malformed session response");
  }
  return {
    accessToken: b.accessToken,
    refreshToken: b.refreshToken,
    tenantId: b.user.tenantId,
    userId: b.user.id,
    roles: Array.isArray(b.user.roles) ? b.user.roles.filter(isString) : [],
    permissions: Array.isArray(b.user.permissions) ? b.user.permissions.filter(isString) : [],
    expiresAt: Date.now() + b.expiresIn * 1_000,
  };
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}
