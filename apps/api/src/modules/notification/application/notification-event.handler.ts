import { Injectable } from "@nestjs/common";

import type { ConsumedEvent, EventHandler, NotificationChannel } from "../../platform/index.js";
import { toLocale } from "../domain/templates.js";
import type { Locale } from "../domain/templates.js";
import { NotificationService } from "./notification.service.js";

/** The consumer group this handler owns — stable, durable state in Valkey. */
const CONSUMER_GROUP = "notification";

/**
 * Which payload field carries the recipient, per event, and over which channel.
 *
 * ⚠️ A table rather than a switch, because the interesting property is what is
 * ABSENT. Notifying every status change is the obvious mistake: a customer who
 * gets six messages per parcel stops reading them, and the one that matters —
 * "the driver is coming today" — is the one they miss. Every row here is a
 * decision that somebody needs this particular message.
 *
 * `recipientField` names where the destination lives in the SELF-CONTAINED event
 * payload (event-storming §2.2). This handler imports no domain module —
 * context-map §3.11 allows it `platform` and `identity` only — so an event that
 * does not carry its own recipient cannot be notified, and is skipped rather
 * than failed.
 */
interface Route {
  readonly channel: NotificationChannel;
  readonly recipientField: string;
  /** Payload fields copied into the template's `{{tokens}}`. */
  readonly params: readonly string[];
}

const ROUTES: Readonly<Record<string, Route>> = {
  // ── Customer (SMS) ─────────────────────────────────────────────────────────
  "shipment.out_for_delivery": {
    channel: "SMS",
    recipientField: "recipientPhone",
    params: ["trackingNumber", "recipientName"],
  },
  "shipment.delivered": {
    channel: "SMS",
    recipientField: "recipientPhone",
    params: ["trackingNumber", "recipientName"],
  },
  "delivery.failed": {
    channel: "SMS",
    recipientField: "recipientPhone",
    params: ["trackingNumber", "recipientName", "reason"],
  },
  // ⚠️ `shipment.return_initiated`, not `shipment.return_pending`. RETURN_PENDING
  // is the STATUS; the event carries the fact. Keyed on the status name this
  // route matched nothing and the message was never sent.
  "shipment.return_initiated": {
    channel: "SMS",
    recipientField: "recipientPhone",
    params: ["trackingNumber"],
  },
  "shipment.cancelled": {
    channel: "SMS",
    recipientField: "recipientPhone",
    params: ["trackingNumber"],
  },
  /**
   * Modification colis. Earns its place by the test every other row here has to
   * pass: an address change the customer does not know about is a failed
   * delivery, and a failed delivery costs a re-attempt.
   *
   * ⚠️ `recipientPhone` in the payload is the NEW number when the amendment
   * corrected it — which is the point. Notifying the old one would reach the
   * person who was never expecting the parcel.
   */
  "shipment.amended": {
    channel: "SMS",
    recipientField: "recipientPhone",
    params: ["trackingNumber"],
  },

  // ── Merchant (SMS) ─────────────────────────────────────────────────────────
  "pickup.completed": {
    channel: "SMS",
    recipientField: "merchantPhone",
    params: ["parcelCount", "merchantName"],
  },
  "settlement.paid": {
    channel: "SMS",
    recipientField: "merchantPhone",
    params: ["reference", "amount"],
  },
  "shipment.returned": {
    channel: "SMS",
    recipientField: "merchantPhone",
    params: ["trackingNumber"],
  },

  // ── Driver (PUSH) ──────────────────────────────────────────────────────────
  //
  // Push rather than SMS: the driver app renders these, and paying per message
  // for what an existing channel delivers free is waste.
  "route.published": {
    channel: "PUSH",
    recipientField: "driverDeviceToken",
    params: ["stopCount", "plannedDate"],
  },
  "shipment.assigned": {
    channel: "PUSH",
    recipientField: "driverDeviceToken",
    params: ["trackingNumber"],
  },
};

interface NotificationSpec {
  readonly templateKey: string;
  readonly channel: NotificationChannel;
  readonly recipient: string;
  readonly locale: Locale;
  readonly params: Record<string, unknown>;
}

/**
 * Turns domain events into customer, merchant and driver notifications
 * (docs/01-mvp-scope.md §4.6 #6.2/#6.3; event-storming policies P3, P9).
 *
 * This is the notification module's {@link EventHandler}: the generic stream
 * consumer calls it per event, having already deduped on eventId. Everything it
 * needs comes from the SELF-CONTAINED event payload (§2.2) — it imports no domain
 * module (context-map §3.11: notification depends only on platform + identity),
 * so it can never be the reason a notification lags behind a status change.
 *
 * An event with no deliverable recipient is a clean NO-OP, not a failure. A
 * parcel with no phone on file is ordinary in this market, and failing would
 * retry it five times and then dead-letter something nobody can act on.
 */
@Injectable()
export class NotificationEventHandler implements EventHandler {
  readonly consumerGroup = CONSUMER_GROUP;

  constructor(private readonly notifications: NotificationService) {}

  handles(eventType: string): boolean {
    return Object.hasOwn(ROUTES, eventType);
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
      channel: spec.channel,
      templateKey: spec.templateKey,
      locale: spec.locale,
      recipient: spec.recipient,
      params: spec.params,
      eventId: event.eventId,
      ...(event.correlationId === null ? {} : { correlationId: event.correlationId }),
    });
  }

  private specFor(event: ConsumedEvent): NotificationSpec | null {
    const route = ROUTES[event.eventType];
    if (route === undefined) {
      return null;
    }

    const recipient = strOf(event.payload[route.recipientField]);
    if (recipient === null) {
      // No phone on file, or a driver whose app has never registered a device
      // token. Nothing to send, and nothing broken.
      return null;
    }

    const params: Record<string, unknown> = {};
    for (const field of route.params) {
      const value = event.payload[field];
      // Only primitives reach a template: `renderTemplate` renders an object as
      // empty anyway, and copying one in would put a structure into a log row
      // that people read.
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        params[field] = value;
      }
    }

    return {
      templateKey: event.eventType,
      channel: route.channel,
      recipient,
      // The recipient's own language, falling back to French. A Tunisian customer
      // who reads Arabic must not get French because the event omitted a locale.
      locale: toLocale(strOf(event.payload["recipientLocale"]) ?? undefined),
      params,
    };
  }
}

function strOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
