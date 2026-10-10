import { Injectable } from "@nestjs/common";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";

import { AddressService, MerchantService, RecipientService } from "../../directory/index.js";
import { AuditService, OperatingConfigService, OutboxService } from "../../platform/index.js";
import {
  DatabaseService,
  TenantContext,
  generateUuidV7,
  isUniqueViolation,
} from "../../../shared/database/index.js";
import type { TenantTransaction } from "../../../shared/database/index.js";
import {
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../../shared/errors/index.js";
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
  recordPickupScanSchema,
  recordPickupSchema,
} from "../domain/dtos.js";
import type {
  ConfirmDeliveryInput,
  CreateShipmentInput,
  RecordPickupScanInput,
} from "../domain/dtos.js";
import { haversineMetres } from "../domain/geo.js";
import { requestFingerprint } from "../domain/request-fingerprint.js";
import { decodeShipment, encodeShipment } from "../domain/shipment-snapshot.js";
import {
  pod,
  shipmentCommandKeys,
  shipmentEvents,
  shipmentLegs,
  shipments,
} from "../domain/schema.js";
import type { Shipment } from "../domain/schema.js";
import { generateTrackingNumber } from "../domain/tracking-number.js";
import { checkTransition, isInCustody, toShipmentStatus } from "../domain/shipment-status.js";
import type {
  CodStatus,
  EventActor,
  ShipmentEventType,
  ShipmentStatus,
} from "../domain/shipment-status.js";
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
    private readonly audit: AuditService,
  ) {}

  /**
   * Outcomes returned from a replayed idempotency key (I29), so the HTTP layer
   * can mark the response `Idempotency-Replayed: true` without every command
   * changing its return type. A WeakSet keyed by object identity: each replay
   * decodes a fresh object, nothing is shared between requests, and entries
   * are collected with the response.
   */
  private readonly replays = new WeakSet<Shipment>();

  /** Whether `shipment` is a recorded outcome returned by a replay. */
  isReplay(shipment: Shipment): boolean {
    return this.replays.has(shipment);
  }

  // ── Create ─────────────────────────────────────────────────────────────────

  async create(input: unknown, ctx: CommandContext): Promise<Shipment> {
    const dto = parseWithZod(createShipmentSchema, input);
    const spec: CommandSpec = {
      command: "create",
      binding: "caller",
      idempotencyKey: dto.idempotencyKey,
      request: dto,
    };
    const requestHash = requestFingerprint(spec.request);

    // Idempotent replay (I29): a retried create returns the shipment exactly as
    // first created and resolves no addresses a second time. Only for the same
    // caller and the same request; anything else is IDEMPOTENCY_KEY_REUSED,
    // where this used to hand back whatever shipment the key had made.
    const prior = await this.createReplay(spec, ctx, requestHash);
    if (prior !== null) {
      return prior;
    }

    /**
     * ⚠️ A MERCHANT's own scope wins over anything in the body.
     *
     * `MERCHANT` is the only role scoped BELOW the tenant (invariant I23/I24),
     * and RLS on `shipments` requires `merchant_id` to equal
     * `app.current_merchant_id`. Taking the id from the body left it NULL for a
     * merchant who did not send one — so the INSERT was refused by the policy
     * and **a merchant could not create a parcel at all**, despite holding
     * `shipment:create`.
     *
     * Deriving it from the token also closes the other half: a merchant cannot
     * create a parcel attributed to a RIVAL by passing someone else's id. Staff
     * roles carry no merchant scope and may still name one explicitly, which is
     * how a dispatcher files a parcel on a merchant's behalf.
     */
    const scopedMerchantId = TenantContext.current()?.merchantId;
    const merchantId = scopedMerchantId ?? dto.merchantId;

    if (merchantId !== undefined) {
      const merchant = await this.merchants.getById(merchantId);
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
                ...(merchantId === undefined ? {} : { merchantId }),
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

          const outcome = await this.reload(tx, shipment.id);
          await this.recordUse(tx, outcome, spec, actorIdOf(ctx), requestHash);
          return outcome;
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
        if (isKeyConflict(error)) {
          // Another create holding this key committed first. Identical request
          // from the same caller: return its outcome. Anything else: 422.
          const raced = await this.createReplay(spec, ctx, requestHash);
          if (raced !== null) {
            return raced;
          }
          throw keyReused();
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

  /** Staff record a collection on a driver's behalf. The driver is required. */
  async recordPickup(id: string, input: unknown, ctx: CommandContext): Promise<Shipment> {
    return this.applyPickup(id, parseWithZod(recordPickupSchema, input), ctx, {
      command: "pickup",
      binding: "caller",
    });
  }

  /**
   * A collection proven by a pickup scan (`pickup.parcel_scanned`). Not exposed
   * over HTTP. The collector may be a non-driver (a commercial), so the driver
   * is optional; see {@link recordPickupScanSchema}.
   */
  async recordPickupScan(id: string, input: unknown, ctx: CommandContext): Promise<Shipment> {
    // `fact`: the key is `pickup-scan:<event id>`, and a redelivered event is
    // exactly the retry it exists to absorb.
    return this.applyPickup(id, parseWithZod(recordPickupScanSchema, input), ctx, {
      command: "pickup_scan",
      binding: "fact",
    });
  }

  private async applyPickup(
    id: string,
    dto: RecordPickupScanInput,
    ctx: CommandContext,
    kind: Pick<CommandSpec, "command" | "binding">,
  ): Promise<Shipment> {
    const occurredAt = dto.occurredAt ?? new Date();
    const spec: CommandSpec = { ...kind, idempotencyKey: dto.idempotencyKey, request: dto };

    return this.runCommand(id, spec, ctx, async (tx, shipment) => {
      const legId = dto.legId ?? (await this.firstLegId(tx, shipment.id));
      await this.events.applyTo(tx, snapshotOf(shipment), {
        eventType: "picked_up",
        actor: ctx.actor,
        idempotencyKey: dto.idempotencyKey,
        occurredAt,
        ...(dto.driverId === undefined ? {} : { driverId: dto.driverId }),
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
          driverId: dto.driverId ?? null,
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
    await this.requireLinkedDriver(ctx);

    // Distance is computed from the destination geocode; read it before the write
    // transaction so we never open a nested transaction on the address service.
    const pre = await this.getById(id);
    const distanceM = await this.podDistance(pre.destinationAddressId, dto.location);

    const spec: CommandSpec = {
      command: "deliver",
      binding: "caller",
      idempotencyKey: dto.idempotencyKey,
      request: dto,
    };
    return this.runCommand(id, spec, ctx, async (tx, shipment) => {
      // Who delivered is decided before anything about HOW: authority first, so
      // a caller with no business touching this parcel learns nothing from the
      // COD and POD rules below.
      const driverId = await this.requireCustodian(tx, shipment, "delivered", ctx);

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
      const attemptId = await generateUuidV7(tx);
      const attemptNumber = shipment.attemptCount + 1;
      let snap = snapshotOf(shipment);

      // 1. The attempt (SUCCESS) — a uniform signal for attempt-rate and fraud.
      const attempted = await this.events.applyTo(tx, snap, {
        eventType: "delivery_attempted",
        actor: ctx.actor,
        idempotencyKey: dto.idempotencyKey,
        occurredAt,
        driverId,
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
          driverId,
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
        driverId,
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
          driverId,
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
            driverId,
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
    await this.requireLinkedDriver(ctx);

    const pre = await this.getById(id);
    const distanceM = await this.podDistance(pre.destinationAddressId, dto.location);

    const spec: CommandSpec = {
      command: "fail",
      binding: "caller",
      idempotencyKey: dto.idempotencyKey,
      request: dto,
    };
    return this.runCommand(id, spec, ctx, async (tx, shipment) => {
      const driverId = await this.requireCustodian(tx, shipment, "delivery_failed", ctx);

      const legId = dto.legId ?? (await this.firstLegId(tx, shipment.id));
      const attemptId = await generateUuidV7(tx);
      const attemptNumber = shipment.attemptCount + 1;
      const attemptsRemaining = Math.max(0, shipment.maxAttempts - attemptNumber);
      let snap = snapshotOf(shipment);

      const attempted = await this.events.applyTo(tx, snap, {
        eventType: "delivery_attempted",
        actor: ctx.actor,
        idempotencyKey: dto.idempotencyKey,
        occurredAt,
        driverId,
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
          driverId,
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
        driverId,
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
          driverId,
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

    const spec: CommandSpec = {
      command: "return",
      binding: "caller",
      idempotencyKey: dto.idempotencyKey,
      request: dto,
    };
    return this.runCommand(id, spec, ctx, async (tx, shipment) => {
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
    // A DRIVER-role caller must be a linked driver (I26). Staff are not asked:
    // a counter hand-back is booked to no driver by design.
    if (ctx.actor.actorType === "DRIVER") {
      await this.requireLinkedDriver(ctx);
    }

    const spec: CommandSpec = {
      command: "return_complete",
      binding: "caller",
      idempotencyKey: dto.idempotencyKey,
      request: dto,
    };
    return this.runCommand(id, spec, ctx, async (tx, shipment) => {
      const driverId = await this.returningDriver(tx, shipment, ctx);
      const legId = await this.openReturnLegId(tx, shipment.id);

      await this.events.applyTo(tx, snapshotOf(shipment), {
        eventType: "returned",
        actor: ctx.actor,
        idempotencyKey: dto.idempotencyKey,
        occurredAt,
        ...(legId === undefined ? {} : { legId }),
        ...(driverId === null ? {} : { driverId }),
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

      // A staff closure is a person asserting the parcel was handed back,
      // possibly while a driver still held it: audited, in this transaction,
      // so the record exists exactly when the closure does. A driver's closure
      // is already attributed to their driver record in the custody log.
      if (driverId === null) {
        await this.audit.record(tx, {
          action: "shipment.return_closed_by_staff",
          resourceType: "shipment",
          resourceId: shipment.id,
          actorType: "USER",
          actorId: ctx.actor.actorId ?? null,
          changes: {
            status: { from: shipment.status, to: "RETURNED" },
            codStatus: {
              from: shipment.codStatus,
              to: shipment.codStatus === "PENDING" ? "CANCELLED" : shipment.codStatus,
            },
          },
          context: {
            trackingNumber: shipment.trackingNumber,
            receivedByName: dto.receivedByName ?? null,
            // Who physically held the parcel when staff closed it.
            custodyAtClosure: {
              type: shipment.currentCustodyType,
              id: shipment.currentCustodyId,
            },
          },
        });
      }
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

    const spec: CommandSpec = {
      command: "cancel",
      binding: "caller",
      idempotencyKey: dto.idempotencyKey,
      request: dto,
    };
    return this.runCommand(id, spec, ctx, async (tx, shipment) => {
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

    // `fact`: internal only (no HTTP route). Its keys are server-derived and
    // name one fact about one shipment; see IdempotencyBinding.
    const spec: CommandSpec = {
      command: `event:${dto.eventType}`,
      binding: "fact",
      idempotencyKey: dto.idempotencyKey,
      request: dto,
    };
    return this.runCommand(id, spec, ctx, async (tx, shipment) => {
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
   * Runs a mutating command in one tenant transaction, exactly once per
   * idempotency key (invariant I29).
   *
   * Order is the security property:
   *   1. Lock the shipment row. Under RLS, so a caller who cannot see the
   *      shipment gets 404 before any idempotency state is consulted.
   *   2. Look the key up. A prior use must match this request's binding
   *      ({@link assertSameRequest}) or it is a 422 that discloses nothing. A
   *      match returns the RECORDED outcome; nothing is re-applied.
   *   3. Otherwise apply `fn` and record the key, with its binding and the
   *      resulting shipment, in the same transaction.
   *
   * ⚠️ This replaced a tenant-wide "does any event carry this key?" check that
   * ran before authorization: a key from parcel X turned a delivery of parcel Y
   * into a silent 200, and a non-custodian got 200 instead of 403 by reusing a
   * key (audit finding F2).
   *
   * Concurrency: identical requests serialise on the row lock, and the second
   * finds the first's key. Requests reusing one key on DIFFERENT shipments race
   * to insert it; the loser's unique violation rolls back its whole command and
   * becomes the 422 ({@link isKeyConflict}).
   */
  private async runCommand(
    id: string,
    spec: CommandSpec,
    ctx: CommandContext,
    fn: (tx: TenantTransaction, shipment: Shipment) => Promise<void>,
  ): Promise<Shipment> {
    const requestHash = requestFingerprint(spec.request);
    try {
      return await this.database.withTenant(async (tx) => {
        const shipment = await this.lock(tx, id);
        const prior = await this.priorUse(tx, spec.idempotencyKey);
        if (prior !== null) {
          assertSameRequest(prior, spec, { shipmentId: id, actorId: actorIdOf(ctx), requestHash });
          return this.recordedOutcome(tx, spec.idempotencyKey);
        }
        await fn(tx, shipment);
        const outcome = await this.reload(tx, id);
        await this.recordUse(tx, outcome, spec, actorIdOf(ctx), requestHash);
        return outcome;
      });
    } catch (error) {
      if (isKeyConflict(error)) {
        throw keyReused();
      }
      throw error;
    }
  }

  /** How an idempotency key was last used, or null if never (I29). */
  private async priorUse(tx: TenantTransaction, idempotencyKey: string): Promise<PriorUse | null> {
    const rows = await tx
      .select({
        shipmentId: shipmentCommandKeys.shipmentId,
        actorId: shipmentCommandKeys.actorId,
        command: shipmentCommandKeys.command,
        requestHash: shipmentCommandKeys.requestHash,
      })
      .from(shipmentCommandKeys)
      .where(eq(shipmentCommandKeys.idempotencyKey, idempotencyKey))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Records a key's use, with the shipment as the command left it.
   *
   * The outcome goes through {@link encodeShipment}, whose schema is proven
   * equal to `Shipment` at compile time, so the replay decodes the same typed
   * row: bigints as bigints, instants as Dates.
   */
  private async recordUse(
    tx: TenantTransaction,
    outcome: Shipment,
    spec: CommandSpec,
    actorId: string | null,
    requestHash: string,
  ): Promise<void> {
    await tx.insert(shipmentCommandKeys).values({
      tenantId: outcome.tenantId,
      idempotencyKey: spec.idempotencyKey,
      shipmentId: outcome.id,
      actorId,
      command: spec.command,
      requestHash,
      result: encodeShipment(outcome),
    });
  }

  /** The shipment exactly as the original command left it. */
  private async recordedOutcome(tx: TenantTransaction, idempotencyKey: string): Promise<Shipment> {
    const rows = await tx
      .select({ result: shipmentCommandKeys.result })
      .from(shipmentCommandKeys)
      .where(eq(shipmentCommandKeys.idempotencyKey, idempotencyKey))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new NotFoundError("Shipment");
    }
    const outcome = decodeShipment(row.result);
    this.replays.add(outcome);
    return outcome;
  }

  /**
   * Refuses a driver-only command from a login with no driver record, before
   * anything about the shipment is read (invariant I26).
   *
   * Up front, not only inside the transaction: under the driver read scope (I28)
   * an unlinked DRIVER sees no shipment at all, and answering 404 would tell
   * the client the parcel does not exist when the truth is that this login
   * may not act. The in-transaction checks still run, under the row lock.
   */
  private async requireLinkedDriver(ctx: CommandContext): Promise<void> {
    const driverId = await this.database.withTenant((tx) => this.callerDriverId(tx, ctx));
    if (driverId === null) {
      throw new ForbiddenError("This login is not linked to a driver.");
    }
  }

  /**
   * The driver recording a delivery outcome — the CALLER, and only while the
   * parcel is in their custody (invariant I26, docs/05-api-contracts.md §3).
   *
   * ⚠️ The driver used to come from the request body. Any holder of
   * `shipment:deliver` could then mark a colleague's parcel delivered and book
   * its COD to the colleague's DRIVER_CASH account, which makes the end-of-day
   * cash reconciliation meaningless.
   *
   * Custody, not route membership, is the test. `out_for_delivery` puts the
   * parcel in the route driver's custody, so for a normal day the two agree.
   * Where they differ (a parcel brought back to the hub and sent out with
   * someone else), custody is what physically happened.
   *
   * An ILLEGAL transition skips the custody test on purpose. A parcel that is
   * already DELIVERED has no custodian, and a late offline retry should get
   * SHIPMENT_INVALID_TRANSITION from the state machine, not a 403 telling the
   * app it was never this driver's parcel. That path cannot write anything: the
   * state machine throws inside the same transaction.
   */
  private async requireCustodian(
    tx: TenantTransaction,
    shipment: Shipment,
    outcome: ShipmentEventType,
    ctx: CommandContext,
  ): Promise<string> {
    const driverId = await this.callerDriverId(tx, ctx);
    if (driverId === null) {
      throw new ForbiddenError("Only a driver can record a delivery outcome.");
    }
    const transition = checkTransition(toShipmentStatus(shipment.status), outcome);
    if (transition.kind !== "rejected" && !heldBy(shipment, driverId)) {
      throw new ForbiddenError("This shipment is not in your custody.");
    }
    return driverId;
  }

  /**
   * Who handed a returned parcel back, or null when staff record it at a
   * counter (invariant I26).
   *
   * Looser than {@link requireCustodian} on purpose. A return can be closed
   * from the hub (RETURN_PENDING follows AT_HUB as well as a failed attempt),
   * so requiring driver custody would block the counter case. What is refused
   * is a driver closing a return that ANOTHER driver is carrying, and a driver
   * session with no driver record behind it: that session has no identity to
   * book the return to.
   */
  private async returningDriver(
    tx: TenantTransaction,
    shipment: Shipment,
    ctx: CommandContext,
  ): Promise<string | null> {
    const driverId = await this.callerDriverId(tx, ctx);
    if (driverId === null) {
      if (ctx.actor.actorType === "DRIVER") {
        throw new ForbiddenError("This login is not linked to a driver.");
      }
      return null;
    }
    const transition = checkTransition(toShipmentStatus(shipment.status), "returned");
    if (
      transition.kind !== "rejected" &&
      shipment.currentCustodyType === "DRIVER" &&
      !heldBy(shipment, driverId)
    ) {
      throw new ForbiddenError("This shipment is in another driver's custody.");
    }
    return driverId;
  }

  /**
   * The `drivers` row behind the authenticated user, or null if there is none.
   *
   * A user id and a driver id are different things (see
   * `ShiftService.openShiftForUser`). Read here with an RLS-scoped query rather
   * than by injecting the fleet module, the same way `InvoiceService.partiesFor`
   * reads merchants. Migration 0043 makes `(tenant_id, user_id)` unique, so
   * this matches at most one row.
   */
  private async callerDriverId(tx: TenantTransaction, ctx: CommandContext): Promise<string | null> {
    const userId = ctx.actor.actorId;
    if (userId === undefined) {
      return null;
    }
    const rows = await tx.execute<{ id: string }>(
      sql`select id from drivers where user_id = ${userId}`,
    );
    return rows[0]?.id ?? null;
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

  /**
   * The recorded outcome of an earlier create with this key, or null if the key
   * is unused (I29).
   *
   * A create names no shipment up front, so its binding is caller, command and
   * request. The recorded row is read from the key table, not from `shipments`,
   * so a replay returns the shipment as first created.
   */
  private async createReplay(
    spec: CommandSpec,
    ctx: CommandContext,
    requestHash: string,
  ): Promise<Shipment | null> {
    return this.database.withTenant(async (tx) => {
      const prior = await this.priorUse(tx, spec.idempotencyKey);
      if (prior === null) {
        return null;
      }
      // The shipment id is taken from the prior use itself: there is no other
      // to compare, so the binding reduces to caller, command and request.
      assertSameRequest(prior, spec, {
        shipmentId: prior.shipmentId,
        actorId: actorIdOf(ctx),
        requestHash,
      });
      return this.recordedOutcome(tx, spec.idempotencyKey);
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

/**
 * What an idempotency key must stay bound to (invariant I29).
 *
 * - `caller`: client-supplied keys on HTTP commands. A replay must be the same
 *   shipment, the same authenticated caller, the same command, and the same
 *   request (fingerprint), or it is IDEMPOTENCY_KEY_REUSED.
 * - `fact`: server-derived keys on internal orchestration (`assign:<stop>:<leg>`,
 *   `ofd:<route>:<leg>`, `pickup-scan:<event>`). The key already names one fact
 *   about one shipment, and the system retries it on purpose: any dispatcher
 *   may retry a half-published route, and an event may be redelivered. Binding
 *   those to caller or payload would turn a legitimate retry into a 422. Only
 *   shipment and command must match. None of these entry points is reachable
 *   over HTTP.
 */
type IdempotencyBinding = "caller" | "fact";

interface CommandSpec {
  readonly command: string;
  readonly idempotencyKey: string;
  /** The validated request; the key itself is excluded from the fingerprint. */
  readonly request: Readonly<Record<string, unknown>>;
  readonly binding: IdempotencyBinding;
}

interface PriorUse {
  readonly shipmentId: string;
  readonly actorId: string | null;
  readonly command: string;
  readonly requestHash: string;
}

const IDEMPOTENCY_CONSTRAINTS = [
  // Two commands racing to record the same key.
  "shipment_command_keys_pkey",
  // An event-level collision: a key already carried by an earlier event,
  // including events recorded before the key table existed (0046).
  "shipment_events_tenant_idempotency_uq",
] as const;

function keyReused(): BusinessRuleError {
  // Deliberately says nothing about the earlier use: not which shipment, not
  // whose, not what it did. docs/05-api-contracts.md §1.2.
  return new BusinessRuleError(
    "IDEMPOTENCY_KEY_REUSED",
    "This idempotency key was already used for a different request.",
  );
}

/** A replay is honoured only when it is the same request (I29). */
function assertSameRequest(
  prior: PriorUse,
  spec: CommandSpec,
  current: {
    readonly shipmentId: string;
    readonly actorId: string | null;
    readonly requestHash: string;
  },
): void {
  const sameFact = prior.shipmentId === current.shipmentId && prior.command === spec.command;
  const sameCaller = prior.actorId === current.actorId && prior.requestHash === current.requestHash;
  if (!sameFact || (spec.binding === "caller" && !sameCaller)) {
    throw keyReused();
  }
}

/** Whether `error` is a unique violation on an idempotency constraint: a reused key. */
function isKeyConflict(error: unknown): boolean {
  return IDEMPOTENCY_CONSTRAINTS.some((name) => isUniqueViolation(error, name));
}

function actorIdOf(ctx: CommandContext): string | null {
  return ctx.actor.actorId ?? null;
}

/** Whether `driverId` physically holds the parcel, according to the custody projection. */
function heldBy(shipment: Shipment, driverId: string): boolean {
  return shipment.currentCustodyType === "DRIVER" && shipment.currentCustodyId === driverId;
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
