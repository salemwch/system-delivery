import { Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";

import { OutboxService } from "../../platform/index.js";
import type { TenantTransaction } from "../../../shared/database/index.js";
import { BusinessRuleError, ForbiddenError } from "../../../shared/errors/index.js";
import { shipmentEvents, shipments } from "../domain/schema.js";
import {
  checkTransition,
  custodyAfter,
  outboxEventName,
  targetStatusFor,
} from "../domain/shipment-status.js";
import type {
  CodStatus,
  EventActor,
  ShipmentEventType,
  ShipmentStatus,
} from "../domain/shipment-status.js";

/**
 * THE sanctioned writer of `shipments.status`.
 *
 * `shipments.status` is a PROJECTION of the immutable `shipment_events` log
 * (docs/02-domain-model.md §3.6 rule 1). This service is the ONLY place that
 * appends an event and advances the projection, and it does both in the caller's
 * transaction — so the event, the status, the custody holder, and the outbox row
 * commit together or not at all. Every business command routes through here.
 *
 * This file is deliberately excluded from the SAST rule
 * `no-direct-shipment-status-write` (see .semgrep.yml), exactly as
 * `database.service.ts` is excluded from the tenant-context rule: the rule exists
 * to catch status writes ANYWHERE ELSE. A direct `.set({ status })` in any other
 * file is a build-breaking error, which is the whole point.
 */

/** A geography point literal for INSERT — lng first, per PostGIS. */
function pointOf(coordinates: { lat: number; lng: number }) {
  return sql`ST_SetSRID(ST_MakePoint(${coordinates.lng}, ${coordinates.lat}), 4326)::geography`;
}

/** The minimal shipment state the writer needs; the command owns the full row. */
export interface ShipmentSnapshot {
  readonly id: string;
  readonly tenantId: string;
  readonly status: ShipmentStatus;
  readonly lastSequence: bigint;
}

export interface AppendEventParams {
  readonly eventType: ShipmentEventType;
  readonly actor: EventActor;
  readonly idempotencyKey: string;
  readonly occurredAt: Date;
  readonly location?: { lat: number; lng: number };
  readonly locationAccuracyM?: number;
  readonly hubId?: string;
  readonly driverId?: string;
  readonly routeId?: string;
  readonly legId?: string;
  readonly reasonCode?: string;
  readonly metadata?: Record<string, unknown>;
  /** OWNER authority for the ⚠️ in-custody transitions (cancellation). */
  readonly canOverride?: boolean;
  /** Event-specific fields merged into the published outbox payload. */
  readonly outboxPayload: Record<string, unknown>;
  /** Projection side-effects applied atomically with the status change. */
  readonly incrementAttempt?: boolean;
  readonly codStatus?: CodStatus;
}

export interface AppendResult {
  readonly status: ShipmentStatus;
  readonly sequence: bigint;
  readonly eventId: string;
}

@Injectable()
export class ShipmentEventService {
  constructor(private readonly outbox: OutboxService) {}

  /**
   * Appends one custody event to `current` and advances the projection, in `tx`.
   * The caller must already hold the shipment row lock (a `SELECT ... FOR UPDATE`
   * on this shipment in the same transaction), which is what serialises
   * concurrent events and guarantees the sequence is strictly monotonic.
   */
  async applyTo(
    tx: TenantTransaction,
    current: ShipmentSnapshot,
    params: AppendEventParams,
  ): Promise<AppendResult> {
    const newStatus = this.resolveTargetStatus(current, params);
    const sequence = current.lastSequence + 1n;

    await tx.insert(shipmentEvents).values({
      tenantId: current.tenantId,
      shipmentId: current.id,
      sequence,
      eventType: params.eventType,
      occurredAt: params.occurredAt,
      actorType: params.actor.actorType,
      idempotencyKey: params.idempotencyKey,
      metadata: params.metadata ?? {},
      ...(params.actor.actorId === undefined ? {} : { actorId: params.actor.actorId }),
      ...(params.location === undefined ? {} : { location: pointOf(params.location) }),
      ...(params.locationAccuracyM === undefined
        ? {}
        : { locationAccuracyM: params.locationAccuracyM }),
      ...(params.hubId === undefined ? {} : { hubId: params.hubId }),
      ...(params.driverId === undefined ? {} : { driverId: params.driverId }),
      ...(params.routeId === undefined ? {} : { routeId: params.routeId }),
      ...(params.legId === undefined ? {} : { legId: params.legId }),
      ...(params.reasonCode === undefined ? {} : { reasonCode: params.reasonCode }),
    });

    const custody = custodyAfter(params.eventType, {
      driverId: params.driverId ?? null,
      hubId: params.hubId ?? null,
    });

    // The projection. `status` is written HERE and only here, as a direct literal
    // key — so the SAST rule no-direct-shipment-status-write genuinely matches it,
    // and this file's path-exclusion is what legitimately permits it (the rule
    // catches the same write anywhere else). For an annotation event `newStatus`
    // equals the current status, so writing it is a harmless no-op. Sequence
    // advances on every event; custody, attempt count, and COD status advance only
    // when the event calls for it.
    await tx
      .update(shipments)
      .set({
        status: newStatus,
        lastSequence: sequence,
        updatedAt: sql`now()`,
        ...(custody === undefined
          ? {}
          : { currentCustodyType: custody.type, currentCustodyId: custody.id }),
        ...(params.incrementAttempt === true ? { attemptCount: sql`attempt_count + 1` } : {}),
        ...(params.codStatus === undefined ? {} : { codStatus: params.codStatus }),
      })
      .where(sql`${shipments.id} = ${current.id}`);

    const eventId = await this.outbox.publish(tx, {
      eventType: outboxEventName(params.eventType),
      aggregateType: "shipment",
      aggregateId: current.id,
      occurredAt: params.occurredAt,
      payload: params.outboxPayload,
    });

    return { status: newStatus, sequence, eventId };
  }

  /**
   * Validates the transition and returns the status the shipment should hold
   * after the event. Throws a typed domain error for an illegal transition or an
   * ungranted in-custody override — never silently applies it.
   */
  private resolveTargetStatus(
    current: ShipmentSnapshot,
    params: AppendEventParams,
  ): ShipmentStatus {
    if (params.eventType === "created") {
      if (current.lastSequence !== 0n) {
        throw new BusinessRuleError(
          "SHIPMENT_ALREADY_CREATED",
          "A created event can only be the first event of a shipment.",
        );
      }
      return current.status;
    }

    const check = checkTransition(current.status, params.eventType);
    if (check.kind === "rejected") {
      throw new BusinessRuleError(
        "SHIPMENT_INVALID_TRANSITION",
        `Cannot apply ${params.eventType}: ${check.reason}.`,
      );
    }
    if (check.kind === "requires_override" && params.canOverride !== true) {
      throw new ForbiddenError(
        `Applying ${params.eventType} while the shipment is ${current.status} requires OWNER authority.`,
      );
    }
    return targetStatusFor(params.eventType) ?? current.status;
  }
}
