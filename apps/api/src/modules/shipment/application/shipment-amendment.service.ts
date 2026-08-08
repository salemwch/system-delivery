import { Injectable } from "@nestjs/common";
import { and, asc, count, desc, eq, getTableColumns, gt, lt, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { AddressService, RecipientService } from "../../directory/index.js";
import { AuditService, OutboxService } from "../../platform/index.js";
import {
  DatabaseService,
  TenantContext,
  isUniqueViolation,
} from "../../../shared/database/index.js";
import type { TenantTransaction } from "../../../shared/database/index.js";
import { BusinessRuleError, ConflictError, NotFoundError } from "../../../shared/errors/index.js";
import { parseWithZod } from "../../../shared/http/index.js";
import {
  listAmendmentsSchema,
  rejectAmendmentSchema,
  requestAmendmentSchema,
} from "../domain/dtos.js";
import { shipmentAmendments, shipments } from "../domain/schema.js";
import type { Shipment, ShipmentAmendment } from "../domain/schema.js";
import { TERMINAL_STATUSES, toShipmentStatus } from "../domain/shipment-status.js";

/**
 * An amendment with the parcel's currency alongside.
 *
 * ⚠️ The currency is joined in rather than left to the caller, because the row
 * carries `cod_amount_minor` and an amount in minor units WITHOUT its currency
 * is unreadable — 45000 is 45 dinars or 450 euros depending on an exponent
 * nobody has. Every read path goes through {@link selectViews}, so no endpoint
 * can forget it.
 */
export interface AmendmentView extends ShipmentAmendment {
  readonly currency: string;
}

export interface AmendmentPage {
  readonly items: readonly AmendmentView[];
  readonly nextCursor: string | null;
}

const DEFAULT_PAGE_SIZE = 50;

/**
 * COD statuses in which the amount is still an open question.
 *
 * Once cash has been COLLECTED, changing the amount rewrites what a driver
 * handed over and what the ledger already recorded. The correction for that is a
 * ledger adjustment, not an edit to the parcel.
 */
const COD_AMENDABLE: ReadonlySet<string> = new Set(["NOT_APPLICABLE", "PENDING"]);

/**
 * Modification Colis — changing a parcel already in the system.
 *
 * Until now there was no way at all: `shipment:update` existed as a permission
 * with nothing behind it, so the only remedy was cancel-and-recreate, which
 * throws away the tracking number the customer already has.
 *
 * A request rather than an update, because the person who wants the change is
 * usually not the person who should decide it — a merchant lowering the COD on a
 * parcel already with a driver is asking the courier to collect less cash than
 * the manifest says. The exception is the operator who could make the change
 * directly anyway: when the requester holds the approve permission it is applied
 * on the spot, and the row records the same person as asker and decider, which
 * is exactly what happened.
 */
@Injectable()
export class ShipmentAmendmentService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly addresses: AddressService,
    private readonly recipients: RecipientService,
  ) {}

  /**
   * Ask for a change.
   *
   * @param canApprove the requester holds `shipment:amend_approve`, so there is
   *   nobody left to ask. Passed in rather than read here: this service has no
   *   business knowing how permissions are represented.
   */
  async request(
    shipmentId: string,
    input: unknown,
    actorUserId: string,
    canApprove: boolean,
  ): Promise<AmendmentView> {
    const dto = parseWithZod(requestAmendmentSchema, input);

    const created = await this.database
      .withTenant(async (tx) => {
        const tenantId = TenantContext.requireTenantId();
        const shipment = await this.requireAmendable(tx, shipmentId);

        // Checked at REQUEST time as well as at apply time. A merchant who asks
        // to change the COD on a parcel whose cash is already collected should
        // be told now, not after a dispatcher has spent a day deciding.
        this.assertCodAmendable(dto.codAmountMinor, shipment);

        const inserted = await tx
          .insert(shipmentAmendments)
          .values({
            tenantId,
            shipmentId,
            requestedByUserId: actorUserId,
            ...(dto.reason === undefined ? {} : { reason: dto.reason }),
            ...(dto.recipientName === undefined ? {} : { recipientName: dto.recipientName }),
            ...(dto.recipientPhone === undefined ? {} : { recipientPhone: dto.recipientPhone }),
            ...(dto.recipientPhoneAlt === undefined
              ? {}
              : { recipientPhoneAlt: dto.recipientPhoneAlt }),
            ...(dto.destinationRawInput === undefined
              ? {}
              : { destinationRawInput: dto.destinationRawInput }),
            ...(dto.destinationCity === undefined
              ? {}
              : { destinationCity: dto.destinationCity }),
            ...(dto.codAmountMinor === undefined
              ? {}
              : { codAmountMinor: BigInt(dto.codAmountMinor) }),
          })
          .returning({ id: shipmentAmendments.id });

        return this.requireView(tx, requireId(inserted));
      })
      .catch((error: unknown) => {
        // The partial unique index. Two open requests against one parcel can
        // both be approved, and the second overwrites the first's `previous`
        // snapshot — losing a value nobody can recover.
        if (isUniqueViolation(error, "shipment_amendments_one_pending_uq")) {
          throw new ConflictError(
            "AMENDMENT_ALREADY_PENDING",
            "This parcel already has a change waiting for a decision.",
          );
        }
        throw error;
      });

    return canApprove ? this.apply(created.id, actorUserId) : created;
  }

  /** Applies a pending amendment to the parcel. */
  async apply(id: string, actorUserId: string): Promise<AmendmentView> {
    const amendment = await this.database.withTenant((tx) => this.requirePending(tx, id));

    // Geocoding happens OUTSIDE the transaction: `AddressService.resolve` may
    // call a network provider, and holding a row lock across an HTTP request to
    // a third party is how a slow geocoder becomes a database outage.
    const addressId =
      amendment.destinationRawInput === null
        ? null
        : (
            await this.addresses.resolve({
              rawInput: amendment.destinationRawInput,
              countryCode: "TN",
              ...(amendment.destinationCity === null ? {} : { city: amendment.destinationCity }),
            })
          ).addressId;

    // Likewise the recipient: correcting a phone number means the parcel now
    // belongs to a different person in the address book, and resolve-or-create
    // is its own transaction.
    const recipientId =
      amendment.recipientPhone === null
        ? null
        : await this.resolveRecipient(amendment.recipientPhone, amendment.recipientName);

    return this.database.withTenant(async (tx) => {
      const shipment = await this.requireAmendable(tx, amendment.shipmentId);
      this.assertCodAmendable(amendment.codAmountMinor, shipment);

      const previous = snapshotOf(shipment, amendment);

      await tx
        .update(shipments)
        .set({
          updatedAt: sql`now()`,
          ...(amendment.recipientName === null ? {} : { recipientName: amendment.recipientName }),
          ...(amendment.recipientPhone === null
            ? {}
            : { recipientPhone: amendment.recipientPhone }),
          ...(amendment.recipientPhoneAlt === null
            ? {}
            : { recipientPhoneAlt: amendment.recipientPhoneAlt }),
          ...(recipientId === null ? {} : { recipientId }),
          ...(addressId === null ? {} : { destinationAddressId: addressId }),
          ...(amendment.codAmountMinor === null
            ? {}
            : {
                codAmountMinor: amendment.codAmountMinor,
                // ⚠️ The amount and the status move together. A parcel amended
                // to zero COD that stays PENDING inflates cash-in-field forever;
                // one amended from zero that stays NOT_APPLICABLE means the
                // driver is never asked for the money.
                codStatus: amendment.codAmountMinor > 0n ? "PENDING" : "NOT_APPLICABLE",
              }),
        })
        .where(eq(shipments.id, amendment.shipmentId));

      const updated = await tx
        .update(shipmentAmendments)
        .set({
          status: "APPLIED",
          decidedAt: sql`now()`,
          decidedByUserId: actorUserId,
          previous,
          updatedAt: sql`now()`,
        })
        .where(and(eq(shipmentAmendments.id, id), eq(shipmentAmendments.status, "PENDING")))
        .returning({ id: shipmentAmendments.id });

      if (updated[0] === undefined) {
        throw new BusinessRuleError(
          "AMENDMENT_ALREADY_DECIDED",
          "This request was decided by someone else while you were reviewing it.",
        );
      }

      await this.audit.record(tx, {
        action: "shipment.amended",
        resourceType: "shipment",
        resourceId: amendment.shipmentId,
        changes: changesOf(previous, amendment),
        context: { amendmentId: id, reason: amendment.reason },
      });

      // ⚠️ SELF-CONTAINED, and the recipient phone is the NEW one when this
      // amendment corrected it. The notification handler imports no domain
      // module and reads the destination straight out of this payload — telling
      // the OLD number that the delivery changed would reach the person who was
      // never expecting the parcel.
      //
      // Deliberately carries no address and no amount. The message reaches
      // whatever number is on file, which after a phone correction is frequently
      // the wrong one, and a wrong number that receives a street address has
      // been handed a stranger's home.
      await this.outbox.publish(tx, {
        eventType: "shipment.amended",
        aggregateType: "shipment",
        aggregateId: amendment.shipmentId,
        payload: {
          trackingNumber: shipment.trackingNumber,
          recipientPhone: amendment.recipientPhone ?? shipment.recipientPhone,
          fields: Object.keys(previous),
        },
      });

      // A second, separate entry when the money moved. `cod.amount_changed` is
      // what a cash reconciliation searches for, and it must not be buried
      // inside a generic edit record.
      if (amendment.codAmountMinor !== null) {
        await this.audit.record(tx, {
          action: "cod.amount_changed",
          resourceType: "shipment",
          resourceId: amendment.shipmentId,
          changes: {
            codAmountMinor: {
              from: shipment.codAmountMinor.toString(),
              to: amendment.codAmountMinor.toString(),
            },
          },
          context: { amendmentId: id, currency: shipment.currency },
        });
      }

      return this.requireView(tx, id);
    });
  }

  async reject(id: string, input: unknown, actorUserId: string): Promise<AmendmentView> {
    const dto = parseWithZod(rejectAmendmentSchema, input);

    return this.database.withTenant(async (tx) => {
      await this.requirePending(tx, id);

      const updated = await tx
        .update(shipmentAmendments)
        .set({
          status: "REJECTED",
          decidedAt: sql`now()`,
          decidedByUserId: actorUserId,
          decisionReason: dto.reason,
          updatedAt: sql`now()`,
        })
        .where(and(eq(shipmentAmendments.id, id), eq(shipmentAmendments.status, "PENDING")))
        .returning({ id: shipmentAmendments.id });

      if (updated[0] === undefined) {
        throw new BusinessRuleError(
          "AMENDMENT_ALREADY_DECIDED",
          "This request was decided by someone else while you were reviewing it.",
        );
      }
      return this.requireView(tx, id);
    });
  }

  async getById(id: string): Promise<AmendmentView> {
    return this.database.withTenant((tx) => this.requireView(tx, id));
  }

  async list(input: unknown = {}): Promise<AmendmentPage> {
    const dto = parseWithZod(listAmendmentsSchema, input);
    const limit = dto.limit ?? DEFAULT_PAGE_SIZE;
    // The queue is oldest-first — the request waiting longest is the one to
    // answer. A parcel's own history reads newest-first.
    const oldestFirst = dto.shipmentId === undefined && (dto.status ?? "PENDING") === "PENDING";

    return this.database.withTenant(async (tx) => {
      const conditions: SQL[] = [
        ...(dto.status === undefined ? [] : [eq(shipmentAmendments.status, dto.status)]),
        ...(dto.shipmentId === undefined
          ? []
          : [eq(shipmentAmendments.shipmentId, dto.shipmentId)]),
        ...(dto.cursor === undefined
          ? []
          : [
              oldestFirst
                ? gt(shipmentAmendments.id, dto.cursor)
                : lt(shipmentAmendments.id, dto.cursor),
            ]),
      ];

      const rows = await selectViews(
        tx,
        conditions.length > 0 ? and(...conditions) : undefined,
        oldestFirst,
        limit + 1,
      );

      if (rows.length > limit) {
        const items = rows.slice(0, limit);
        return { items, nextCursor: items[items.length - 1]?.id ?? null };
      }
      return { items: rows, nextCursor: null };
    });
  }

  /** How many are waiting, for the sidebar badge. */
  async pendingCount(): Promise<number> {
    return this.database.withTenant(async (tx) => {
      const rows = await tx
        .select({ pending: count() })
        .from(shipmentAmendments)
        .where(eq(shipmentAmendments.status, "PENDING"));
      return Number(rows[0]?.pending ?? 0);
    });
  }

  /** Resolve-or-create, the same shape `ShipmentService` uses on create. */
  private async resolveRecipient(phone: string, fullName: string | null): Promise<string> {
    const existing = await this.recipients.findByPhone(phone);
    if (existing !== null) {
      return existing.id;
    }
    try {
      const created = await this.recipients.create({
        phone,
        // The amendment may correct only the number, leaving the name alone —
        // in which case the new address-book entry takes the name the parcel
        // already carries, which the caller passes in.
        fullName: fullName ?? phone,
      });
      return created.id;
    } catch (error) {
      // A concurrent create for the same (tenant, phone) — reuse the winner.
      if (error instanceof ConflictError) {
        const again = await this.recipients.findByPhone(phone);
        if (again !== null) {
          return again.id;
        }
      }
      throw error;
    }
  }

  private async requireAmendable(tx: TenantTransaction, id: string): Promise<Shipment> {
    const rows = await tx.select().from(shipments).where(eq(shipments.id, id)).limit(1);
    const shipment = rows[0];
    if (shipment === undefined) {
      throw new NotFoundError("Shipment");
    }
    if (TERMINAL_STATUSES.has(toShipmentStatus(shipment.status))) {
      throw new BusinessRuleError(
        "SHIPMENT_NOT_AMENDABLE",
        `A ${shipment.status.toLowerCase()} parcel cannot be changed.`,
      );
    }
    return shipment;
  }

  private assertCodAmendable(requested: bigint | number | null | undefined, shipment: Shipment): void {
    if (requested === null || requested === undefined) {
      return;
    }
    if (!COD_AMENDABLE.has(shipment.codStatus)) {
      throw new BusinessRuleError(
        "COD_NOT_AMENDABLE",
        `The cash on this parcel is already ${shipment.codStatus.toLowerCase()}; correct it with a ledger adjustment.`,
      );
    }
  }

  /** One amendment with its parcel's currency, or 404. */
  private async requireView(tx: TenantTransaction, id: string): Promise<AmendmentView> {
    const rows = await selectViews(tx, eq(shipmentAmendments.id, id), false, 1);
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundError("Amendment");
    }
    return row;
  }

  private async requirePending(
    tx: TenantTransaction,
    id: string,
  ): Promise<ShipmentAmendment> {
    const rows = await tx
      .select()
      .from(shipmentAmendments)
      .where(eq(shipmentAmendments.id, id))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundError("Amendment");
    }
    if (row.status !== "PENDING") {
      throw new BusinessRuleError(
        "AMENDMENT_ALREADY_DECIDED",
        `This request is already ${row.status.toLowerCase()}.`,
      );
    }
    return row;
  }
}

/**
 * What the parcel held, for the fields this amendment touches.
 *
 * Only the touched fields: the whole row would drag unrelated PII into a JSONB
 * column retained as long as the shipment, and would make the diff unreadable.
 */
function snapshotOf(shipment: Shipment, amendment: ShipmentAmendment): Record<string, unknown> {
  return {
    ...(amendment.recipientName === null ? {} : { recipientName: shipment.recipientName }),
    ...(amendment.recipientPhone === null ? {} : { recipientPhone: shipment.recipientPhone }),
    ...(amendment.recipientPhoneAlt === null
      ? {}
      : { recipientPhoneAlt: shipment.recipientPhoneAlt }),
    ...(amendment.destinationRawInput === null
      ? {}
      : { destinationAddressId: shipment.destinationAddressId }),
    ...(amendment.codAmountMinor === null
      ? {}
      : {
          codAmountMinor: shipment.codAmountMinor.toString(),
          codStatus: shipment.codStatus,
        }),
  };
}

/** The snapshot and the request, as before/after pairs for the audit trail. */
function changesOf(
  previous: Record<string, unknown>,
  amendment: ShipmentAmendment,
): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  if (amendment.recipientName !== null) {
    changes["recipientName"] = {
      from: previous["recipientName"],
      to: amendment.recipientName,
    };
  }
  if (amendment.recipientPhone !== null) {
    changes["recipientPhone"] = {
      from: previous["recipientPhone"],
      to: amendment.recipientPhone,
    };
  }
  if (amendment.recipientPhoneAlt !== null) {
    changes["recipientPhoneAlt"] = {
      from: previous["recipientPhoneAlt"],
      to: amendment.recipientPhoneAlt,
    };
  }
  if (amendment.destinationRawInput !== null) {
    changes["destination"] = {
      from: previous["destinationAddressId"],
      to: amendment.destinationRawInput,
    };
  }
  return changes;
}

/**
 * The one query every read goes through.
 *
 * INNER JOIN rather than a second lookup: `shipment_amendments` always belongs
 * to a shipment, the currency comes free with the join, and a page of fifty
 * would otherwise be fifty extra round trips for one column.
 */
async function selectViews(
  tx: TenantTransaction,
  where: SQL | undefined,
  oldestFirst: boolean,
  limit: number,
): Promise<AmendmentView[]> {
  return tx
    .select({ ...getTableColumns(shipmentAmendments), currency: shipments.currency })
    .from(shipmentAmendments)
    .innerJoin(shipments, eq(shipments.id, shipmentAmendments.shipmentId))
    .where(where)
    .orderBy(oldestFirst ? asc(shipmentAmendments.id) : desc(shipmentAmendments.id))
    .limit(limit);
}

function requireId(rows: readonly { id: string }[]): string {
  const row = rows[0];
  if (row === undefined) {
    throw new Error("Amendment insert returned no row");
  }
  return row.id;
}
