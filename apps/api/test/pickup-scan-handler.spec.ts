import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AddressService } from "../src/modules/directory/application/address.service.js";
import { MerchantService } from "../src/modules/directory/application/merchant.service.js";
import { RecipientService } from "../src/modules/directory/application/recipient.service.js";
import { ManualGeocodingProvider } from "../src/modules/directory/infrastructure/manual-geocoding.provider.js";
import { AuditService } from "../src/modules/platform/application/audit.service.js";
import { OperatingConfigService } from "../src/modules/platform/application/operating-config.service.js";
import { OutboxService } from "../src/modules/platform/application/outbox.service.js";
import type { ConsumedEvent } from "../src/modules/platform/index.js";
import { PickupScanEventHandler } from "../src/modules/shipment/application/pickup-scan-event.handler.js";
import { ShipmentEventService } from "../src/modules/shipment/application/shipment-event.service.js";
import { ShipmentService } from "../src/modules/shipment/application/shipment.service.js";
import type { CommandContext } from "../src/modules/shipment/application/shipment.service.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { TenantContext, asTenantId } from "../src/shared/database/tenant-context.js";
import { BusinessRuleError } from "../src/shared/errors/index.js";
import {
  createTenant,
  createTestDatabase,
  deleteTenants,
  seedDriverLogin,
  withTenantContext,
} from "./database.harness.js";
import type { TestDatabase } from "./database.harness.js";

/**
 * `pickup.parcel_scanned` → shipment custody (migration 0044).
 *
 * ⚠️ The scan used to publish the scanner's USER id as `driverId`, and this
 * consumer wrote it straight into `shipment_events.driver_id` and the custody
 * projection. That is the user-id/driver-id confusion that once broke GPS ingest
 * end to end. The event now carries both ids, and these tests pin which one
 * lands where, including for a collector who is not a driver and for events
 * published before the split.
 */
describe("pickup scan → shipment custody", () => {
  let database: TestDatabase;
  let shipments: ShipmentService;
  let handler: PickupScanEventHandler;
  let createdTenants: string[] = [];

  const staff: CommandContext = { actor: { actorType: "DISPATCHER", actorId: randomUUID() } };

  async function asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return TenantContext.run({ tenantId: asTenantId(tenantId), actorType: "system" }, fn);
  }

  async function seedTenant(): Promise<string> {
    const id = await createTenant(database.migrator, "scan-handler");
    createdTenants.push(id);
    return id;
  }

  async function seedShipment(tenantId: string): Promise<string> {
    const created = await asTenant(tenantId, () =>
      shipments.create(
        {
          idempotencyKey: randomUUID(),
          senderName: "Boutique",
          senderPhone: "+21620000001",
          origin: { rawInput: "Tunis", countryCode: "TN", coordinates: { lat: 36.8, lng: 10.18 } },
          recipientName: "Ahmed Ben Ali",
          recipientPhone: "+21620000002",
          destination: {
            rawInput: "Sfax",
            countryCode: "TN",
            coordinates: { lat: 34.74, lng: 10.76 },
          },
          currency: "TND",
        },
        staff,
      ),
    );
    return created.id;
  }

  function scanned(tenantId: string, payload: Record<string, unknown>): ConsumedEvent {
    return {
      streamId: "1-0",
      seq: null,
      eventId: randomUUID(),
      tenantId,
      eventType: "pickup.parcel_scanned",
      eventVersion: 1,
      aggregateType: "pickup_request",
      aggregateId: randomUUID(),
      occurredAt: new Date(),
      correlationId: null,
      causationId: null,
      payload,
      deliveryCount: 1,
      traceparent: null,
      tracestate: null,
    };
  }

  /** The picked_up fact as the custody ledger stored it. */
  async function pickedUp(
    tenantId: string,
    shipmentId: string,
  ): Promise<{ driver_id: string | null; actor_type: string; actor_id: string | null }> {
    const rows = await withTenantContext(
      database.migrator,
      tenantId,
      (tx) => tx<{ driver_id: string | null; actor_type: string; actor_id: string | null }[]>`
        select driver_id, actor_type, actor_id from shipment_events
         where shipment_id = ${shipmentId} and event_type = 'picked_up'`,
    );
    const row = rows[0];
    if (row === undefined) {
      throw new Error("no picked_up event");
    }
    return row;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    const db = new DatabaseService(database.app);
    const outbox = new OutboxService();
    const addresses = new AddressService(db, outbox, new ManualGeocodingProvider());
    shipments = new ShipmentService(
      db,
      new ShipmentEventService(outbox),
      outbox,
      new MerchantService(db, outbox, new AuditService(db), addresses),
      new RecipientService(db),
      addresses,
      new OperatingConfigService(db),
    );
    handler = new PickupScanEventHandler(shipments);
  }, 240_000);

  afterEach(async () => {
    await deleteTenants(database.migrator, createdTenants);
    createdTenants = [];
  });

  afterAll(async () => {
    await database.close();
  });

  it("puts the parcel in the DRIVER's custody, by drivers.id, and records who scanned", async () => {
    const tenantId = await seedTenant();
    const shipmentId = await seedShipment(tenantId);
    const courier = await seedDriverLogin(database.migrator, tenantId);

    await handler.handle(
      scanned(tenantId, {
        pickupRequestId: randomUUID(),
        shipmentId,
        collectorUserId: courier.userId,
        driverId: courier.driverId,
        scannedAt: new Date().toISOString(),
      }),
    );

    const shipment = await asTenant(tenantId, () => shipments.getById(shipmentId));
    expect(shipment.status).toBe("PICKED_UP");
    expect(shipment.currentCustodyType).toBe("DRIVER");
    expect(shipment.currentCustodyId).toBe(courier.driverId);
    expect(await pickedUp(tenantId, shipmentId)).toEqual({
      driver_id: courier.driverId,
      actor_type: "DRIVER",
      actor_id: courier.userId,
    });
  });

  it("records a non-driver collector as staff, with no driver id anywhere", async () => {
    const tenantId = await seedTenant();
    const shipmentId = await seedShipment(tenantId);
    const commercial = randomUUID();

    await handler.handle(
      scanned(tenantId, {
        pickupRequestId: randomUUID(),
        shipmentId,
        collectorUserId: commercial,
        driverId: null,
      }),
    );

    const shipment = await asTenant(tenantId, () => shipments.getById(shipmentId));
    expect(shipment.status).toBe("PICKED_UP");
    // Their user id must not pose as a driver: the ledger and I26 key on drivers.id.
    expect(shipment.currentCustodyId).toBeNull();
    expect(await pickedUp(tenantId, shipmentId)).toEqual({
      driver_id: null,
      actor_type: "DISPATCHER",
      actor_id: commercial,
    });
  });

  it("reads an event published before the split without trusting its driverId", async () => {
    const tenantId = await seedTenant();
    const shipmentId = await seedShipment(tenantId);
    const scannerUserId = randomUUID();

    // The old shape: `driverId` held the scanner's USER id, no collectorUserId.
    await handler.handle(
      scanned(tenantId, { pickupRequestId: randomUUID(), shipmentId, driverId: scannerUserId }),
    );

    const event = await pickedUp(tenantId, shipmentId);
    expect(event.driver_id).toBeNull();
    expect(event.actor_id).toBe(scannerUserId);
  });

  it("refuses an event that names no collector, so it dead-letters for a human", async () => {
    const tenantId = await seedTenant();
    const shipmentId = await seedShipment(tenantId);

    await expect(
      handler.handle(scanned(tenantId, { pickupRequestId: randomUUID(), shipmentId })),
    ).rejects.toBeInstanceOf(BusinessRuleError);
  });

  it("keeps the HTTP pickup command strict: staff must name the driver", async () => {
    const tenantId = await seedTenant();
    const shipmentId = await seedShipment(tenantId);
    await asTenant(tenantId, () =>
      shipments.recordEvent(
        shipmentId,
        { eventType: "assigned", idempotencyKey: randomUUID() },
        staff,
      ),
    );

    await expect(
      asTenant(tenantId, () =>
        shipments.recordPickup(shipmentId, { idempotencyKey: randomUUID() }, staff),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});
