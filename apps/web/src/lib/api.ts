import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { apiBaseUrl, tenantSlug } from "./config";
import { LOCALE_HEADER, PATHNAME_HEADER } from "./session-cookie";
import { readSession, writeSession } from "./session";
import type { Session } from "./session";

/**
 * The server-side API client.
 *
 * Runs ONLY on the server. The browser never holds a bearer token and never
 * learns the API's address.
 */

const REQUEST_TIMEOUT_MS = 10_000;
const REFRESH_SKEW_MS = 60_000;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fieldErrors: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * The route that owns token rotation — the only place allowed to spend a
 * refresh token, because it is the only one that can store the replacement.
 * See {@link currentSession}.
 */
const REFRESH_ROUTE = "session/refresh";

interface RequestOptions {
  readonly method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  /** Override the default timeout for long-running operations. */
  readonly timeoutMs?: number;
}

let cachedTenant: string | null = null;
let resolving: Promise<string> | null = null;

async function resolveTenantId(): Promise<string> {
  if (cachedTenant !== null) {
    return cachedTenant;
  }
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

export async function courierName(): Promise<string> {
  const response = await fetch(`${apiBaseUrl()}/v1/tenants/by-slug/${encodeURIComponent(tenantSlug())}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    next: { revalidate: 3_600 },
  });
  if (!response.ok) {
    return "";
  }
  const body: unknown = await response.json();
  const name = typeof body === "object" && body !== null ? (body as { name?: unknown }).name : "";
  return typeof name === "string" ? name : "";
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const session = await currentSession();
  return callWith<T>(session.accessToken, path, options);
}

/**
 * Fetches a non-JSON body — currently the printable delivery dockets.
 *
 * Separate from {@link apiFetch} because that one parses JSON and would throw
 * on the HTML these endpoints return. The session handling is identical, so a
 * document request cannot skip the auth path.
 */
export async function apiFetchText(path: string): Promise<string> {
  const session = await currentSession();
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    headers: {
      accept: "text/html",
      authorization: `Bearer ${session.accessToken}`,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!response.ok) {
    throw await toApiError(response);
  }
  return response.text();
}

/**
 * The live session, or a redirect. NEVER refreshes here.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY REFRESHING IN THIS FUNCTION DESTROYED SESSIONS
 *
 * It used to call `refresh()` and then `writeSession()`. Both halves are wrong
 * in a Server Component:
 *
 *   1. `cookies().set()` THROWS during a render — Next allows it only in a
 *      Server Action or a Route Handler. So the rotated token was never stored.
 *   2. The API rotates refresh tokens and treats a second use of one as theft:
 *      `auth.service` revokes the ENTIRE token family with
 *      `revokeReason: 'REUSE_DETECTED'`.
 *
 * Together: a page render consumed the refresh token, failed to persist the new
 * one, and left the old — already spent — token in the cookie. The next request
 * presented it again, the API called that reuse, and every session for that
 * user was revoked. From then on `refresh()` returned null forever and the app
 * served a 500 on every page. Not a transient error: a self-inflicted lockout
 * that survives a restart.
 *
 * So rotation lives in ONE place that is allowed to write cookies — the
 * `session/refresh` Route Handler — and this function only ever redirects to
 * it. A render never spends a token it cannot save.
 * ─────────────────────────────────────────────────────────────────────────────
 */
async function currentSession(): Promise<Session> {
  const session = await readSession();
  if (session === null) {
    // `return`, not a bare call: TypeScript does not treat the statements after
    // an awaited `Promise<never>` as unreachable, so `session` would stay
    // nullable below. Returning it both narrows and states the intent.
    return redirectToLogin();
  }
  if (session.expiresAt - REFRESH_SKEW_MS > Date.now()) {
    return session;
  }

  // Expired. A Server Action MAY write cookies, so it can rotate in place and
  // carry on — which matters: redirecting out of an action throws away whatever
  // the user just submitted. A form filled in for two minutes came back blank
  // with no error, looking to the user like the button did nothing.
  //
  // A render cannot write cookies, so it hands off to the route handler.
  if (await canPersistCookies(session)) {
    const refreshed = await refresh(session);
    if (refreshed === null) {
      return redirectToLogin();
    }
    await writeSession(refreshed);
    return refreshed;
  }
  return redirectToRefresh();
}

/**
 * Whether this context may write cookies — true in a Server Action or Route
 * Handler, false during a render.
 *
 * Probed by re-writing the session that is ALREADY there. Deliberately a no-op
 * write: the alternative is to refresh first and discover on failure that the
 * rotated token cannot be stored, which is precisely the sequence that burns a
 * single-use token and gets the whole family revoked.
 *
 * Next exposes no flag for this, and there is no way to ask without trying.
 */
async function canPersistCookies(session: Session): Promise<boolean> {
  try {
    await writeSession(session);
    return true;
  } catch {
    return false;
  }
}

/** The locale and path the proxy recorded for this request. */
async function requestContext(): Promise<{ locale: string; path: string }> {
  const requestHeaders = await headers();
  const locale = requestHeaders.get(LOCALE_HEADER) ?? "fr";
  return { locale, path: requestHeaders.get(PATHNAME_HEADER) ?? `/${locale}` };
}

async function redirectToLogin(): Promise<never> {
  const { locale } = await requestContext();
  redirect(`/${locale}/login`);
}

async function redirectToRefresh(): Promise<never> {
  const { locale, path } = await requestContext();
  redirect(`/${locale}/${REFRESH_ROUTE}?next=${encodeURIComponent(path)}`);
}

/**
 * Exchanges the refresh token for a new session.
 *
 * ⚠️ Call ONLY from a context that can persist the result — the refresh Route
 * Handler. The token is rotated by the API, so a caller that cannot store the
 * replacement burns the session (see {@link currentSession}).
 */
export async function refresh(session: Session): Promise<Session | null> {
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
    signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    cache: "no-store",
  });

  if (response.status === 401) {
    // The token looked live but the API refused it — revoked elsewhere, or the
    // clocks disagree. `callWith` is only ever reached through `apiFetch`, so
    // this is always an authenticated call and always a dead session. Same
    // handling as an expired one: renew, or be sent to sign in.
    return redirectToRefresh();
  }
  if (!response.ok) {
    throw await toApiError(response);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

async function toApiError(response: Response): Promise<ApiError> {
  let code = "UNKNOWN";
  let detail = `Request failed with status ${String(response.status)}`;
  const fieldErrors: Record<string, string> = {};

  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null) {
      const problem = body as { code?: unknown; detail?: unknown; errors?: unknown };
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
    // Not a problem document.
  }
  return new ApiError(response.status, code, detail, fieldErrors);
}

export async function login(email: string, password: string, mfaCode?: string): Promise<LoginResult> {
  const id = await resolveTenantId();
  const response = await fetch(`${apiBaseUrl()}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      tenantId: id,
      email,
      password,
      ...(mfaCode !== undefined ? { mfaCode } : {}),
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!response.ok) {
    throw await toApiError(response);
  }
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null) {
    throw new Error("malformed login response");
  }
  const status = (body as { status?: unknown }).status;

  if (status === "MFA_REQUIRED" || status === "MFA_ENROLMENT_REQUIRED") {
    const challenge = (body as { challenge?: unknown }).challenge;
    const expiresIn = (body as { expiresIn?: unknown }).expiresIn;
    if (typeof challenge !== "string") {
      throw new Error("malformed MFA response: missing challenge");
    }
    return {
      kind: "mfa",
      status,
      challenge,
      expiresIn: typeof expiresIn === "number" ? expiresIn : 300,
    };
  }

  return { kind: "session", session: toSession(body) };
}

/** Verify MFA challenge and get a session. */
export async function verifyMfa(challenge: string, code: string): Promise<Session> {
  const response = await fetch(`${apiBaseUrl()}/v1/auth/mfa/challenge`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ challenge, code }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!response.ok) {
    throw await toApiError(response);
  }
  return toSession(await response.json());
}

/** Bootstrap MFA enrolment for a never-enrolled privileged user. */
export async function bootstrapMfaEnrol(
  challenge: string,
): Promise<{ uri: string; secret: string; qrSvg: string }> {
  const response = await fetch(`${apiBaseUrl()}/v1/auth/mfa/bootstrap/enrol`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    // ⚠️ The challenge goes in the BODY. It was sent as `Authorization: Bearer`
    // with no body at all, which the endpoint's strict schema rejected — so
    // every privileged sign-in died here and the login page reported it as
    // invalid credentials.
    body: JSON.stringify({ challenge }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!response.ok) {
    throw await toApiError(response);
  }
  const body: unknown = await response.json();
  // The field is `provisioningUri`, not `uri`. Reading the wrong name threw
  // "malformed enrolment response" even once the request itself was right.
  const b = body as { provisioningUri?: unknown; secret?: unknown; qrSvg?: unknown };
  if (typeof b.provisioningUri !== "string" || typeof b.secret !== "string") {
    throw new Error("malformed enrolment response");
  }
  return {
    uri: b.provisioningUri,
    secret: b.secret,
    // Absent only if an older API is deployed; the secret alone still enrols.
    qrSvg: typeof b.qrSvg === "string" ? b.qrSvg : "",
  };
}

/** Confirm bootstrap MFA enrolment and get a session. */
export async function bootstrapMfaConfirm(challenge: string, code: string): Promise<Session> {
  const response = await fetch(`${apiBaseUrl()}/v1/auth/mfa/bootstrap/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    // Both fields in the body, as the endpoint's strict schema requires. The
    // challenge was previously a Bearer header the endpoint never reads.
    body: JSON.stringify({ challenge, code }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    cache: "no-store",
  });
  if (!response.ok) {
    throw await toApiError(response);
  }
  return toSession(await response.json());
}

export type LoginResult =
  | { kind: "session"; session: Session }
  | { kind: "mfa"; status: "MFA_REQUIRED" | "MFA_ENROLMENT_REQUIRED"; challenge: string; expiresIn: number };

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
