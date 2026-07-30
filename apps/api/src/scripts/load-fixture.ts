import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

import { ConfigService as NestConfigService } from "@nestjs/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { AppConfigService } from "../shared/config/config.service.js";
import { configSchema } from "../shared/config/config.schema.js";
import type { AppConfig } from "../shared/config/config.schema.js";
import { DatabaseService } from "../shared/database/database.service.js";
import { TenantContext, asTenantId } from "../shared/database/tenant-context.js";
import { OperatingConfigService } from "../modules/platform/application/operating-config.service.js";
import { OutboxService } from "../modules/platform/application/outbox.service.js";
import { TenantService } from "../modules/platform/application/tenant.service.js";
import { TokenService } from "../modules/identity/application/token.service.js";
import { permissionsForRoles } from "../modules/identity/domain/permissions.js";

/**
 * Builds the fixture the k6 load suite runs against.
 *
 * ⚠️ REAL tokens for REAL drivers with REAL open shifts. A load test that skips
 * authentication measures a system nobody runs: `TokenService.authenticate` and
 * `ShiftService.isWithinOpenShift` are on the hot path of every telemetry batch,
 * and the shift check is a database read per request. Faking either would produce
 * a number that looks good and predicts nothing.
 *
 * Writes `load/fixture.json`, which the k6 scripts read. Never committed — it
 * holds bearer tokens.
 *
 * Runs on MIGRATION_DATABASE_URL: it inserts a tenant, which is a control-plane
 * operation the request-path `dp_app` role cannot perform.
 *
 *   pnpm --filter @delivery/api load:fixture
 */

/** docs/01 §4.3: 200 drivers is the MVP fleet the ~40 events/sec figure assumes. */
const DRIVER_COUNT = Number(process.env["LOAD_DRIVERS"] ?? 200);

/**
 * How many legs to seed. A 60-second run at 5 concurrent dispatchers plans a
 * few hundred routes; the pool has to outlast it or the scenario starts
 * measuring "no legs left" instead of sequencing.
 */
const LEG_POOL = Number(process.env["LOAD_LEG_POOL"] ?? 2_000);

/** Greater Tunis, so coordinates land on real roads when OSRM is enabled. */
const TUNIS = { lat: 36.8065, lng: 10.1815 };

interface Fixture {
  readonly tenantId: string;
  readonly baseUrl: string;
  /** One entry per driver: the bearer token and the open shift to report against. */
  readonly drivers: readonly { readonly token: string; readonly shiftId: string }[];
  /** A dispatcher token, for the route-optimisation and realtime scenarios. */
  readonly dispatcherToken: string;
  /**
   * Deliverable leg ids the dispatch scenario plans onto routes.
   *
   * ⚠️ Each is consumed by the first route that plans it, so a run draws from
   * this pool rather than reusing one set — planning an already-planned leg
   * measures the rejection path, not the sequencer.
   */
  readonly legIds: readonly string[];
}

async function main(): Promise<void> {
  // The same Zod schema the application boots with, so this script cannot run
  // against configuration the API would have refused. `NestConfigService` is
  // constructed directly rather than through a Nest context: this is a CLI, and
  // standing up the DI container to read a JWT secret would also start the
  // outbox relay and the telemetry writer.
  const config = new AppConfigService(
    new NestConfigService<AppConfig, true>(configSchema.parse(process.env)),
  );
  const migrationUrl = config.get("MIGRATION_DATABASE_URL");

  const sql = postgres(migrationUrl, { max: 4, onnotice: () => undefined });
  const db = drizzle(sql);

  try {
    const outbox = new OutboxService();
    const database = new DatabaseService(sql as never);
    const operatingConfig = new OperatingConfigService(database);
    const tenants = new TenantService(database, outbox, operatingConfig);
    const tokens = new TokenService(config);

    const slug = `load-${Date.now().toString(36)}`;
    const tenantId = await db.transaction(async (tx) =>
      tenants.provision(tx, {
        name: "Load Test Courier",
        slug,
        countryCode: "TN",
        defaultCurrency: "TND",
        defaultTimezone: "Africa/Tunis",
      }),
    );

    process.stdout.write(`tenant ${tenantId} (${slug})\n`);
    process.stdout.write(`seeding ${String(DRIVER_COUNT)} drivers with open shifts…\n`);

    const drivers: { token: string; shiftId: string }[] = [];

    await TenantContext.run({ tenantId: asTenantId(tenantId), actorType: "system" }, async () => {
      for (let i = 0; i < DRIVER_COUNT; i += 1) {
        const userId = randomUUID();
        const driverId = randomUUID();
        const vehicleId = randomUUID();
        const shiftId = randomUUID();

        // Inserted directly rather than through the services: this is fixture
        // setup, not a behaviour under test, and 200 drivers through the full
        // command path would take minutes to no benefit.
        await sql.begin(async (tx) => {
          await tx`select set_config('app.current_tenant_id', ${tenantId}, true)`;
          await tx`
            insert into users (id, tenant_id, email, full_name, password_hash, status)
            values (${userId}, ${tenantId}, ${`driver-${String(i)}@${slug}.test`},
                    ${`Load Driver ${String(i)}`}, 'x', 'ACTIVE')
          `;
          await tx`insert into user_roles (tenant_id, user_id, role) values (${tenantId}, ${userId}, 'DRIVER')`;
          await tx`
            insert into vehicles (id, tenant_id, plate_number, type, status,
                                  capacity_weight_grams, capacity_volume_cm3, capacity_parcels)
            values (${vehicleId}, ${tenantId}, ${`LOAD-${String(i)}`}, 'VAN', 'ACTIVE',
                    500000, 4000000, 60)
          `;
          await tx`
            insert into drivers (id, tenant_id, user_id, employee_code, full_name, phone,
                                 employment_type, status)
            values (${driverId}, ${tenantId}, ${userId}, ${`LD-${String(i)}`},
                    ${`Load Driver ${String(i)}`}, ${`+2162${String(1000000 + i)}`},
                    'EMPLOYEE', 'ACTIVE')
          `;
          // ⚠️ An OPEN shift. Telemetry outside one is rejected server-side
          // (the privacy gate, context-map §3.5), so without this every single
          // request in the load test would 422 and measure the rejection path.
          await tx`
            insert into shifts (id, tenant_id, driver_id, vehicle_id, status, started_at)
            values (${shiftId}, ${tenantId}, ${driverId}, ${vehicleId}, 'OPEN', now())
          `;
        });

        // The driver's own id is the principal's userId — telemetry attributes
        // positions to the authenticated user, never to a body field.
        const { token } = await tokens.issueAccessToken({
          userId,
          tenantId: asTenantId(tenantId),
          actorType: "driver",
          roles: ["DRIVER"],
          permissions: permissionsForRoles(["DRIVER"]),
          hubScope: [],
          merchantId: null,
          sessionId: randomUUID(),
        });
        drivers.push({ token, shiftId });
      }
    });

    const dispatcherUserId = randomUUID();
    await sql.begin(async (tx) => {
      await tx`select set_config('app.current_tenant_id', ${tenantId}, true)`;
      await tx`
        insert into users (id, tenant_id, email, full_name, password_hash, status)
        values (${dispatcherUserId}, ${tenantId}, ${`dispatcher@${slug}.test`},
                'Load Dispatcher', 'x', 'ACTIVE')
      `;
      await tx`insert into user_roles (tenant_id, user_id, role) values (${tenantId}, ${dispatcherUserId}, 'DISPATCHER')`;
    });

    const dispatcher = await TenantContext.run(
      { tenantId: asTenantId(tenantId), actorType: "system" },
      async () =>
        tokens.issueAccessToken({
          userId: dispatcherUserId,
          tenantId: asTenantId(tenantId),
          actorType: "user",
          roles: ["DISPATCHER"],
          permissions: permissionsForRoles(["DISPATCHER"]),
          hubScope: [],
          merchantId: null,
          sessionId: randomUUID(),
        }),
    );

    // ── Deliverable legs for the dispatch scenario ───────────────────────────
    //
    // `POST /v1/routes/:id/stops` takes LEG IDs, not coordinates — dispatch plans
    // real work, and a stop with no leg behind it is not a thing the API accepts.
    // So the fixture seeds shipments with a LAST_MILE leg each, scattered over
    // ~10 km of Greater Tunis.
    //
    // Deterministic geometry, so two runs sequence the same problem and their
    // timings are comparable. A fresh pool per run because the optimiser
    // consumes legs: re-running against already-planned legs would measure the
    // rejection path.
    process.stdout.write(`seeding ${String(LEG_POOL)} deliverable legs…\n`);
    const legIds: string[] = [];

    await sql.begin(async (tx) => {
      await tx`select set_config('app.current_tenant_id', ${tenantId}, true)`;
      for (let i = 0; i < LEG_POOL; i += 1) {
        const lat = TUNIS.lat + (((i * 37) % 100) - 50) / 1000;
        const lng = TUNIS.lng + (((i * 61) % 100) - 50) / 1000;

        const [origin] = await tx<{ id: string }[]>`
          insert into addresses (tenant_id, raw_input, country_code, location,
                                 geocode_confidence, geocode_source)
          values (${tenantId}, ${`Depot ${String(i)}, Tunis`}, 'TN',
                  ST_SetSRID(ST_MakePoint(${TUNIS.lng}, ${TUNIS.lat}), 4326)::geography,
                  1, 'manual')
          returning id
        `;
        const [destination] = await tx<{ id: string }[]>`
          insert into addresses (tenant_id, raw_input, country_code, location,
                                 geocode_confidence, geocode_source)
          values (${tenantId}, ${`Stop ${String(i)}, Tunis`}, 'TN',
                  ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography,
                  1, 'manual')
          returning id
        `;
        if (origin === undefined || destination === undefined) {
          throw new Error("address insert returned no row");
        }

        const [shipment] = await tx<{ id: string }[]>`
          insert into shipments (tenant_id, tracking_number, status, service_level,
                                 sender_name, sender_phone, origin_address_id,
                                 recipient_name, recipient_phone, destination_address_id,
                                 currency, cod_amount_minor, cod_status)
          values (${tenantId}, ${`LOAD${String(i).padStart(7, "0")}`}, 'CREATED', 'STANDARD',
                  'Load Merchant', '+21620000001', ${origin.id},
                  ${`Recipient ${String(i)}`}, ${`+2162${String(2000000 + i)}`}, ${destination.id},
                  'TND', 0, 'NOT_APPLICABLE')
          returning id
        `;
        if (shipment === undefined) {
          throw new Error("shipment insert returned no row");
        }

        const [leg] = await tx<{ id: string }[]>`
          insert into shipment_legs (tenant_id, shipment_id, leg_number, leg_type, status,
                                     from_type, to_type, from_address_id, to_address_id)
          values (${tenantId}, ${shipment.id}, 1, 'LAST_MILE', 'PLANNED',
                  'ADDRESS', 'ADDRESS', ${origin.id}, ${destination.id})
          returning id
        `;
        if (leg === undefined) {
          throw new Error("leg insert returned no row");
        }
        legIds.push(leg.id);
      }
    });

    const fixture: Fixture = {
      tenantId,
      baseUrl: config.get("API_BASE_URL"),
      drivers,
      dispatcherToken: dispatcher.token,
      legIds,
    };

    // Resolved from the working directory rather than `import.meta.url`: the
    // build targets CommonJS, where that meta-property is unavailable.
    const out = resolve(process.cwd(), "../../load/fixture.json");
    writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
    process.stdout.write(`wrote load/fixture.json (${String(drivers.length)} drivers)\n`);
    process.stdout.write(`clean up with: pnpm --filter @delivery/api load:cleanup\n`);
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
