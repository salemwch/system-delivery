import { Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";

import { AppConfigService } from "../../../shared/config/index.js";
import type {
  DeliveryReceipt,
  NotificationProvider,
  OutboundMessage,
} from "../domain/notification-provider.js";
import { ConsoleNotificationProvider } from "./console-notification.provider.js";
import { FcmPushProvider } from "./fcm-push.provider.js";
import { SmtpEmailProvider } from "./smtp-email.provider.js";
import { HttpSmsProvider } from "./http-sms.provider.js";

/**
 * Routes each channel to its own transport.
 *
 * SMS and PUSH have nothing in common below the port: one is an aggregator HTTP
 * POST with a sender id, the other is FCM with a service-account JWT and a
 * device token. `NotificationProvider` is the right abstraction for the caller —
 * "deliver this message" — but the wrong one for a single implementation.
 *
 * ⚠️ Selection is per channel and per environment, and the DEFAULT IS CONSOLE
 * for both. A misconfigured deployment must log rather than silently drop, and it
 * must never accidentally send a real message from a staging box to a real
 * customer's handset — the fail-safe direction here is "did not send", not "sent
 * to production numbers".
 */
@Injectable()
export class ChannelRoutingProvider implements NotificationProvider {
  readonly name: string;

  private readonly sms: NotificationProvider;
  private readonly push: NotificationProvider;
  private readonly email: NotificationProvider;

  constructor(
    config: AppConfigService,
    logger: PinoLogger,
    consoleProvider: ConsoleNotificationProvider,
  ) {
    // Constructed eagerly rather than lazily: a bad SMS_BASE_URL or an unparseable
    // FCM key should fail at boot, where it is obvious, not at the first
    // notification hours later.
    this.sms =
      config.get("NOTIFICATION_SMS_PROVIDER") === "http"
        ? new HttpSmsProvider(config, logger)
        : consoleProvider;

    this.push =
      config.get("NOTIFICATION_PUSH_PROVIDER") === "fcm"
        ? new FcmPushProvider(config, logger)
        : consoleProvider;
    // Both channels resolving to the same console instance is normal in
    // development; the name reflects what is actually bound, not what is wired.

    this.email =
      config.get("NOTIFICATION_EMAIL_PROVIDER") === "smtp"
        ? new SmtpEmailProvider(config, logger)
        : consoleProvider;

    this.name = `${this.sms.name}+${this.push.name}+${this.email.name}`;
  }

  async send(message: OutboundMessage): Promise<DeliveryReceipt> {
    switch (message.channel) {
      case "SMS":
        return this.sms.send(message);
      case "PUSH":
        return this.push.send(message);
      case "EMAIL":
        // Merchant-facing documents only — a settlement receipt, an invoice. No
        // customer message goes by email in this market: a Tunisian parcel
        // recipient is reached by SMS and frequently has no address on file.
        //
        // Defaults to the console provider, like SMS and push, so a
        // misconfigured staging box logs instead of reaching a real inbox.
        return this.email.send(message);
    }
  }
}
