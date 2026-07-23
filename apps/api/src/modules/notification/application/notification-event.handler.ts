import { Injectable } from "@nestjs/common";

import type { ConsumedEvent, EventHandler } from "../../platform/index.js";
import { toLocale } from "../domain/templates.js";
import type { Locale } from "../domain/templates.js";
import { NotificationService } from "./notification.service.js";

/** The consumer group this handler owns — stable, durable state in Valkey. */
const CONSUMER_GROUP = "notification";

/** The customer-facing shipment events that produce an SMS at MVP (policies P3/P9). */
const HANDLED_EVENTS: ReadonlySet<string> = new Set<string>([
  "shipment.out_for_delivery",
  "shipment.delivered",
  "delivery.failed",
]);

interface NotificationSpec {
  readonly templateKey: string;
  readonly recipient: string;
  readonly locale: Locale;
  readonly params: Record<string, unknown>;
}

/**
 * Turns customer-facing shipment events into SMS notifications
 * (docs/03-event-storming.md P3 "SMS customer with tracking link" — the
 * highest-value customer message — and P9 re-attempt).
 *
 * This is the notification module's {@link EventHandler}: the generic stream
 * consumer calls it per event, having already deduped on eventId. It reads
 * everything it needs from the SELF-CONTAINED event payload (§2.2) — it never
 * imports `shipment` (context-map §3.11: notification depends only on platform +
 * identity). An event that lacks a recipient phone is skipped, not failed.
 */
@Injectable()
export class NotificationEventHandler implements EventHandler {
  readonly consumerGroup = CONSUMER_GROUP;

  constructor(private readonly notifications: NotificationService) {}

  handles(eventType: string): boolean {
    return HANDLED_EVENTS.has(eventType);
  }

  async handle(event: ConsumedEvent): Promise<void> {
    const spec = this.specFor(event);
    if (spec === null) {
      // Nothing to notify (no recipient, or an event we do not template): a clean
      // no-op, not a failure — it must not retry or dead-letter.
      return;
    }
    await this.notifications.send({
      tenantId: event.tenantId,
      channel: "SMS",
      templateKey: spec.templateKey,
      locale: spec.locale,
      recipient: spec.recipient,
      params: spec.params,
      eventId: event.eventId,
      ...(event.correlationId === null ? {} : { correlationId: event.correlationId }),
    });
  }

  private specFor(event: ConsumedEvent): NotificationSpec | null {
    if (!HANDLED_EVENTS.has(event.eventType)) {
      return null;
    }
    const recipient = strOf(event.payload["recipientPhone"]);
    if (recipient === null) {
      return null;
    }
    const locale = toLocale(strOf(event.payload["recipientLocale"]) ?? undefined);
    const params: Record<string, unknown> = {
      trackingNumber: strOf(event.payload["trackingNumber"]) ?? "",
      recipientName: strOf(event.payload["recipientName"]) ?? "",
    };
    return { templateKey: event.eventType, recipient, locale, params };
  }
}

function strOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
