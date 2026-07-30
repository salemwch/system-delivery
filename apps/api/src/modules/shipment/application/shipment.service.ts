import { randomUUID } from "node:crypto";

import { Injectable } from "@nestjs/common";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";

import { AddressService, MerchantService, RecipientService } from "../../directory/index.js";
import { OperatingConfigService, OutboxService } from "../../platform/index.js";
import {
  DatabaseService,
  TenantContext,
  isUniqueViolation,
} from "../../../shared/database/index.js";
import type { TenantTransaction } from "../../../shared/database/index.js";
import { BusinessRuleError, ConflictError, NotFoundError } from "../../../shared/errors/index.js";
import { parseWithZod } from "../../../shared/http/index.js";
import {
  cancelShipmentSchema,
  completeReturnSchema,
  confirmDeliverySchema,
  createShipmentSchema,
  initiateReturnSchema,
  listShipmentsSchema,
  recordEventSchema,
  recordFailedAttemptSchema,
  recordPickupSchema,
} from "../domain/dtos.js";
import type { ConfirmDeliveryInput, CreateShipmentInput } from "../domain/dtos.js";
import { haversineMetres } from "../domain/geo.js";
import { pod, shipmentEvents, shipmentLegs, shipments } from "../domain/schema.js";
import type { Shipment } from "../domain/schema.js";
import { generateTrackingNumber } from "../domain/tracking-number.js";
import { isInCustody, toShipmentStatus } from "../domain/shipment-status.js";
import type { CodStatus, EventActor, ShipmentStatus } from "../domain/shipment-status.js";
import { ShipmentEventService } from "./shipment-event.service.js";
import type { ShipmentSnapshot } from "./shipment-event.service.js";

/** The authenticated context a command runs under. Never taken from the body. */
export interface CommandContext {
  readonly actor: EventActor;
  /** OWNER authority to force a ⚠️ in-custody transition (cancellation). */
  readonly canOverride?: boolean;
}

export interface ShipmentPage {
  readonly items: Shipment[];
  readonly nextCursor: string | null;
}

/** A custody event flattened for reading — location resolved out of PostGIS. */
export interface ShipmentEventView {
  readonly id: string;
  readonly sequence: bigint;
  readonly eventType: string;
  readonly occurredAt: Date;
  readonly recordedAt: Date;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly hubId: string | null;
  readonly driverId: string | null;
  readonly routeId: string | null;
  readonly legId: string | null;
  readonly reasonCode: string | null;
  readonly idempotencyKey: string;
}

/**
 * A shipment leg flattened with the parent-shipment attributes the dispatch
 * context needs to plan it onto a route — the purpose-built read that replaces a
 * cross-module join (context-map §5 "no cross-context joins"). Dispatch resolves
 * coordinates itself (it composes directory/network); this stays free of PostGIS.
 */
export interface PlanningLeg {
  readonly legId: string;
  readonly shipmentId: string;
  readonly legType: string;
  readonly legStatus: string;
  readonly shipmentStatus: ShipmentStatus;
  readonly fromType: string;
  readonly toType: string;
  readonly fromAddressId: string | null;
  readonly toAddressId: string | null;
  readonly fromHubId: string | null;
  readonly toHubId: string | null;
  readonly routeStopId: string | null;
  readonly requiredSkills: string[];
  readonly parcelCount: number;
  readonly weightGrams: number;
  readonly volumeCm3: number | null;
  readonly codAmountMinor: bigint;
  readonly currency: string;
  readonly trackingNumber: string;
  readonly recipientName: string;
  readonly recipientPhone: string;
}

const DEFAULT_PAGE_SIZE = 50;
const TRACKING_ALLOCATION_RETRIES = 5;

/** A geography point literal for INSERT — lng first, per PostGIS. */
function pointOf(coordinates: { lat: number; lng: number }) {
  return sql`ST_SetSRID(ST_MakePoint(${coordinates.lng}, ${coordinates.lat}), 4326)::geography`;
}

/**
 * The shipment aggregate — the core of the platform (docs/02-domain-model.md
 * §3.6, docs/04-context-map.md, Layer 2).
 *
 * Every mutation is a custody event: this service composes the directory context
 * (resolve addresses, find-or-create the recipient, validate the merchant) and
 * routes ALL state changes through {@link ShipmentEventService}, which appends
 * the immutable event and advances the `shipments.status` projection in one
 * transaction. Nothing here writes `status` directly.
 *
 * Idempotency is first-class: every mutating command carries an idempotency key,
 * and a retry with the same key returns the prior result and creates nothing —
 * required because the driver app is offline-first and re-submits on reconnect.
 */
@Injectable()
export class ShipmentService {
  constructor(
    private readonly database: DatabaseService,
    private readonly events: ShipmentEventService,
    private readonly outbox: OutboxService,
    private readonly merchants: MerchantService,
    private readonly recipients: RecipientService,
    private readonly addresses: AddressService,
    private readonly operatingConfig: OperatingConfigService,
  ) {}

  // ── Create ─────────────────────────────────────────────────────────────────

  async create(input: unknown, ctx: CommandContext): Promise<Shipment> {
    const dto = parseWithZod(createShipmentSchema, input);

    // Idempotent replay: a retried create returns the shipment already made and
    // resolves no addresses a second time.
    const prior = await this.findByIdempotencyKey(dto.idempotencyKey);
    if (prior !== null) {
      return prior;
    }

    if (dto.merchantId !== undefined) {
      const merchant = await this.merchants.getById(dto.merchantId);
      if (merchant.status !== "ACTIVE") {
        throw new BusinessRuleError(
          "MERCHANT_SUSPENDED",
          "This merchant is suspended; new shipments cannot be created for it.",
        );
      }
    }

    const origin = await this.addresses.resolve(dto.origin);
    const destination = await this.addresses.resolve(dto.destination);
    const recipientId = await this.resolveRecipient(dto);

    const codAmount = dto.codAmountMinor ?? 0n;
    const codStatus: CodStatus = codAmount > 0n ? "PENDING" : "NOT_APPLICABLE";
    const occurredAt = dto.occurredAt ?? new Date();

    for (let attempt = 0; attempt < TRACKING_ALLOCATION_RETRIES; attempt += 1) {
      const trackingNumber = generateTrackingNumber();
      try {
        return await this.database.withTenant(async (tx) => {
          const tenantId = TenantContext.requireTenantId();

          // The delivery promise, computed from the tenant's SLA template in
          // WORKING hours. An explicit `promisedTo` from the caller wins — a
          // merchant who has negotiated a specific date is not overridden by a
          // default — but a shipment created without one is no longer left with
          // no promise at all, which is what made on-time reporting impossible.
          const promisedTo =
            dto.promisedTo ??
            (await this.operatingConfig.promisedBy(tx, dto.serviceLevel ?? "STANDARD", occurredAt));

          const shipment = requireRow(
            await tx
              .insert(shipments)
              .values({
                tenantId,
                trackingNumber,
                recipientId,
                originAddressId: origin.addressId,
                destinationAddressId: destination.addressId,
                senderName: dto.senderName,
                senderPhone: dto.senderPhone,
                recipientName: dto.recipientName,
                recipientPhone: dto.recipientPhone,
                currency: dto.currency,
                codAmountMinor: codAmount,
                codStatus,
                ...(dto.merchantId === undefined ? {} : { merchantId: dto.merchantId }),
                ...(dto.externalReference === undefined
                  ? {}
                  : { externalReference: dto.externalReference }),
                ...(dto.serviceLevel === undefined ? {} : { serviceLevel: dto.serviceLevel }),
                ...(dto.recipientPhoneAlt === undefined
                  ? {}
                  : { recipientPhoneAlt: dto.recipientPhoneAlt }),
                ...(dto.promisedFrom === undefined ? {} : { promisedFrom: dto.promisedFrom }),
                ...(promisedTo === null ? {} : { promisedTo }),
                ...(dto.weightGrams === undefined ? {} : { weightGrams: dto.weightGrams }),
                ...(dto.volumeCm3 === undefined ? {} : { volumeCm3: dto.volumeCm3 }),
                ...(dto.parcelCount === undefined ? {} : { parcelCount: dto.parcelCount }),
                ...(dto.declaredValueMinor === undefined
                  ? {}
                  : { declaredValueMinor: dto.declaredValueMinor }),
                ...(dto.maxAttempts === undefined ? {} : { maxAttempts: dto.maxAttempts }),
                ...(dto.priority === undefined ? {} : { priority: dto.priority }),
                ...(dto.requiredSkills === undefined ? {} : { requiredSkills: dto.requiredSkills }),
                ...(dto.customFields === undefined ? {} : { customFields: dto.customFields }),
              })
              .returning(),
          );

          // Rule 12: at least one leg at creation. A direct same-city job is a
          // single LAST_MILE leg from origin address to destination address.
          await tx.insert(shipmentLegs).values({
            tenantId,
            shipmentId: shipment.id,
            legNumber: 1,
            legType: "LAST_MILE",
            status: "PLANNED",
            fromType: "ADDRESS",
            toType: "ADDRESS",
            fromAddressId: origin.addressId,
            toAddressId: destination.addressId,
          });

          await this.events.applyTo(tx, snapshotOf(shipment), {
            eventType: "created",
            actor: ctx.actor,
            idempotencyKey: dto.idempotencyKey,
            occurredAt,
            outboxPayload: buildCreatedPayload(dto, shipment, {
              trackingNumber,
              originAddressId: origin.addressId,
              destinationAddressId: destination.addressId,
              codAmount,
            }),
          });

          return this.reload(tx, shipment.id);
        });
      } catch (error) {
        if (
          isUniqueViolation(error, "shipments_tenant_tracking_uq") &&
          attempt < TRACKING_ALLOCATION_RETRIES - 1
        ) {
          // Astronomically unlikely with 50 bits of entropy, but a mint clash is a
          // retry, not a failure.
          continue;
        }
        if (isUniqueViolation(error, "shipments_tenant_merchant_extref_uq")) {
          throw new ConflictError(
            "SHIPMENT_EXTERNAL_REF_TAKEN",
            `A shipment with external reference "${dto.externalReference ?? ""}" already exists for this merchant.`,
          );
        }
        if (isUniqueViolation(error, "shipment_events_tenant_idempotency_uq")) {
          // A concurrent identical create won the race — return its result.
          const raced = await this.findByIdempotencyKey(dto.idempotencyKey);
          if (raced !== null) {
            return raced;
          }
        }
        throw error;
      }
    }
    throw new ConflictError(
      "SHIPMENT_TRACKING_ALLOCATION_FAILED",
      "Could not allocate a unique tracking number; please retry.",
    );
  }

  private async resolveRecipient(dto: CreateShipmentInput): Promise<string> {
    const existing = await this.recipients.findByPhone(dto.recipientPhone);
    if (existing !== null) {
      return existing.id;
    }
    try {
      const created = await this.recipients.create({
        fullName: dto.recipientName,
        phone: dto.recipientPhone,
        ...(dto.recipientPhoneAlt === undefined ? {} : { phoneAlt: dto.recipientPhoneAlt }),
        ...(dto.recipientLanguage === undefined
          ? {}
          : { preferredLanguage: dto.recipientLanguage }),
      });
      return created.id;
    } catch (error) {
      // A concurrent create for the same (tenant, phone) — reuse the winner.
      if (error instanceof ConflictError) {
        const again = await this.recipients.findByPhone(dto.recipientPhone);
        if (again !== null) {
          return again.id;
        }
      }
      throw error;
    }
  }

  // ── Driver-owned lifecycle commands ──────────────────────────────────────────

  async recordPickup(id: string, input: unknown, ctx: CommandContext): Promise<Shipment> {
    const dto = parseWithZod(recordPickupSchema, input);
    const occurredAt = dto.occurredAt ?? new Date();

    return this.runCommand(id, dto.idempotencyKey, async (tx, shipment) => {
      const legId = dto.legId ?? (await this.firstLegId(tx, shipment.id));
      await this.events.applyTo(tx, snapshotOf(shipment), {
        eventType: "picked_up",
        actor: ctx.actor,
        idempotencyKey: dto.idempotencyKey,
        occurredAt,
        driverId: dto.driverId,
        ...(legId === undefined ? {} : { legId }),
        ...(dto.routeId === undefined ? {} : { routeId: dto.routeId }),
        ...(dto.location === undefined ? {} : { location: dto.location }),
        ...(dto.locationAccuracyM === undefined
          ? {}
          : { locationAccuracyM: dto.locationAccuracyM }),
        ...(dto.metadata === undefined ? {} : { metadata: dto.metadata }),
        outboxPayload: {
          shipmentId: shipment.id,
          legId: legId ?? null,
          driverId: dto.driverId,
          routeId: dto.routeId ?? null,
          routeStopId: dto.routeStopId ?? null,
          scannedBarcode: dto.scannedBarcode ?? null,
          // This event freezes cod_amount_minor (rule 5): no command mutates it
          // after PICKED_UP, so custody-time COD tampering is not representable.
          custodyFrom: "MERCHANT",
          custodyTo: "DRIVER",
          occurredAt: occurredAt.toISOString(),
        },
      });
      if (legId !== undefined) {
        await tx
          .update(shipmentLegs)
          .set({ status: "IN_PROGRESS", actualStartAt: occurredAt, updatedAt: sql`now()` })
          .where(eq(shipmentLegs.id, legId));
      }
    });
  }

  async confirmDelivery(id: string, input: unknown, ctx: CommandContext): Promise<Shipment> {
    const dto = parseWithZod(confirmDeliverySchema, input);
    const occurredAt = dto.occurredAt ?? new Date();

    // Distance is computed from the destination geocode; read it before the write
    // transaction so we never open a nested transaction on the address service.
    const pre = await this.getById(id);
    const distanceM = await this.podDistance(pre.destinationAddressId, dto.location);

    return this.runCommand(id, dto.idempotencyKey, async (tx, shipment) => {
      const isCod = shipment.codAmountMinor > 0n;
      if (isCod && dto.codCollected !== true) {
        // Rule 8: a COD shipment cannot be marked DELIVERED without collecting cash.
        throw new BusinessRuleError(
          "COD_NOT_COLLECTED",
          "A COD shipment cannot be delivered without collecting the cash owed.",
        );
      }
      if (isCod && dto.pod.podType === "contactless") {
        throw new BusinessRuleError(
          "COD_REQUIRES_STRONG_POD",
          "A COD delivery requires signed, photographed, OTP, or ID-checked proof — not contactless.",
        );
      }
      assertPodComplete(dto.pod);

      const legId = dto.legId ?? (await this.firstLegId(tx, shipment.id));
      const attemptId = randomUUID();
      const attemptNumber = shipment.attemptCount + 1;
      let snap = snapshotOf(shipment);

      // 1. The attempt (SUCCESS) — a uniform signal for attempt-rate and fraud.
      const attempted = await this.events.applyTo(tx, snap, {
        eventType: "delivery_attempted",
        actor: ctx.actor,
        idempotencyKey: dto.idempotencyKey,
        occurredAt,
        driverId: dto.driverId,
        incrementAttempt: true,
        ...(legId === undefined ? {} : { legId }),
        ...(dto.location === undefined ? {} : { location: dto.location }),
        ...(dto.locationAccuracyM === undefined
          ? {}
          : { locationAccuracyM: dto.locationAccuracyM }),
        outboxPayload: {
          shipmentId: shipment.id,
          legId: legId ?? null,
          attemptId,
          attemptNumber,
          maxAttempts: shipment.maxAttempts,
          driverId: dto.driverId,
          outcome: "SUCCESS",
          dwellTimeSeconds: dto.dwellTimeSeconds ?? null,
          ...(distanceM === null ? {} : { distanceFromDestinationM: distanceM }),
          occurredAt: occurredAt.toISOString(),
        },
      });
      snap = advance(snap, attempted);

      // 2. Proof of delivery — one per shipment, immutable evidence.
      const podId = await this.insertPod(tx, shipment, dto, distanceM, occurredAt);
      await this.outbox.publish(tx, {
        eventType: "pod.captured",
        aggregateType: "shipment",
        aggregateId: shipment.id,
        occurredAt,
        payload: {
          shipmentId: shipment.id,
          podId,
          podType: dto.pod.podType,
          ...(distanceM === null ? {} : { distanceFromDestinationM: distanceM }),
          capturedAt: occurredAt.toISOString(),
        },
      });

      // 3. Delivered — the projection flips to DELIVERED, COD to COLLECTED.
      const wasOnTime =
        shipment.promisedTo === null ? true : occurredAt.getTime() <= shipment.promisedTo.getTime();
      await this.events.applyTo(tx, snap, {
        eventType: "delivered",
        actor: ctx.actor,
        idempotencyKey: `${dto.idempotencyKey}#delivered`,
        occurredAt,
        driverId: dto.driverId,
        ...(legId === undefined ? {} : { legId }),
        ...(dto.location === undefined ? {} : { location: dto.location }),
        ...(isCod ? { codStatus: "COLLECTED" satisfies CodStatus } : {}),
        outboxPayload: {
          shipmentId: shipment.id,
          // Self-contained for the notification consumer (event-storming §2.2):
          // it SMSes the customer without importing shipment.
          trackingNumber: shipment.trackingNumber,
          recipientPhone: shipment.recipientPhone,
          legId: legId ?? null,
          attemptId,
          podId,
          podType: dto.pod.podType,
          recipientName: dto.pod.recipientName,
          recipientRelationship: dto.pod.recipientRelationship ?? null,
          driverId: dto.driverId,
          routeId: dto.routeId ?? null,
          routeStopId: dto.routeStopId ?? null,
          codAmountMinor: shipment.codAmountMinor.toString(),
          codCollected: isCod,
          currency: shipment.currency,
          promisedTo: shipment.promisedTo === null ? null : shipment.promisedTo.toISOString(),
          wasOnTime,
          ...(distanceM === null ? {} : { distanceFromDestinationM: distanceM }),
          occurredAt: occurredAt.toISOString(),
          recordedAt: new Date().toISOString(),
        },
      });

      // 4. COD cash liability — a separate fact for the Ledger context.
      if (isCod) {
        await this.outbox.publish(tx, {
          eventType: "cod.collected",
          aggregateType: "shipment",
          aggregateId: shipment.id,
          occurredAt,
          payload: {
            shipmentId: shipment.id,
            driverId: dto.driverId,
            // The party the collected cash is owed to; the Ledger consumer credits
            // MERCHANT_PAYABLE from this. Null when the shipment has no merchant —
            // finance then accrues it to a tenant-level payable. Self-contained
            // (event-storming §2.2): the ledger never reads back into shipment.
            merchantId: shipment.merchantId,
            amountMinor: shipment.codAmountMinor.toString(),
            currency: shipment.currency,
            occurredAt: occurredAt.toISOString(),
          },
        });
      }

      // 5. The final leg is complete (leg rule 5).
      if (legId !== undefined) {
        await tx
          .update(shipmentLegs)
          .set({ status: "COMPLETED", actualEndAt: occurredAt, updatedAt: sql`now()` })
          .where(eq(shipmentLegs.id, legId));
      }
    });
  }

  async recordFailedAttempt(id: string, input: unknown, ctx: CommandContext): Promise<Shipment> {
    const dto = parseWithZod(recordFailedAttemptSchema, input);
    const occurredAt = dto.occurredAt ?? new Date();

    const pre = await this.getById(id);
    const distanceM = await this.podDistance(pre.destinationAddressId, dto.location);

    return this.runCommand(id, dto.idempotencyKey, async (tx, shipment) => {
      const legId = dto.legId ?? (await this.firstLegId(tx, shipment.id));
      const attemptId = randomUUID();
      const attemptNumber = shipment.attemptCount + 1;
      const attemptsRemaining = Math.max(0, shipment.maxAttempts - attemptNumber);
      let snap = snapshotOf(shipment);

      const attempted = await this.events.applyTo(tx, snap, {
        eventType: "delivery_attempted",
        actor: ctx.actor,
        idempotencyKey: dto.idempotencyKey,
        occurredAt,
        driverId: dto.driverId,
        reasonCode: dto.reasonCode,
        incrementAttempt: true,
        ...(legId === undefined ? {} : { legId }),
        ...(dto.location === undefined ? {} : { location: dto.location }),
        ...(dto.locationAccuracyM === undefined
          ? {}
          : { locationAccuracyM: dto.locationAccuracyM }),
        outboxPayload: {
          shipmentId: shipment.id,
          legId: legId ?? null,
          attemptId,
          attemptNumber,
          maxAttempts: shipment.maxAttempts,
          driverId: dto.driverId,
          outcome: "FAILED",
          reasonCode: dto.reasonCode,
          dwellTimeSeconds: dto.dwellTimeSeconds ?? null,
          ...(distanceM === null ? {} : { distanceFromDestinationM: distanceM }),
          occurredAt: occurredAt.toISOString(),
        },
      });
      snap = advance(snap, attempted);

      const failed = await this.events.applyTo(tx, snap, {
        eventType: "delivery_failed",
        actor: ctx.actor,
        idempotencyKey: `${dto.idempotencyKey}#failed`,
        occurredAt,
        driverId: dto.driverId,
        reasonCode: dto.reasonCode,
        ...(legId === undefined ? {} : { legId }),
        ...(dto.location === undefined ? {} : { location: dto.location }),
        outboxPayload: {
          shipmentId: shipment.id,
          // Self-contained for the notification consumer (event-storming §2.2).
          trackingNumber: shipment.trackingNumber,
          recipientName: shipment.recipientName,
          recipientPhone: shipment.recipientPhone,
          legId: legId ?? null,
          attemptId,
          attemptNumber,
          maxAttempts: shipment.maxAttempts,
          reasonCode: dto.reasonCode,
          reasonNotes: dto.reasonNotes ?? null,
          driverId: dto.driverId,
          dwellTimeSeconds: dto.dwellTimeSeconds ?? null,
          attemptsRemaining,
          ...(distanceM === null ? {} : { distanceFromDestinationM: distanceM }),
          occurredAt: occurredAt.toISOString(),
        },
      });
      snap = advance(snap, failed);

      // ⚠️ The REASON decides first, not just the attempt count.
      //
      // `allowsReattempt` existed in the old hardcoded taxonomy and was never
      // consulted: a parcel the customer had explicitly REFUSED consumed its two
      // remaining attempts before returning. Each was a driver making a trip to
      // someone who had already said no, plus the return leg afterwards — the
      // most expensive ordinary mistake in a COD market.
      const decision = await this.operatingConfig.decideReattempt(tx, {
        reasonCode: dto.reasonCode,
        attemptNumber,
        maxAttempts: shipment.maxAttempts,
        serviceLevel: shipment.serviceLevel,
        failedAt: occurredAt,
      });

      // Rule 9 and the reason policy converge here: either way the parcel goes to
      // RETURN_PENDING. At MVP this runs inline and atomically; it moves to an
      // event consumer when the dispatch context is built (event-storming
      // P-series).
      if (decision.allowed) {
        // Scheduled on the tenant's own working calendar, so a Saturday-evening
        // failure is due Monday at opening rather than Sunday at the same hour.
        await tx
          .update(shipments)
          .set({ nextAttemptAt: decision.nextAttemptAt })
          .where(eq(shipments.id, shipment.id));
      } else {
        await this.events.applyTo(tx, snap, {
          eventType: "return_initiated",
          actor: { actorType: "SYSTEM" },
          idempotencyKey: `${dto.idempotencyKey}#return`,
          occurredAt,
          // Persisted on the EVENT, not only in the outbox payload — outbox rows
          // are relayed and deleted, and the bon de retour has to state why the
          // parcel came back weeks later, when a merchant queries it.
          reasonCode: dto.reasonCode,
          outboxPayload: {
            shipmentId: shipment.id,
            // Distinguishes "we tried three times" from "they said no" — the
            // merchant needs to know which, and a report that conflates them
            // makes a refusal problem look like a delivery-performance one.
            reason:
              decision.reason === "REASON_FORBIDS"
                ? `NOT_REATTEMPTABLE:${dto.reasonCode}`
                : "ATTEMPTS_EXHAUSTED",
            finalAttemptCount: attemptNumber,
            returnToAddressId: shipment.originAddressId,
            returnHubId: null,
            codAmountMinor: shipment.codAmountMinor.toString(),
            // Self-contained for the notification consumer (event-storming §2.2).
            // The automatic path is the COMMON one — most returns are decided by
            // the reason policy, not by a dispatcher — so omitting these here made
            // the customer message unreachable for the majority of returns.
            trackingNumber: shipment.trackingNumber,
            recipientPhone: shipment.recipientPhone,
            merchantId: shipment.merchantId,
            occurredAt: occurredAt.toISOString(),
          },
        });

        // §3.7 rule 6 applies whoever decided the return. Reached automatically
        // the parcel would otherwise sit in RETURN_PENDING with nothing planned
        // to carry it back.
        await this.spawnReturnLeg(tx, shipment, shipment.originAddressId, null);

        // No further attempt is due, so the column must not keep pointing at one.
        await tx
          .update(shipments)
          .set({ nextAttemptAt: null })
          .where(eq(shipments.id, shipment.id));
      }
    });
  }

  async initiateReturn(id: string, input: unknown, ctx: CommandContext): Promise<Shipment> {
    const dto = parseWithZod(initiateReturnSchema, input);
    const occurredAt = dto.occurredAt ?? new Date();

    return this.runCommand(id, dto.idempotencyKey, async (tx, shipment) => {
      const returnToAddressId = dto.returnToAddressId ?? shipment.originAddressId;

      await this.events.applyTo(tx, snapshotOf(shipment), {
        eventType: "return_initiated",
        actor: ctx.actor,
        idempotencyKey: dto.idempotencyKey,
        occurredAt,
        outboxPayload: {
          shipmentId: shipment.id,
          reason: dto.reason,
          finalAttemptCount: shipment.attemptCount,
          returnToAddressId,
          returnHubId: dto.returnHubId ?? null,
          codAmountMinor: shipment.codAmountMinor.toString(),
          // Self-contained for the notification consumer (event-storming §2.2) —
          // the recipient is told the parcel is going back, because the usual
          // cause is that they were unreachable and they may still intervene.
          trackingNumber: shipment.trackingNumber,
          recipientPhone: shipment.recipientPhone,
          merchantId: shipment.merchantId,
          occurredAt: occurredAt.toISOString(),
        },
      });

      // §3.7 rule 6: a FAILED last-mile leg spawns either a re-attempt leg or a
      // RETURN leg — "never leaves the shipment legless". Without this the
      // parcel is in RETURN_PENDING with nothing planned to move it, so it
      // cannot be put on a route and sits in a hub until someone notices.
      await this.spawnReturnLeg(tx, shipment, returnToAddressId, dto.returnHubId ?? null);

      // No further delivery attempt is due.
      await tx.update(shipments).set({ nextAttemptAt: null }).where(eq(shipments.id, shipment.id));
    });
  }

  /**
   * Records the parcel back with the merchant — the end of the RTO lifecycle.
   *
   * ⚠️ This command did not exist. `RETURN_PENDING` was reachable and `RETURNED`
   * was in the state machine, but nothing could make the transition: a returning
   * parcel had no way to be closed out, so the merchant's own view of it stayed
   * "coming back" forever and the COD never resolved.
   */
  async completeReturn(id: string, input: unknown, ctx: CommandContext): Promise<Shipment> {
    const dto = parseWithZod(completeReturnSchema, input);
    const occurredAt = dto.occurredAt ?? new Date();

    return this.runCommand(id, dto.idempotencyKey, async (tx, shipment) => {
      const legId = await this.openReturnLegId(tx, shipment.id);

      await this.events.applyTo(tx, snapshotOf(shipment), {
        eventType: "returned",
        actor: ctx.actor,
        idempotencyKey: dto.idempotencyKey,
        occurredAt,
        ...(legId === undefined ? {} : { legId }),
        ...(dto.driverId === undefined ? {} : { driverId: dto.driverId }),
        outboxPayload: {
          shipmentId: shipment.id,
          trackingNumber: shipment.trackingNumber,
          merchantId: shipment.merchantId,
          receivedByName: dto.receivedByName ?? null,
          returnedToAddressId: shipment.originAddressId,
          // What the merchant is owed, and is not: the parcel came back, so the
          // COD was never collected and never will be for this shipment.
          codAmountMinor: shipment.codAmountMinor.toString(),
          codCollected: false,
          occurredAt: occurredAt.toISOString(),
        },
      });

      if (legId !== undefined) {
        await tx
          .update(shipmentLegs)
          .set({ status: "COMPLETED", actualEndAt: occurredAt, updatedAt: sql`now()` })
          .where(eq(shipmentLegs.id, legId));
      }

      await this.closeUncollectedCod(tx, shipment);
    });
  }

  /**
   * Closes a COD that will never be collected — the parcel is back, or gone.
   *
   * ⚠️ Left at PENDING this money stays in cash-in-field (docs/01 §4.5 #5.5)
   * forever. That figure is what a courier reconciles its drivers' satchels
   * against at end of day, so every returned or cancelled COD parcel inflates it
   * by its full value, permanently, in the direction that reads as "the driver
   * is short". With normal COD return rates the daily reconciliation is simply
   * wrong.
   *
   * CANCELLED, not NOT_APPLICABLE: I6 (`shipments_cod_consistency_chk`) ties
   * NOT_APPLICABLE to a zero amount, and zeroing the amount would erase what was
   * at stake — the one number a merchant dispute turns on. The amount stays; the
   * status says the cash is closed. See migration 0027.
   */
  private async closeUncollectedCod(tx: TenantTransaction, shipment: Shipment): Promise<void> {
    if (shipment.codStatus !== "PENDING") {
      return;
    }
    await tx
      .update(shipments)
      .set({ codStatus: "CANCELLED" satisfies CodStatus })
      .where(eq(shipments.id, shipment.id));
  }

  /**
   * Plans the leg that carries the parcel back to its origin.
   *
   * Numbered after the last existing leg rather than reusing the failed one —
   * DM4's recommendation, which preserves plan-vs-actual per attempt. Reusing
   * the leg would overwrite the timings of the delivery that failed, and those
   * are what the failure report is built from.
   */
  private async spawnReturnLeg(
    tx: TenantTransaction,
    shipment: Shipment,
    returnToAddressId: string,
    returnHubId: string | null,
  ): Promise<void> {
    const existing = await tx
      .select({ legNumber: shipmentLegs.legNumber })
      .from(shipmentLegs)
      .where(eq(shipmentLegs.shipmentId, shipment.id))
      .orderBy(desc(shipmentLegs.legNumber))
      .limit(1);

    // Idempotent: a re-initiated return must not stack a second return leg on a
    // parcel that already has one planned.
    const alreadyReturning = await tx
      .select({ id: shipmentLegs.id })
      .from(shipmentLegs)
      .where(and(eq(shipmentLegs.shipmentId, shipment.id), eq(shipmentLegs.legType, "RETURN")))
      .limit(1);

    if (alreadyReturning.length > 0) {
      return;
    }

    await tx.insert(shipmentLegs).values({
      tenantId: shipment.tenantId,
      shipmentId: shipment.id,
      legNumber: (existing[0]?.legNumber ?? 0) + 1,
      legType: "RETURN",
      status: "PLANNED",
      fromType: returnHubId === null ? "ADDRESS" : "HUB",
      toType: "ADDRESS",
      ...(returnHubId === null
        ? { fromAddressId: shipment.destinationAddressId }
        : { fromHubId: returnHubId }),
      toAddressId: returnToAddressId,
    });
  }

  /** The planned or in-progress RETURN leg, if one exists. */
  private async openReturnLegId(
    tx: TenantTransaction,
    shipmentId: string,
  ): Promise<string | undefined> {
    const rows = await tx
      .select({ id: shipmentLegs.id })
      .from(shipmentLegs)
      .where(
        and(
          eq(shipmentLegs.shipmentId, shipmentId),
          eq(shipmentLegs.legType, "RETURN"),
          inArray(shipmentLegs.status, ["PLANNED", "IN_PROGRESS"]),
        ),
      )
      .orderBy(desc(shipmentLegs.legNumber))
      .limit(1);

    return rows[0]?.id;
  }

  async cancel(id: string, input: unknown, ctx: CommandContext): Promise<Shipment> {
    const dto = parseWithZod(cancelShipmentSchema, input);
    const occurredAt = dto.occurredAt ?? new Date();

    return this.runCommand(id, dto.idempotencyKey, async (tx, shipment) => {
      const status = toShipmentStatus(shipment.status);
      const wasInCustody = isInCustody(status);
      await this.events.applyTo(tx, snapshotOf(shipment), {
        eventType: "cancelled",
        actor: ctx.actor,
        idempotencyKey: dto.idempotencyKey,
        occurredAt,
        ...(ctx.canOverride === undefined ? {} : { canOverride: ctx.canOverride }),
        outboxPayload: {
          shipmentId: shipment.id,
          cancelledByUserId: ctx.actor.actorId ?? null,
          actorType: ctx.actor.actorType,
          reason: dto.reason,
          statusAtCancellation: status,
          wasInCustody,
          occurredAt: occurredAt.toISOString(),
        },
      });

      // A cancelled parcel's cash is never coming in either.
      await this.closeUncollectedCod(tx, shipment);
    });
  }

  /**
   * The seam the dispatch and hub contexts will call to record the events they
   * own (assignment, hub scans, manifest movements, out-for-delivery). Same state
   * machine, sequence, idempotency, and projection as every other command.
   */
  async recordEvent(id: string, input: unknown, ctx: CommandContext): Promise<Shipment> {
    const dto = parseWithZod(recordEventSchema, input);
    const occurredAt = dto.occurredAt ?? new Date();

    return this.runCommand(id, dto.idempotencyKey, async (tx, shipment) => {
      const legId = dto.legId ?? (await this.firstLegId(tx, shipment.id));
      await this.events.applyTo(tx, snapshotOf(shipment), {
        eventType: dto.eventType,
        actor: ctx.actor,
        idempotencyKey: dto.idempotencyKey,
        occurredAt,
        ...(legId === undefined ? {} : { legId }),
        ...(dto.hubId === undefined ? {} : { hubId: dto.hubId }),
        ...(dto.driverId === undefined ? {} : { driverId: dto.driverId }),
        ...(dto.routeId === undefined ? {} : { routeId: dto.routeId }),
        ...(dto.location === undefined ? {} : { location: dto.location }),
        ...(dto.locationAccuracyM === undefined
          ? {}
          : { locationAccuracyM: dto.locationAccuracyM }),
        ...(dto.reasonCode === undefined ? {} : { reasonCode: dto.reasonCode }),
        ...(dto.metadata === undefined ? {} : { metadata: dto.metadata }),
        outboxPayload: {
          shipmentId: shipment.id,
          legId: legId ?? null,
          hubId: dto.hubId ?? null,
          driverId: dto.driverId ?? null,
          routeId: dto.routeId ?? null,
          routeStopId: dto.routeStopId ?? null,
          occurredAt: occurredAt.toISOString(),
          ...(dto.payload ?? {}),
        },
      });
    });
  }

  // ── Queries ──────────────────────────────────────────────────────────────────

  async getById(id: string): Promise<Shipment> {
    return this.database.withTenant(async (tx) => {
      const rows = await tx.select().from(shipments).where(eq(shipments.id, id)).limit(1);
      const row = rows[0];
      if (row === undefined) {
        throw new NotFoundError("Shipment");
      }
      return row;
    });
  }

  /**
   * Resolves a scanned barcode to its shipment, or null when nothing matches.
   *
   * The tracking number is the shipment's public identity (domain rule 10), so
   * this is the seam every scanning context needs: a hub operator holding a
   * parcel knows only what is printed on the label. Returns null rather than
   * throwing — an unrecognised barcode is a routine operational fact to be
   * recorded as a discrepancy, not an exception.
   */
  async findByTrackingNumber(trackingNumber: string): Promise<Shipment | null> {
    return this.database.withTenant(async (tx) => {
      const rows = await tx
        .select()
        .from(shipments)
        .where(eq(shipments.trackingNumber, trackingNumber))
        .limit(1);
      return rows[0] ?? null;
    });
  }

  /**
   * Bulk read by id, for callers holding a set of shipments to act on.
   *
   * Exists so a context processing a manifest or a route does not fan out into
   * one `getById` per parcel — a 200-item manifest would otherwise be 200
   * round trips just to read status before deciding what to record.
   */
  async findManyByIds(ids: readonly string[]): Promise<Shipment[]> {
    if (ids.length === 0) {
      return [];
    }
    return this.database.withTenant(async (tx) =>
      tx
        .select()
        .from(shipments)
        .where(inArray(shipments.id, [...ids])),
    );
  }

  async list(input: unknown = {}): Promise<ShipmentPage> {
    const dto = parseWithZod(listShipmentsSchema, input);
    const limit = dto.limit ?? DEFAULT_PAGE_SIZE;
    return this.database.withTenant(async (tx) => {
      const conditions = [
        ...(dto.status === undefined ? [] : [eq(shipments.status, dto.status)]),
        ...(dto.merchantId === undefined ? [] : [eq(shipments.merchantId, dto.merchantId)]),
        ...(dto.cursor === undefined ? [] : [lt(shipments.id, dto.cursor)]),
      ];
      const rows = await tx
        .select()
        .from(shipments)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(shipments.id))
        .limit(limit + 1);
      return toPage(rows, limit);
    });
  }

  /** The custody ledger for a shipment, in sequence order (the source of truth). */
  async getEvents(id: string): Promise<ShipmentEventView[]> {
    return this.database.withTenant(async (tx) => {
      const exists = await tx
        .select({ id: shipments.id })
        .from(shipments)
        .where(eq(shipments.id, id))
        .limit(1);
      if (exists[0] === undefined) {
        throw new NotFoundError("Shipment");
      }
      return tx
        .select({
          id: shipmentEvents.id,
          sequence: shipmentEvents.sequence,
          eventType: shipmentEvents.eventType,
          occurredAt: shipmentEvents.occurredAt,
          recordedAt: shipmentEvents.recordedAt,
          actorType: shipmentEvents.actorType,
          actorId: shipmentEvents.actorId,
          latitude: sql<number | null>`ST_Y(${shipmentEvents.location}::geometry)`,
          longitude: sql<number | null>`ST_X(${shipmentEvents.location}::geometry)`,
          hubId: shipmentEvents.hubId,
          driverId: shipmentEvents.driverId,
          routeId: shipmentEvents.routeId,
          legId: shipmentEvents.legId,
          reasonCode: shipmentEvents.reasonCode,
          idempotencyKey: shipmentEvents.idempotencyKey,
        })
        .from(shipmentEvents)
        .where(eq(shipmentEvents.shipmentId, id))
        .orderBy(asc(shipmentEvents.sequence));
    });
  }

  /**
   * The dispatch-planning read: given shipment leg ids, returns each leg with the
   * parent-shipment attributes dispatch needs to place it on a route (target,
   * required skills, load, COD, recipient snapshot) and the current shipment
   * status — which dispatch checks against the state machine before recording an
   * assignment. Legs from other tenants are invisible (RLS); unknown ids are
   * simply absent from the result.
   */
  async getLegsForPlanning(legIds: readonly string[]): Promise<PlanningLeg[]> {
    if (legIds.length === 0) {
      return [];
    }
    return this.database.withTenant(async (tx) => {
      const rows = await tx
        .select({
          legId: shipmentLegs.id,
          shipmentId: shipmentLegs.shipmentId,
          legType: shipmentLegs.legType,
          legStatus: shipmentLegs.status,
          fromType: shipmentLegs.fromType,
          toType: shipmentLegs.toType,
          fromAddressId: shipmentLegs.fromAddressId,
          toAddressId: shipmentLegs.toAddressId,
          fromHubId: shipmentLegs.fromHubId,
          toHubId: shipmentLegs.toHubId,
          routeStopId: shipmentLegs.routeStopId,
          shipmentStatus: shipments.status,
          requiredSkills: shipments.requiredSkills,
          parcelCount: shipments.parcelCount,
          weightGrams: shipments.weightGrams,
          volumeCm3: shipments.volumeCm3,
          codAmountMinor: shipments.codAmountMinor,
          currency: shipments.currency,
          trackingNumber: shipments.trackingNumber,
          recipientName: shipments.recipientName,
          recipientPhone: shipments.recipientPhone,
        })
        .from(shipmentLegs)
        .innerJoin(shipments, eq(shipmentLegs.shipmentId, shipments.id))
        .where(inArray(shipmentLegs.id, [...legIds]));
      return rows.map((r) => ({
        legId: r.legId,
        shipmentId: r.shipmentId,
        legType: r.legType,
        legStatus: r.legStatus,
        shipmentStatus: toShipmentStatus(r.shipmentStatus),
        fromType: r.fromType,
        toType: r.toType,
        fromAddressId: r.fromAddressId,
        toAddressId: r.toAddressId,
        fromHubId: r.fromHubId,
        toHubId: r.toHubId,
        routeStopId: r.routeStopId,
        requiredSkills: r.requiredSkills,
        parcelCount: r.parcelCount,
        weightGrams: r.weightGrams,
        volumeCm3: r.volumeCm3,
        codAmountMinor: r.codAmountMinor,
        currency: r.currency,
        trackingNumber: r.trackingNumber,
        recipientName: r.recipientName,
        recipientPhone: r.recipientPhone,
      }));
    });
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  /**
   * Runs a mutating command in one tenant transaction: locks the shipment row
   * (which serialises concurrent events and makes the sequence monotonic), skips
   * the work if this idempotency key was already applied, and returns the fresh
   * shipment. `fn` performs the appends via {@link ShipmentEventService}.
   */
  private async runCommand(
    id: string,
    idempotencyKey: string,
    fn: (tx: TenantTransaction, shipment: Shipment) => Promise<void>,
  ): Promise<Shipment> {
    return this.database.withTenant(async (tx) => {
      const shipment = await this.lock(tx, id);
      const applied = await this.isApplied(tx, shipment.tenantId, idempotencyKey);
      if (!applied) {
        await fn(tx, shipment);
      }
      return this.reload(tx, id);
    });
  }

  private async lock(tx: TenantTransaction, id: string): Promise<Shipment> {
    const rows = await tx
      .select()
      .from(shipments)
      .where(eq(shipments.id, id))
      .limit(1)
      .for("update");
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundError("Shipment");
    }
    return row;
  }

  private async reload(tx: TenantTransaction, id: string): Promise<Shipment> {
    const rows = await tx.select().from(shipments).where(eq(shipments.id, id)).limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundError("Shipment");
    }
    return row;
  }

  private async isApplied(
    tx: TenantTransaction,
    tenantId: string,
    idempotencyKey: string,
  ): Promise<boolean> {
    const rows = await tx
      .select({ id: shipmentEvents.id })
      .from(shipmentEvents)
      .where(
        and(
          eq(shipmentEvents.tenantId, tenantId),
          eq(shipmentEvents.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  private async findByIdempotencyKey(idempotencyKey: string): Promise<Shipment | null> {
    return this.database.withTenant(async (tx) => {
      const tenantId = TenantContext.requireTenantId();
      const rows = await tx
        .select({ shipmentId: shipmentEvents.shipmentId })
        .from(shipmentEvents)
        .where(
          and(
            eq(shipmentEvents.tenantId, tenantId),
            eq(shipmentEvents.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      const found = rows[0];
      if (found === undefined) {
        return null;
      }
      const shipmentRows = await tx
        .select()
        .from(shipments)
        .where(eq(shipments.id, found.shipmentId))
        .limit(1);
      return shipmentRows[0] ?? null;
    });
  }

  private async firstLegId(tx: TenantTransaction, shipmentId: string): Promise<string | undefined> {
    const rows = await tx
      .select({ id: shipmentLegs.id })
      .from(shipmentLegs)
      .where(eq(shipmentLegs.shipmentId, shipmentId))
      .orderBy(asc(shipmentLegs.legNumber))
      .limit(1);
    return rows[0]?.id;
  }

  private async podDistance(
    destinationAddressId: string,
    location: { lat: number; lng: number } | undefined,
  ): Promise<number | null> {
    if (location === undefined) {
      return null;
    }
    const destination = await this.addresses.getById(destinationAddressId);
    if (destination.latitude === null || destination.longitude === null) {
      return null;
    }
    return Math.round(
      haversineMetres({ lat: destination.latitude, lng: destination.longitude }, location),
    );
  }

  private async insertPod(
    tx: TenantTransaction,
    shipment: Shipment,
    dto: Pick<ConfirmDeliveryInput, "pod" | "location">,
    distanceM: number | null,
    capturedAt: Date,
  ): Promise<string> {
    const inserted = await tx
      .insert(pod)
      .values({
        tenantId: shipment.tenantId,
        shipmentId: shipment.id,
        podType: dto.pod.podType,
        recipientName: dto.pod.recipientName,
        otpVerified: dto.pod.otpVerified ?? false,
        capturedAt,
        ...(dto.pod.signatureObjectKey === undefined
          ? {}
          : { signatureObjectKey: dto.pod.signatureObjectKey }),
        ...(dto.pod.photoObjectKeys === undefined
          ? {}
          : { photoObjectKeys: dto.pod.photoObjectKeys }),
        ...(dto.pod.contentHash === undefined ? {} : { contentHash: dto.pod.contentHash }),
        ...(dto.pod.recipientRelationship === undefined
          ? {}
          : { recipientRelationship: dto.pod.recipientRelationship }),
        ...(dto.location === undefined ? {} : { capturedLocation: pointOf(dto.location) }),
        ...(distanceM === null ? {} : { distanceFromDestinationM: distanceM }),
        ...(dto.pod.deviceMetadata === undefined ? {} : { deviceMetadata: dto.pod.deviceMetadata }),
      })
      .returning({ id: pod.id });
    const row = inserted[0];
    if (row === undefined) {
      throw new Error("POD insert returned no row");
    }
    return row.id;
  }
}

/** Enforces that the POD actually carries the evidence its type promises. */
function assertPodComplete(podInput: ConfirmDeliveryInput["pod"]): void {
  switch (podInput.podType) {
    case "signature":
      if (podInput.signatureObjectKey === undefined) {
        throw new BusinessRuleError(
          "POD_INCOMPLETE",
          "A signature POD requires a captured signature.",
        );
      }
      return;
    case "photo":
      if (podInput.photoObjectKeys === undefined || podInput.photoObjectKeys.length === 0) {
        throw new BusinessRuleError("POD_INCOMPLETE", "A photo POD requires at least one photo.");
      }
      return;
    case "otp":
      if (podInput.otpVerified !== true) {
        throw new BusinessRuleError("POD_INCOMPLETE", "An OTP POD requires a verified code.");
      }
      return;
    case "id_check":
    case "contactless":
      // recipientName is required by the schema; no further artifact is mandatory.
      return;
  }
}

function snapshotOf(row: Shipment): ShipmentSnapshot {
  return {
    id: row.id,
    tenantId: row.tenantId,
    status: toShipmentStatus(row.status),
    lastSequence: row.lastSequence,
  };
}

function advance(
  snap: ShipmentSnapshot,
  result: { status: ShipmentSnapshot["status"]; sequence: bigint },
): ShipmentSnapshot {
  return { ...snap, status: result.status, lastSequence: result.sequence };
}

function buildCreatedPayload(
  dto: CreateShipmentInput,
  shipment: Shipment,
  extra: {
    trackingNumber: string;
    originAddressId: string;
    destinationAddressId: string;
    codAmount: bigint;
  },
): Record<string, unknown> {
  return {
    shipmentId: shipment.id,
    trackingNumber: extra.trackingNumber,
    merchantId: dto.merchantId ?? null,
    externalReference: dto.externalReference ?? null,
    serviceLevel: shipment.serviceLevel,
    senderName: dto.senderName,
    senderPhone: dto.senderPhone,
    originAddressId: extra.originAddressId,
    recipientName: dto.recipientName,
    recipientPhone: dto.recipientPhone,
    destinationAddressId: extra.destinationAddressId,
    parcelCount: shipment.parcelCount,
    weightGrams: shipment.weightGrams,
    codAmountMinor: extra.codAmount.toString(),
    currency: shipment.currency,
    legCount: 1,
    source: dto.source ?? "API",
  };
}

function toPage(rows: Shipment[], limit: number): ShipmentPage {
  if (rows.length > limit) {
    const items = rows.slice(0, limit);
    return { items, nextCursor: items[items.length - 1]?.id ?? null };
  }
  return { items: rows, nextCursor: null };
}

function requireRow(rows: Shipment[]): Shipment {
  const row = rows[0];
  if (row === undefined) {
    // INSERT ... RETURNING yields exactly one row or throws; this guards the type.
    throw new Error("Shipment insert returned no row");
  }
  return row;
}
