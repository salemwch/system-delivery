import { Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";

import { AppConfigService } from "../../../shared/config/index.js";
import type {
  DeliveryReceipt,
  NotificationProvider,
  OutboundMessage,
} from "../domain/notification-provider.js";

/**
 * SMS over HTTP, against a configured aggregator.
 *
 * ⚠️ DELIBERATELY VENDOR-NEUTRAL. Aggregator selection and Tunisian sender-ID
 * registration are an open business decision (MVP-O1, CLAUDE.md scope §4), so
 * this binds to no vendor's SDK. Every Maghreb SMS aggregator — and Twilio,
 * Vonage, Infobip — accepts a form-encoded or JSON POST with a destination, a
 * body and a sender id, so that is what this sends. Switching vendors is a
 * change to `SMS_BASE_URL` and the field names, not to any calling code.
 *
 * If a chosen vendor needs a genuinely different shape, it implements
 * `NotificationProvider` alongside this one behind an Anti-Corruption Layer and
 * nothing upstream changes.
 */

/** Requests that never complete are worse than requests that fail. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Consecutive failures before the breaker opens.
 *
 * An aggregator outage otherwise means every notification spends the full
 * timeout before failing, and the consumer's retry backlog grows faster than it
 * drains — a provider outage becoming a queue outage.
 */
const BREAKER_THRESHOLD = 5;

/** How long the breaker stays open before letting one request through to probe. */
const BREAKER_COOLDOWN_MS = 30_000;

@Injectable()
export class HttpSmsProvider implements NotificationProvider {
  readonly name = "http";

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly senderId: string;

  /** Circuit-breaker state. */
  private consecutiveFailures = 0;
  private openedAt: number | null = null;

  constructor(
    config: AppConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.baseUrl = config.get("SMS_BASE_URL");
    this.apiKey = config.get("SMS_API_KEY");
    this.apiSecret = config.get("SMS_API_SECRET");
    this.senderId = config.get("SMS_SENDER_ID");
  }

  async send(message: OutboundMessage): Promise<DeliveryReceipt> {
    if (message.channel !== "SMS") {
      throw new Error(`HttpSmsProvider cannot deliver a ${message.channel} message`);
    }

    if (this.breakerIsOpen()) {
      // Fails immediately rather than waiting out the timeout. The caller records
      // FAILED and the consumer retries later, by which point the breaker may
      // have closed.
      throw new Error("SMS provider circuit breaker is open");
    }

    // `AbortSignal.timeout` rather than a manual race: it aborts the underlying
    // socket, where a race leaves the request running and the connection held.
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(this.baseUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Bearer by default; an aggregator wanting Basic gets it from the
          // secret being set — both are common and neither needs a code change.
          authorization:
            this.apiSecret.length > 0
              ? `Basic ${Buffer.from(`${this.apiKey}:${this.apiSecret}`).toString("base64")}`
              : `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          to: message.to,
          from: message.senderId ?? this.senderId,
          text: message.body,
        }),
        signal,
      });

      if (!response.ok) {
        // The body may carry the reason; it is bounded because an aggregator
        // returning a megabyte of HTML must not end up in a log line.
        const detail = (await response.text()).slice(0, 500);
        throw new Error(`SMS provider returned ${String(response.status)}: ${detail}`);
      }

      const receipt = parseReceipt(await response.text());
      this.recordSuccess();
      return receipt;
    } catch (error) {
      this.recordFailure();
      // ⚠️ Never log `message.body` or `message.to`: the body carries an OTP on
      // the driver-login path and the destination is personal data. The error is
      // what is actionable; the payload is not.
      this.logger.error(
        {
          err: error instanceof Error ? error : new Error(String(error)),
          consecutiveFailures: this.consecutiveFailures,
        },
        "SMS send failed",
      );
      throw error;
    }
  }

  private breakerIsOpen(): boolean {
    if (this.openedAt === null) {
      return false;
    }
    if (Date.now() - this.openedAt >= BREAKER_COOLDOWN_MS) {
      // Half-open: let this one through. Success closes the breaker, failure
      // re-opens it for another cooldown.
      this.openedAt = null;
      return false;
    }
    return true;
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedAt = null;
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= BREAKER_THRESHOLD && this.openedAt === null) {
      this.openedAt = Date.now();
      this.logger.warn(
        { threshold: BREAKER_THRESHOLD, cooldownMs: BREAKER_COOLDOWN_MS },
        "SMS provider circuit breaker opened",
      );
    }
  }
}

/**
 * Extracts a provider message id from an arbitrary response.
 *
 * Aggregators disagree about the field name — `messageId`, `message_id`, `id`,
 * `sid`. Any of them is accepted, and a response with none still counts as
 * ACCEPTED: the aggregator returned 2xx, so the message was taken. A synthetic
 * id keeps the log row complete rather than failing a send that succeeded.
 */
function parseReceipt(raw: string): DeliveryReceipt {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      for (const key of ["messageId", "message_id", "id", "sid"]) {
        const value = record[key];
        if (typeof value === "string" && value.length > 0) {
          return { providerMessageId: value, accepted: true };
        }
      }
    }
  } catch {
    // Not JSON. Some aggregators return a bare id or plain text; a 2xx is still
    // an acceptance, so this is not an error.
    const trimmed = raw.trim().slice(0, 200);
    if (trimmed.length > 0) {
      return { providerMessageId: trimmed, accepted: true };
    }
  }
  return { providerMessageId: "accepted-without-id", accepted: true };
}
