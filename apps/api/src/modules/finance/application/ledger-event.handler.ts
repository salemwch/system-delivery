import { Injectable } from "@nestjs/common";

import { DatabaseService, asTenantId } from "../../../shared/database/index.js";
import { BusinessRuleError } from "../../../shared/errors/index.js";
import type { ConsumedEvent, EventHandler } from "../../platform/index.js";
import type { AccountRef } from "./ledger.service.js";
import { LedgerService } from "./ledger.service.js";

/** The consumer group this handler owns — stable, durable state in Valkey. */
const CONSUMER_GROUP = "ledger";

/** The events that move money into the ledger (event-storming §P5). */
const HANDLED_EVENTS: ReadonlySet<string> = new Set<string>(["cod.collected"]);

/**
 * Posts the double-entry consequences of money events (docs/03-event-storming.md
 * §P5, `cod.collected`). This is the finance module's {@link EventHandler}: the
 * generic stream consumer drives it (having deduped on eventId), running as dp_app
 * with tenant context set per event, so the ledger writes are RLS-scoped.
 *
 * It reads everything from the SELF-CONTAINED event payload (§2.2) and never
 * imports `shipment` (context-map §3.11 — finance is Layer 3, depends only on
 * lower layers). Unlike notification, a money event it cannot process is NOT
 * silently skipped: it THROWS, so a malformed `cod.collected` is retried and then
 * dead-lettered for a human — losing a financial record is never acceptable.
 *
 * `cod.collected` → DEBIT driver_cash, CREDIT merchant_payable (domain §3.15). The
 * ledger's own `hasPostedForEvent` guard makes a redelivery a clean no-op, so cash
 * is never double-counted even if the handler and its ack commit separately.
 */
@Injectable()
export class LedgerEventHandler implements EventHandler {
  readonly consumerGroup = CONSUMER_GROUP;

  constructor(
    private readonly database: DatabaseService,
    private readonly ledger: LedgerService,
  ) {}

  handles(eventType: string): boolean {
    return HANDLED_EVENTS.has(eventType);
  }

  async handle(event: ConsumedEvent): Promise<void> {
    if (event.eventType !== "cod.collected") {
      return;
    }

    const driverId = uuidOf(event.payload["driverId"]);
    const currency = strOf(event.payload["currency"]);
    const amountMinor = bigintOf(event.payload["amountMinor"]);
    if (driverId === null || currency === null || amountMinor === null || amountMinor <= 0n) {
      // A COD collection with no driver/currency/amount is a producer bug, not a
      // benign miss. Fail loudly so it retries and dead-letters, never vanishes.
      throw new BusinessRuleError(
        "COD_EVENT_MALFORMED",
        `cod.collected ${event.eventId} is missing driverId/currency/amountMinor`,
      );
    }

    // The party the collected cash is owed to. With no merchant on the shipment,
    // it accrues to a tenant-level payable so the transaction always balances.
    const merchantId = uuidOf(event.payload["merchantId"]);
    const creditAccount: AccountRef =
      merchantId === null
        ? { ownerType: "TENANT", ownerId: event.tenantId, accountType: "MERCHANT_PAYABLE" }
        : { ownerType: "MERCHANT", ownerId: merchantId, accountType: "MERCHANT_PAYABLE" };
    const shipmentId = uuidOf(event.payload["shipmentId"]);

    await this.database.withTenant(async (tx) => {
      if (await this.ledger.hasPostedForEvent(tx, event.tenantId, event.eventId)) {
        return; // already posted — idempotent no-op
      }
      await this.ledger.postTransaction(tx, {
        tenantId: event.tenantId,
        entryType: "COD_COLLECTED",
        currency,
        sourceEventId: event.eventId,
        occurredAt: event.occurredAt,
        description: "COD collected on delivery",
        lines: [
          {
            account: { ownerType: "DRIVER", ownerId: driverId, accountType: "DRIVER_CASH" },
            direction: "DEBIT",
            amountMinor,
          },
          { account: creditAccount, direction: "CREDIT", amountMinor },
        ],
        ...(shipmentId === null ? {} : { shipmentId }),
      });
    }, asTenantId(event.tenantId));
  }
}

function strOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** A UUID-shaped string, or null. Keeps a malformed id from reaching a uuid column. */
function uuidOf(value: unknown): string | null {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

/** Parses the string-encoded minor-unit amount from the envelope (bigint over JSON). */
function bigintOf(value: unknown): bigint | null {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return BigInt(value);
  }
  return null;
}
