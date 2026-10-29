import { randomBytes, randomUUID } from "node:crypto";
import process from "node:process";

import { ConfigService as NestConfigService } from "@nestjs/config";
import { sql } from "drizzle-orm";
import postgres from "postgres";

import { AddressService } from "../modules/directory/application/address.service.js";
import { MerchantService } from "../modules/directory/application/merchant.service.js";
import { RecipientService } from "../modules/directory/application/recipient.service.js";
import { ManualGeocodingProvider } from "../modules/directory/infrastructure/manual-geocoding.provider.js";
import { HeuristicOptimizationProvider } from "../modules/dispatch/application/optimization.provider.js";
import { RouteService } from "../modules/dispatch/application/route.service.js";
import { DriverService } from "../modules/fleet/application/driver.service.js";
import { VehicleService } from "../modules/fleet/application/vehicle.service.js";
import { PasswordService } from "../modules/identity/application/password.service.js";
import { UserService } from "../modules/identity/application/user.service.js";
import { HubService } from "../modules/network/application/hub.service.js";
import { AuditService } from "../modules/platform/application/audit.service.js";
import { FeatureService } from "../modules/platform/application/feature.service.js";
import { OperatingConfigService } from "../modules/platform/application/operating-config.service.js";
import { OutboxService } from "../modules/platform/application/outbox.service.js";
import { TenantService } from "../modules/platform/application/tenant.service.js";
import { ShipmentEventService } from "../modules/shipment/application/shipment-event.service.js";
import { ShipmentService } from "../modules/shipment/application/shipment.service.js";
import type { CommandContext } from "../modules/shipment/application/shipment.service.js";
import { AppConfigService } from "../shared/config/config.service.js";
import { configSchema } from "../shared/config/config.schema.js";
import type { AppConfig } from "../shared/config/config.schema.js";
import { FieldCipher } from "../shared/crypto/field-cipher.js";
import { DatabaseService } from "../shared/database/database.service.js";
import { TenantContext } from "../shared/database/tenant-context.js";

/**
 * DEVELOPMENT ONLY: a test day for the driver app on a real phone.
 *
 * The web admin cannot create drivers, vehicles or routes yet, so this sets up
 * what the driver app needs to start a shift and track: a driver login with a
 * phone number (sign-in by SMS code), its driver record, a van, three COD
 * parcels around Tunis, and today's route published to that driver on that van.
 *
 * Every write goes through the real services as the application role
 * (`DATABASE_URL`, RLS applies), so the fixture is exactly what the API would
 * have produced. Refuses to run with NODE_ENV=production.
 *
 *   pnpm db:seed                                   # once: the tenant
 *   pnpm --filter @delivery/api dev:field-day      # each test day
 *
 * Env: SEED_TENANT_SLUG (default fast-delivery), DEV_DRIVER_PHONE (default
 * +21620000099). Sign in on the phone with that slug and number; with
 * DEV_LOG_SMS_BODIES=true the code appears in the API log.
 */
async function main(): Promise<void> {
  const config = new AppConfigService(
    new NestConfigService<AppConfig, true>(configSchema.parse(process.env)),
  );
  if (config.isProduction) {
    throw new Error("dev:field-day refuses to run with NODE_ENV=production");
  }
  const slug = process.env["SEED_TENANT_SLUG"] ?? "fast-delivery";
  const phone = process.env["DEV_DRIVER_PHONE"] ?? "+21620000099";
  if (!/^\+[1-9]\d{6,14}$/u.test(phone)) {
    throw new Error(`DEV_DRIVER_PHONE must be E.164, got "${phone}"`);
  }

  const client = postgres(config.get("DATABASE_URL"), {
    max: 2,
    prepare: false,
    onnotice: () => undefined,
  });
  try {
    const db = new DatabaseService(client);
    const outbox = new OutboxService();
    const audit = new AuditService(db);
    const operatingConfig = new OperatingConfigService(db);
    const tenants = new TenantService(db, outbox, operatingConfig, audit);
    const addresses = new AddressService(db, new ManualGeocodingProvider());
    const hubs = new HubService(db, outbox, addresses);
    const cipher = new FieldCipher(Buffer.from(config.get("FIELD_ENCRYPTION_KEY"), "base64"));
    const users = new UserService(db, new PasswordService(), outbox, audit);
    const drivers = new DriverService(db, outbox, hubs, cipher);
    const vehicles = new VehicleService(db, outbox, hubs);
    const shipments = new ShipmentService(
      db,
      new ShipmentEventService(outbox),
      outbox,
      new MerchantService(db, outbox, audit, addresses),
      new RecipientService(db),
      addresses,
      operatingConfig,
      audit,
    );
    const routes = new RouteService(
      db,
      outbox,
      new FeatureService(db, audit),
      new HeuristicOptimizationProvider(),
      shipments,
      vehicles,
      drivers,
      hubs,
      addresses,
    );

    let tenantId;
    try {
      tenantId = await tenants.resolveBySlug(slug);
    } catch {
      throw new Error(`No tenant "${slug}". Run \`pnpm db:seed\` first.`);
    }
    const staff: CommandContext = { actor: { actorType: "DISPATCHER", actorId: randomUUID() } };

    await TenantContext.run({ tenantId, actorType: "system" }, async () => {
      // 1. The driver login (sign-in finds a DRIVER account by users.phone),
      //    reused on later runs.
      const existing = await db.withTenant((tx) =>
        tx.execute<{ user_id: string; driver_id: string | null }>(sql`
          select u.id as user_id, d.id as driver_id
            from users u
            join user_roles r on r.user_id = u.id and r.role = 'DRIVER'
            left join drivers d on d.user_id = u.id
           where u.phone = ${phone}
           limit 1`),
      );
      let userId = existing[0]?.user_id ?? null;
      let driverId = existing[0]?.driver_id ?? null;
      if (userId === null) {
        const digits = phone.replace(/\D/gu, "");
        const created = await users.create({
          email: `driver.${digits}@dev.local`,
          fullName: "Chauffeur Test",
          phone,
          roles: ["DRIVER"],
        });
        userId = created.user.id;
      }
      // 2. Its driver record, active.
      if (driverId === null) {
        const driver = await drivers.create({
          employeeCode: `DEV-${phone.slice(-4)}`,
          fullName: "Chauffeur Test",
          phone,
          employmentType: "EMPLOYEE",
          userId,
        });
        driverId = driver.id;
      }
      await drivers.activate(driverId);

      // 2b. Cancel any non-terminal routes for this driver (previous runs).
      const openRoutes = await db.withTenant((tx) =>
        tx.execute<{ id: string; status: string }>(sql`
          select id, status from routes
           where driver_id = ${driverId}
             and status not in ('COMPLETED', 'CANCELLED')
           order by created_at desc`),
      );
      for (const old of openRoutes) {
        await routes.cancel(old.id, { reason: "dev:field-day cleanup" });
      }

      // 3. A van for today.
      const vehicle = await vehicles.create({
        plateNumber: `DEV ${randomBytes(2).toString("hex").toUpperCase()} TU`,
        type: "VAN",
        capacityParcels: 60,
        capacityWeightGrams: 500_000,
      });

      // 4. Three COD parcels around Tunis (12.500 TND each: TND has 3 decimals).
      const stops = [
        { rawInput: "Avenue Habib Bourguiba, Tunis", lat: 36.7999, lng: 10.1866 },
        { rawInput: "Rue de Marseille, Tunis", lat: 36.8008, lng: 10.1797 },
        { rawInput: "Les Berges du Lac, Tunis", lat: 36.8335, lng: 10.2333 },
      ];
      const legIds: string[] = [];
      const shipmentIds: string[] = [];
      for (const [index, stop] of stops.entries()) {
        const shipment = await shipments.create(
          {
            idempotencyKey: randomUUID(),
            senderName: "Boutique Test",
            senderPhone: "+21620000001",
            origin: {
              rawInput: "Hub Charguia, Tunis",
              countryCode: "TN",
              coordinates: { lat: 36.842, lng: 10.205 },
            },
            recipientName: `Client Test ${String(index + 1)}`,
            recipientPhone: `+2162000010${String(index + 1)}`,
            destination: {
              rawInput: stop.rawInput,
              city: "Tunis",
              countryCode: "TN",
              coordinates: { lat: stop.lat, lng: stop.lng },
            },
            currency: "TND",
            codAmountMinor: 12_500n,
          },
          staff,
        );
        const legs = await db.withTenant((tx) =>
          tx.execute<{ id: string }>(
            sql`select id from shipment_legs where shipment_id = ${shipment.id} order by leg_number limit 1`,
          ),
        );
        const legId = legs[0]?.id;
        if (legId === undefined) throw new Error(`Shipment ${shipment.id} has no leg`);
        legIds.push(legId);
        shipmentIds.push(shipment.id);
      }

      // 5. Today's route (Tunis date), published to the driver on the van.
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Tunis" }).format(
        new Date(),
      );
      const route = await routes.create({ plannedDate: today, driverId, vehicleId: vehicle.id });
      await routes.addStops(route.id, { legIds });
      await routes.publish(route.id, { actor: staff.actor });
      // Loaded at the hub: the parcels are in the driver's custody, so starting
      // the route from the app takes them out for delivery (state machine).
      for (const shipmentId of shipmentIds) {
        await shipments.recordPickup(shipmentId, { idempotencyKey: randomUUID(), driverId }, staff);
      }

      process.stdout.write(
        [
          "",
          "  Test day ready.",
          `    courier code   ${slug}`,
          `    driver phone   ${phone}`,
          `    route          ${route.id} (${today}, ${String(legIds.length)} stops)`,
          `    vehicle        ${vehicle.plateNumber}`,
          "",
          "  On the phone: courier code + phone → Send code. With DEV_LOG_SMS_BODIES=true",
          '  the code is in the API log ("DEV ONLY (DEV_LOG_SMS_BODIES)").',
          "",
        ].join("\n"),
      );
    });
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
