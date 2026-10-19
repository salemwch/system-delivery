import { createHash, randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { AddressService } from "../src/modules/directory/application/address.service.js";
import { MerchantService } from "../src/modules/directory/application/merchant.service.js";
import { RecipientService } from "../src/modules/directory/application/recipient.service.js";
import { ManualGeocodingProvider } from "../src/modules/directory/infrastructure/manual-geocoding.provider.js";
import { AuditService } from "../src/modules/platform/application/audit.service.js";
import { OperatingConfigService } from "../src/modules/platform/application/operating-config.service.js";
import { OutboxService } from "../src/modules/platform/application/outbox.service.js";
import { PodMediaService } from "../src/modules/shipment/application/pod-media.service.js";
import { ShipmentEventService } from "../src/modules/shipment/application/shipment-event.service.js";
import { ShipmentService } from "../src/modules/shipment/application/shipment.service.js";
import type { CommandContext } from "../src/modules/shipment/application/shipment.service.js";
import { DatabaseService } from "../src/shared/database/database.service.js";
import { TenantContext, asTenantId } from "../src/shared/database/tenant-context.js";
import { BusinessRuleError, NotFoundError, ValidationError } from "../src/shared/errors/index.js";
import type { MalwareScanner } from "../src/shared/storage/index.js";
import { PassThroughMalwareScanner, S3ObjectStorage } from "../src/shared/storage/index.js";
import {
  createTenant,
  createTestDatabase,
  deleteTenants,
  seedDriverLogin,
  withTenantContext,
} from "./database.harness.js";
import type { DriverLogin, TestDatabase } from "./database.harness.js";
import { jpegFixture, pngFixture } from "./media.fixtures.js";
import { createTestStorage } from "./storage.harness.js";
import type { TestStorage } from "./storage.harness.js";

/**
 * POD media end to end on a real database and a real S3 store (migration
 * 0052; docs/05 §8; docs/07 §7.1): presign → PUT straight to storage →
 * complete → verified, or refused for what the bytes really are.
 */
describe("POD media", () => {
  let database: TestDatabase;
  let store: TestStorage | undefined;
  let storage: S3ObjectStorage;
  let shipments: ShipmentService;
  let media: PodMediaService;
  let created: string[] = [];

  const staff: CommandContext = { actor: { actorType: "DISPATCHER", actorId: randomUUID() } };

  async function seedTenant(): Promise<string> {
    const id = await createTenant(database.migrator, `pod-${randomUUID().slice(0, 6)}`);
    created.push(id);
    return id;
  }

  function asSystem<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return TenantContext.run({ tenantId: asTenantId(tenantId), actorType: "system" }, fn);
  }

  function asDriver<T>(tenantId: string, login: DriverLogin, fn: () => Promise<T>): Promise<T> {
    return TenantContext.run(
      {
        tenantId: asTenantId(tenantId),
        actorType: "driver",
        actorId: login.userId,
        driverId: login.driverId,
      },
      fn,
    );
  }

  /** A parcel created, assigned, picked up and out for delivery with `driverId`. */
  async function parcel(tenantId: string, driverId: string, out = true): Promise<string> {
    return asSystem(tenantId, async () => {
      const shipment = await shipments.create(
        {
          idempotencyKey: randomUUID(),
          senderName: "Boutique",
          senderPhone: "+21620000001",
          origin: { rawInput: "Tunis", countryCode: "TN", coordinates: { lat: 36.8, lng: 10.18 } },
          recipientName: "Recipient",
          recipientPhone: `+2162${String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0")}`,
          destination: {
            rawInput: "Sfax",
            countryCode: "TN",
            coordinates: { lat: 34.74, lng: 10.76 },
          },
          currency: "TND",
        },
        staff,
      );
      if (out) {
        await shipments.recordEvent(
          shipment.id,
          { eventType: "assigned", idempotencyKey: randomUUID(), driverId },
          staff,
        );
        await shipments.recordPickup(
          shipment.id,
          { idempotencyKey: randomUUID(), driverId },
          staff,
        );
        await shipments.recordEvent(
          shipment.id,
          { eventType: "out_for_delivery", idempotencyKey: randomUUID(), driverId },
          staff,
        );
      }
      return shipment.id;
    });
  }

  function slot(
    shipmentId: string,
    bytes: Uint8Array,
    overrides: Partial<{ purpose: string; contentType: string; sizeBytes: number }> = {},
  ) {
    return {
      idempotencyKey: randomUUID(),
      purpose: "POD_PHOTO",
      shipmentId,
      contentType: "image/jpeg",
      sizeBytes: bytes.byteLength,
      ...overrides,
    };
  }

  /** The phone's PUT: the signed headers, the length from the body. */
  async function upload(
    outcome: { upload: { url: string; headers: Readonly<Record<string, string>> } | null },
    bytes: Uint8Array,
  ): Promise<number> {
    if (outcome.upload === null) throw new Error("no upload URL");
    const { "content-length": _length, ...headers } = outcome.upload.headers;
    const response = await fetch(outcome.upload.url, { method: "PUT", headers, body: bytes });
    await response.body?.cancel();
    return response.status;
  }

  beforeAll(async () => {
    database = await createTestDatabase();
    const createdStore = await createTestStorage();
    store = createdStore;
    storage = new S3ObjectStorage(createdStore.settings);
    const db = new DatabaseService(database.app);
    const outbox = new OutboxService();
    const addresses = new AddressService(db, new ManualGeocodingProvider());
    shipments = new ShipmentService(
      db,
      new ShipmentEventService(outbox),
      outbox,
      new MerchantService(db, outbox, new AuditService(db), addresses),
      new RecipientService(db),
      addresses,
      new OperatingConfigService(db),
      new AuditService(db),
    );
    media = new PodMediaService(db, storage, new PassThroughMalwareScanner());
  }, 240_000);

  afterEach(async () => {
    await deleteTenants(database.migrator, created);
    created = [];
  });

  afterAll(async () => {
    await store?.close();
    await database.close();
  });

  it("issues a slot, takes the upload, verifies it and serves it from storage", async () => {
    const t = await seedTenant();
    const driver = await seedDriverLogin(database.migrator, t);
    const shipmentId = await parcel(t, driver.driverId);
    const bytes = jpegFixture();

    const issued = await asDriver(t, driver, () => media.presign(slot(shipmentId, bytes)));
    expect(issued.replayed).toBe(false);
    expect(issued.artifact).toMatchObject({ status: "PENDING_UPLOAD", sizeBytes: bytes.length });
    expect(issued.artifact.objectKey).toMatch(
      new RegExp(`^tenant/${t}/pod/${shipmentId}/${issued.artifact.id}\\.jpg$`, "u"),
    );
    expect(await upload(issued, bytes)).toBe(200);

    const done = await asDriver(t, driver, () => media.complete(issued.artifact.id));
    expect(done).toMatchObject({
      status: "AVAILABLE",
      rejectionReason: null,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    const rows = await withTenantContext(
      database.migrator,
      t,
      (tx) => tx<{ scanned_by: string; driver_id: string }[]>`
        select scanned_by, driver_id from pod_artifacts where id = ${issued.artifact.id}`,
    );
    // The pass-through scanner is identifiable, for the day a real one rescans.
    expect(rows[0]).toEqual({ scanned_by: "none", driver_id: driver.driverId });

    const { viewUrl } = await asSystem(t, () => media.view(issued.artifact.id));
    expect(viewUrl).not.toBeNull();
    const served = await fetch(viewUrl ?? "");
    expect(Buffer.from(await served.arrayBuffer())).toEqual(Buffer.from(bytes));

    // Idempotent: a second complete reports the decision, changes nothing.
    expect(await asDriver(t, driver, () => media.complete(issued.artifact.id))).toEqual(done);
  });

  it("waits for an upload that has not arrived, without deciding anything", async () => {
    const t = await seedTenant();
    const driver = await seedDriverLogin(database.migrator, t);
    const bytes = pngFixture();
    const issued = await asDriver(t, driver, async () =>
      media.presign(
        slot(await parcel(t, driver.driverId), bytes, {
          purpose: "POD_SIGNATURE",
          contentType: "image/png",
        }),
      ),
    );

    await expect(
      asDriver(t, driver, () => media.complete(issued.artifact.id)),
    ).rejects.toMatchObject({ code: "MEDIA_NOT_UPLOADED" });
    expect((await asSystem(t, () => media.view(issued.artifact.id))).artifact.status).toBe(
      "PENDING_UPLOAD",
    );
    expect(await upload(issued, bytes)).toBe(200);
    expect((await asDriver(t, driver, () => media.complete(issued.artifact.id))).status).toBe(
      "AVAILABLE",
    );
  });

  it("rejects a photo still carrying EXIF, and a file that is not its declared type", async () => {
    const t = await seedTenant();
    const driver = await seedDriverLogin(database.migrator, t);
    const shipmentId = await parcel(t, driver.driverId);

    const exif = jpegFixture({ exif: true });
    const withExif = await asDriver(t, driver, () => media.presign(slot(shipmentId, exif)));
    expect(await upload(withExif, exif)).toBe(200);
    expect(await asDriver(t, driver, () => media.complete(withExif.artifact.id))).toMatchObject({
      status: "REJECTED",
      rejectionReason: "EXIF_PRESENT",
      sha256: null,
    });
    expect((await asSystem(t, () => media.view(withExif.artifact.id))).viewUrl).toBeNull();

    // Declared PNG, uploaded JPEG bytes of the same size: the store accepts the
    // PUT (type and length are headers), the server reads what it really is.
    const jpeg = jpegFixture();
    const lying = await asDriver(t, driver, () =>
      media.presign(slot(shipmentId, jpeg, { contentType: "image/png" })),
    );
    expect(await upload(lying, jpeg)).toBe(200);
    expect(await asDriver(t, driver, () => media.complete(lying.artifact.id))).toMatchObject({
      status: "REJECTED",
      rejectionReason: "TYPE_MISMATCH",
    });
  });

  it("rejects a file the scanner flags", async () => {
    const t = await seedTenant();
    const driver = await seedDriverLogin(database.migrator, t);
    const flagging: MalwareScanner = {
      scan: () => Promise.resolve({ clean: false, engine: "test-engine" }),
    };
    const strict = new PodMediaService(new DatabaseService(database.app), storage, flagging);
    const bytes = jpegFixture();
    const issued = await asDriver(t, driver, async () =>
      strict.presign(slot(await parcel(t, driver.driverId), bytes)),
    );
    expect(await upload(issued, bytes)).toBe(200);
    expect(await asDriver(t, driver, () => strict.complete(issued.artifact.id))).toMatchObject({
      status: "REJECTED",
      rejectionReason: "MALWARE",
    });
  });

  it("keeps a driver to the parcels they hold, and to parcels out for delivery", async () => {
    const t = await seedTenant();
    const a = await seedDriverLogin(database.migrator, t);
    const b = await seedDriverLogin(database.migrator, t);
    const theirs = await parcel(t, b.driverId);
    const bytes = jpegFixture();

    await expect(asDriver(t, a, () => media.presign(slot(theirs, bytes)))).rejects.toBeInstanceOf(
      NotFoundError,
    );
    const issued = await asDriver(t, b, () => media.presign(slot(theirs, bytes)));
    await expect(asDriver(t, a, () => media.complete(issued.artifact.id))).rejects.toBeInstanceOf(
      NotFoundError,
    );

    // Created but never sent out: there is no doorstep yet.
    const fresh = await parcel(t, a.driverId, false);
    await expect(asSystem(t, () => media.presign(slot(fresh, bytes)))).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    const ownerish = await seedDriverLogin(database.migrator, t);
    await expect(
      TenantContext.run(
        { tenantId: asTenantId(t), actorType: "user", actorId: ownerish.userId },
        () => media.presign(slot(fresh, bytes)),
      ),
    ).rejects.toMatchObject({ code: "MEDIA_NOT_ACCEPTED" });

    // Another tenant cannot reach the slot at all.
    const away = await seedTenant();
    const stranger = await seedDriverLogin(database.migrator, away);
    await expect(
      asDriver(away, stranger, () => media.view(issued.artifact.id)),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("caps slots per parcel, and a rejected one frees its place", async () => {
    const t = await seedTenant();
    const driver = await seedDriverLogin(database.migrator, t);
    const shipmentId = await parcel(t, driver.driverId);
    const exif = pngFixture({ exif: true });
    const signature = { purpose: "POD_SIGNATURE", contentType: "image/png" };

    const first = await asDriver(t, driver, () => media.presign(slot(shipmentId, exif, signature)));
    await expect(
      asDriver(t, driver, () => media.presign(slot(shipmentId, exif, signature))),
    ).rejects.toMatchObject({ code: "MEDIA_LIMIT_REACHED" });

    expect(await upload(first, exif)).toBe(200);
    expect((await asDriver(t, driver, () => media.complete(first.artifact.id))).status).toBe(
      "REJECTED",
    );
    const again = await asDriver(t, driver, () =>
      media.presign(slot(shipmentId, pngFixture(), signature)),
    );
    expect(again.artifact.status).toBe("PENDING_UPLOAD");
  });

  it("replays a retried presign as the same slot with a fresh URL, and refuses a reused key", async () => {
    const t = await seedTenant();
    const driver = await seedDriverLogin(database.migrator, t);
    const shipmentId = await parcel(t, driver.driverId);
    const bytes = jpegFixture();
    const request = slot(shipmentId, bytes);

    const [one, two] = await Promise.all([
      asDriver(t, driver, () => media.presign(request)),
      asDriver(t, driver, () => media.presign(request)),
    ]);
    expect(one.artifact.id).toBe(two.artifact.id);
    expect([one.replayed, two.replayed].sort()).toEqual([false, true]);
    expect(await upload(two, bytes)).toBe(200);

    await expect(
      asDriver(t, driver, () => media.presign({ ...request, sizeBytes: bytes.length + 1 })),
    ).rejects.toBeInstanceOf(BusinessRuleError);
    await expect(
      asDriver(t, driver, () => media.presign({ ...request, sizeBytes: 11 * 1024 * 1024 })),
    ).rejects.toBeInstanceOf(ValidationError);

    // Once verified, a replay reports the slot and offers no URL to overwrite it.
    await asDriver(t, driver, () => media.complete(one.artifact.id));
    const late = await asDriver(t, driver, () => media.presign(request));
    expect(late).toMatchObject({ replayed: true, upload: null, artifact: { status: "AVAILABLE" } });
  });

  it("keeps the slot immutable and its lifecycle forward-only in the database", async () => {
    const t = await seedTenant();
    const driver = await seedDriverLogin(database.migrator, t);
    const shipmentId = await parcel(t, driver.driverId);
    const bytes = jpegFixture();
    const issued = await asDriver(t, driver, () => media.presign(slot(shipmentId, bytes)));
    expect(await upload(issued, bytes)).toBe(200);
    await asDriver(t, driver, () => media.complete(issued.artifact.id));
    const id = issued.artifact.id;
    const asApp = (fn: Parameters<typeof withTenantContext>[2]) =>
      withTenantContext(database.app, t, fn);

    await expect(
      asApp((tx) => tx`update pod_artifacts set object_key = 'elsewhere' where id = ${id}`),
    ).rejects.toThrow(/permission denied/iu);
    await expect(asApp((tx) => tx`delete from pod_artifacts where id = ${id}`)).rejects.toThrow(
      /permission denied/iu,
    );
    await expect(
      asApp(
        (tx) => tx`update pod_artifacts set status = 'PENDING_UPLOAD', sha256 = null,
                    verified_at = null where id = ${id}`,
      ),
    ).rejects.toThrow(/cannot move/iu);
    // A key outside this tenant's and this parcel's prefix is refused outright.
    await expect(
      asApp(
        (tx) => tx`insert into pod_artifacts (id, tenant_id, shipment_id, uploaded_by_user_id,
                     purpose, object_key, content_type, size_bytes, idempotency_key, request_hash)
                   values (uuidv7(), ${t}, ${shipmentId}, ${driver.userId}, 'POD_PHOTO',
                     ${`tenant/${randomUUID()}/pod/${shipmentId}/x.jpg`}, 'image/jpeg', 10,
                     ${randomUUID()}, ${"0".repeat(64)})`,
      ),
    ).rejects.toThrow(/object_key_chk/iu);
  });

  it("refuses a malformed request at the boundary", async () => {
    const t = await seedTenant();
    const driver = await seedDriverLogin(database.migrator, t);
    const shipmentId = await parcel(t, driver.driverId);
    for (const body of [
      { ...slot(shipmentId, jpegFixture()), contentType: "image/gif" },
      { ...slot(shipmentId, jpegFixture()), purpose: "SELFIE" },
      { ...slot(shipmentId, jpegFixture()), sizeBytes: 0 },
      { ...slot(shipmentId, jpegFixture()), objectKey: "tenant/x/evil.jpg" },
    ]) {
      await expect(asDriver(t, driver, () => media.presign(body))).rejects.toBeInstanceOf(
        ValidationError,
      );
    }
    await expect(asDriver(t, driver, () => media.complete(randomUUID()))).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
  describe("the delivery cites only issued media", () => {
    function deliver(t: string, login: DriverLogin, shipmentId: string, pod: object) {
      return asDriver(t, login, () =>
        shipments.confirmDelivery(
          shipmentId,
          { idempotencyKey: randomUUID(), pod },
          { actor: { actorType: "DRIVER", actorId: login.userId } },
        ),
      );
    }

    it("accepts the parcel's own slots, even before their upload finishes", async () => {
      const t = await seedTenant();
      const driver = await seedDriverLogin(database.migrator, t);
      const shipmentId = await parcel(t, driver.driverId);
      const signature = await asDriver(t, driver, () =>
        media.presign(
          slot(shipmentId, pngFixture(), { purpose: "POD_SIGNATURE", contentType: "image/png" }),
        ),
      );
      const photo = await asDriver(t, driver, () => media.presign(slot(shipmentId, jpegFixture())));

      const delivered = await deliver(t, driver, shipmentId, {
        podType: "signature",
        recipientName: "R",
        signatureObjectKey: signature.artifact.objectKey,
        photoObjectKeys: [photo.artifact.objectKey],
      });
      expect(delivered.status).toBe("DELIVERED");

      // Offline order: the delivery synced first; the photo uploads afterwards.
      expect(await upload(photo, jpegFixture())).toBe(200);
      expect((await asDriver(t, driver, () => media.complete(photo.artifact.id))).status).toBe(
        "AVAILABLE",
      );
      // A new slot after delivery could never be cited, so none is issued.
      await expect(
        asDriver(t, driver, () => media.presign(slot(shipmentId, jpegFixture()))),
      ).rejects.toMatchObject({ code: "MEDIA_NOT_ACCEPTED" });
    });

    it("refuses an invented key, another parcel's, the wrong purpose, or a rejected file", async () => {
      const t = await seedTenant();
      const driver = await seedDriverLogin(database.migrator, t);
      const shipmentId = await parcel(t, driver.driverId);
      const elsewhere = await parcel(t, driver.driverId);
      const foreign = await asDriver(t, driver, () =>
        media.presign(slot(elsewhere, jpegFixture())),
      );
      const own = await asDriver(t, driver, () => media.presign(slot(shipmentId, jpegFixture())));
      const exif = jpegFixture({ exif: true });
      const rejected = await asDriver(t, driver, () => media.presign(slot(shipmentId, exif)));
      expect(await upload(rejected, exif)).toBe(200);
      await asDriver(t, driver, () => media.complete(rejected.artifact.id));

      const unknown = { code: "POD_MEDIA_UNKNOWN" };
      for (const pod of [
        { podType: "photo", recipientName: "R", photoObjectKeys: ["pods/anything.jpg"] },
        { podType: "photo", recipientName: "R", photoObjectKeys: [foreign.artifact.objectKey] },
        { podType: "signature", recipientName: "R", signatureObjectKey: own.artifact.objectKey },
        { podType: "photo", recipientName: "R", photoObjectKeys: [rejected.artifact.objectKey] },
        {
          podType: "photo",
          recipientName: "R",
          photoObjectKeys: [own.artifact.objectKey, own.artifact.objectKey],
        },
      ]) {
        await expect(deliver(t, driver, shipmentId, pod)).rejects.toMatchObject(unknown);
      }
      // Nothing was delivered by any of them.
      expect((await asSystem(t, () => shipments.getById(shipmentId))).status).toBe(
        "OUT_FOR_DELIVERY",
      );
    });
  });
});
