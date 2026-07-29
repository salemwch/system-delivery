import { createSign } from "node:crypto";

import { Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";

import { AppConfigService } from "../../../shared/config/index.js";
import type {
  DeliveryReceipt,
  NotificationProvider,
  OutboundMessage,
} from "../domain/notification-provider.js";

/**
 * Driver push over Firebase Cloud Messaging (docs/01-mvp-scope.md §4.6 #6.3).
 *
 * Unlike SMS, there is no vendor decision here: Android push IS FCM, and the
 * MVP is Android-only (ADR — no iOS).
 *
 * ⚠️ No `firebase-admin` dependency. That package pulls in a large tree to do
 * two things this needs — mint a service-account JWT and POST to the v1 send
 * endpoint — both of which are a few lines with `node:crypto` and `fetch`. It
 * would also be the only Google SDK in the process and would bring its own HTTP
 * stack, retry policy and logger, none of which match the ones here.
 *
 * The trade-off accepted: token-refresh and the exact v1 payload shape are
 * maintained in this file rather than by Google. Both are stable, versioned
 * endpoints and the surface used is small.
 */

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Refresh a minute early. An access token that expires mid-flight produces a 401
 * on a message that would otherwise have been delivered.
 */
const TOKEN_SKEW_SECONDS = 60;

interface CachedToken {
  readonly value: string;
  /** Epoch millis. */
  readonly expiresAt: number;
}

@Injectable()
export class FcmPushProvider implements NotificationProvider {
  readonly name = "fcm";

  private readonly projectId: string;
  private readonly clientEmail: string;
  private readonly privateKey: string;

  private token: CachedToken | null = null;
  /** In-flight refresh, so a burst of sends mints ONE token rather than twenty. */
  private refreshing: Promise<CachedToken> | null = null;

  constructor(
    config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.projectId = config.get("FCM_PROJECT_ID");
    this.clientEmail = config.get("FCM_CLIENT_EMAIL");
    // Service-account keys carry literal "\n" when passed through an env var;
    // PEM parsing needs real newlines.
    this.privateKey = config.get("FCM_PRIVATE_KEY").replace(/\\n/gu, "\n");
  }

  async send(message: OutboundMessage): Promise<DeliveryReceipt> {
    if (message.channel !== "PUSH") {
      throw new Error(`FcmPushProvider cannot deliver a ${message.channel} message`);
    }

    const accessToken = await this.accessToken();
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(
        `https://fcm.googleapis.com/v1/projects/${this.projectId}/messages:send`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            message: {
              token: message.to,
              // `data` rather than `notification`: the driver app renders its own
              // UI and must receive the payload even in the foreground, which a
              // notification-only message does not guarantee on Android.
              data: { body: message.body },
              android: {
                // A route assignment or a cancelled stop is time-critical; it must
                // wake the device rather than wait for the next maintenance window.
                priority: "high",
              },
            },
          }),
          signal,
        },
      );

      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        // 404 / UNREGISTERED means the device token is dead — the app was
        // uninstalled or the token rotated. Surfaced distinctly so the caller can
        // stop retrying a token that will never work again.
        if (response.status === 404) {
          throw new Error(`FCM token is no longer registered: ${detail}`);
        }
        throw new Error(`FCM returned ${String(response.status)}: ${detail}`);
      }

      const parsed: unknown = await response.json();
      const name =
        typeof parsed === "object" && parsed !== null && "name" in parsed ? parsed.name : undefined;

      return {
        providerMessageId: typeof name === "string" ? name : "accepted-without-id",
        accepted: true,
      };
    } catch (error) {
      // Never log `message.to` (a device token identifies a driver's handset) or
      // the body.
      this.logger.error(
        { err: error instanceof Error ? error : new Error(String(error)) },
        "FCM push failed",
      );
      throw error;
    }
  }

  /**
   * A cached OAuth access token, minted from the service-account key.
   *
   * Serialised: a burst of pushes must not each mint their own token. Google rate
   * limits token issuance, and twenty simultaneous refreshes is how a fleet-wide
   * dispatch turns into a 429.
   */
  private async accessToken(): Promise<string> {
    const cached = this.token;
    if (cached !== null && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    this.refreshing ??= this.mintToken().finally(() => {
      this.refreshing = null;
    });

    const fresh = await this.refreshing;
    this.token = fresh;
    return fresh.value;
  }

  private async mintToken(): Promise<CachedToken> {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: this.clientEmail,
      scope: FCM_SCOPE,
      aud: OAUTH_TOKEN_URL,
      iat: now,
      exp: now + 3600,
    };

    const header = { alg: "RS256", typ: "JWT" };
    const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(claims))}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(this.privateKey, "base64url");

    const response = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${signature}`,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(`FCM token exchange returned ${String(response.status)}`);
    }

    const parsed: unknown = await response.json();
    if (typeof parsed !== "object" || parsed === null || !("access_token" in parsed)) {
      throw new Error("FCM token exchange returned no access_token");
    }
    const { access_token: token } = parsed;
    const expiresIn = "expires_in" in parsed ? parsed.expires_in : undefined;
    if (typeof token !== "string") {
      throw new Error("FCM access_token was not a string");
    }

    const lifetime = typeof expiresIn === "number" ? expiresIn : 3600;
    return {
      value: token,
      expiresAt: Date.now() + (lifetime - TOKEN_SKEW_SECONDS) * 1000,
    };
  }
}

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}
