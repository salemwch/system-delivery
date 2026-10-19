import { randomUUID } from "node:crypto";

import { Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";

import { AppConfigService } from "../../../shared/config/index.js";
import type {
  DeliveryReceipt,
  NotificationProvider,
  OutboundMessage,
} from "../domain/notification-provider.js";

/**
 * The no-send notification provider (CLAUDE.md scope §4, MVP-O1).
 *
 * `NOTIFICATION_SMS_PROVIDER=console` (the default): it records that a message
 * WOULD be sent, without a real aggregator. This keeps SMS provider selection and
 * the ~18-day Tunisian sender-ID registration off the critical path — the whole
 * notification pipeline (gating, templating, logging, idempotency) is exercisable
 * today, and the eventual `http` provider implements this same port behind an
 * Anti-Corruption Layer with no caller change.
 *
 * It never logs the recipient or the body: those are PII and must not reach the
 * logs (docs/07 §6.3). Only non-identifying metadata is logged.
 */
@Injectable()
export class ConsoleNotificationProvider implements NotificationProvider {
  readonly name = "console";
  private readonly senderId: string | undefined;
  private readonly logBodies: boolean;

  constructor(
    private readonly logger: PinoLogger,
    config: AppConfigService,
  ) {
    const configured = config.get("SMS_SENDER_ID");
    this.senderId = configured === "" ? undefined : configured;
    // Development only; the config refuses it with NODE_ENV=production.
    this.logBodies = config.get("DEV_LOG_SMS_BODIES");
  }

  async send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const providerMessageId = `console-${randomUUID()}`;
    // No recipient, no body — PII stays out of the logs. Length is enough to
    // confirm a non-empty message was composed.
    this.logger.info(
      {
        component: "notification",
        provider: this.name,
        channel: message.channel,
        bodyLength: message.body.length,
        senderId: this.senderId ?? null,
        providerMessageId,
      },
      "notification composed (console provider — not actually sent)",
    );
    if (this.logBodies) {
      // DEV_LOG_SMS_BODIES: the dev "inbox". A separate warn line, so it is
      // impossible to miss in a log and impossible to mistake for production.
      this.logger.warn(
        { component: "notification", channel: message.channel, to: message.to, body: message.body },
        "DEV ONLY (DEV_LOG_SMS_BODIES): message content",
      );
    }
    return Promise.resolve({ providerMessageId, accepted: true });
  }
}
