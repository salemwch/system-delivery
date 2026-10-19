import { z } from "zod";

/**
 * The app's HTTP client for core-api: native `fetch` (the platform's one HTTP
 * tool), a timeout on every call, and session refresh.
 *
 * ⚠️ ONE REFRESH IN FLIGHT. The server rotates refresh tokens and revokes the
 * whole session family when a token is reused (refresh rotation + reuse
 * detection). The background location task and the UI can both hit a 401 at
 * the same moment; two refreshes with the same token would look like theft and
 * sign the driver out mid-shift. Concurrent callers share one refresh.
 */

export interface Session {
  readonly tenantId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Epoch ms after which the access token is treated as expired. */
  readonly expiresAt: number;
}

export interface SessionStore {
  load(): Promise<Session | null>;
  save(session: Session): Promise<void>;
  clear(): Promise<void>;
}

/** An RFC 9457 problem from the API, or a transport failure (status 0). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** Worth retrying later: the network, a timeout, the server, rate limiting. */
  get transient(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

const problemSchema = z.object({ code: z.string(), detail: z.string().optional() }).loose();

export const sessionResponseSchema = z.object({
  status: z.literal("AUTHENTICATED"),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresIn: z.number().int().positive(),
  user: z.object({ tenantId: z.uuid(), roles: z.array(z.string()) }).loose(),
});
export type SessionResponse = z.infer<typeof sessionResponseSchema>;

/** Renew a little before expiry, so a request is never sent with a dying token. */
const EXPIRY_MARGIN_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface ApiClientDeps {
  readonly baseUrl: string;
  readonly sessions: SessionStore;
  readonly fetch: typeof fetch;
  readonly now?: () => number;
  /** Sent with refreshes so the server can tie a session to the handset. */
  readonly deviceId: string;
}

export class ApiClient {
  private refreshing: Promise<Session | null> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: ApiClientDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** An unauthenticated call (sign-in flow). */
  async publicRequest<T>(
    method: "GET" | "POST",
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    const response = await this.send(method, path, body, null);
    return this.parse(response, schema);
  }

  /**
   * An authenticated call. A 401 triggers one shared refresh and one retry; a
   * second 401, or a failed refresh, clears the session and is UNAUTHENTICATED.
   */
  async request<T>(
    method: "GET" | "POST",
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
    options: { readonly timeoutMs?: number } = {},
  ): Promise<T> {
    let session = await this.validSession();
    if (session === null) {
      throw new ApiError(401, "UNAUTHENTICATED", "Not signed in");
    }
    let response = await this.send(method, path, body, session.accessToken, options.timeoutMs);
    if (response.status === 401) {
      session = await this.refresh(session);
      if (session === null) {
        throw new ApiError(401, "UNAUTHENTICATED", "Session expired");
      }
      response = await this.send(method, path, body, session.accessToken, options.timeoutMs);
    }
    return this.parse(response, schema);
  }

  /** Stores a session issued by sign-in. */
  async adopt(response: SessionResponse): Promise<Session> {
    const session: Session = {
      tenantId: response.user.tenantId,
      accessToken: response.accessToken,
      refreshToken: response.refreshToken,
      expiresAt: this.now() + response.expiresIn * 1000,
    };
    await this.deps.sessions.save(session);
    return session;
  }

  private async validSession(): Promise<Session | null> {
    const session = await this.deps.sessions.load();
    if (session === null) {
      return null;
    }
    if (session.expiresAt - EXPIRY_MARGIN_MS > this.now()) {
      return session;
    }
    return this.refresh(session);
  }

  private refresh(stale: Session): Promise<Session | null> {
    this.refreshing ??= this.doRefresh(stale).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(stale: Session): Promise<Session | null> {
    // Another caller may have refreshed already: use the newer token.
    const latest = await this.deps.sessions.load();
    if (
      latest !== null &&
      latest.refreshToken !== stale.refreshToken &&
      latest.expiresAt > this.now()
    ) {
      return latest;
    }
    const response = await this.send(
      "POST",
      "/v1/auth/refresh",
      { tenantId: stale.tenantId, refreshToken: stale.refreshToken, deviceId: this.deps.deviceId },
      null,
    );
    if (response.status === 401 || response.status === 403) {
      await this.deps.sessions.clear();
      return null;
    }
    const issued = await this.parse(response, sessionResponseSchema);
    return this.adopt(issued);
  }

  private async send(
    method: string,
    path: string,
    body: unknown,
    token: string | null,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<Response> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token !== null) headers["authorization"] = `Bearer ${token}`;
    // A plain controller and timer, not AbortSignal.timeout: React Native's
    // runtime does not guarantee the static helper, and a missing timeout is a
    // background request that hangs for the rest of the shift.
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      return await this.deps.fetch(`${this.deps.baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch {
      throw new ApiError(
        0,
        timedOut ? "TIMEOUT" : "NETWORK",
        timedOut ? "Request timed out" : "Network unavailable",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async parse<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
    const text = await response.text();
    let json: unknown = null;
    if (text !== "") {
      try {
        json = JSON.parse(text);
      } catch {
        throw new ApiError(
          response.status || 502,
          "BAD_RESPONSE",
          "The server sent an unreadable response",
        );
      }
    }
    if (!response.ok) {
      const problem = problemSchema.safeParse(json);
      const retryAfter = Number(response.headers.get("retry-after"));
      throw new ApiError(
        response.status,
        problem.success ? problem.data.code : `HTTP_${String(response.status)}`,
        problem.success ? (problem.data.detail ?? problem.data.code) : response.statusText,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      // The contract moved under the app: never act on a half-understood answer.
      throw new ApiError(
        502,
        "BAD_RESPONSE",
        "The server response did not match the expected shape",
      );
    }
    return parsed.data;
  }
}
