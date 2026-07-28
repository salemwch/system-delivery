import { Inject, Module } from "@nestjs/common";
import type { OnApplicationShutdown } from "@nestjs/common";
import { drizzle } from "drizzle-orm/postgres-js";
import { Redis } from "ioredis";
import { LoggerModule, PinoLogger } from "nestjs-pino";
import postgres from "postgres";
import type { Sql } from "postgres";

import { FinanceModule, LedgerEventHandler } from "./modules/finance/index.js";
import { NotificationEventHandler, NotificationModule } from "./modules/notification/index.js";
import {
  EVENT_PUBLISHER,
  EventStreamConsumer,
  OutboxRelayService,
  PlatformModule,
  RELAY_DATABASE,
  RELAY_LOGGER,
  ValkeyStreamEventPublisher,
} from "./modules/platform/index.js";
import type { ConsumerLogger, RelayLogger } from "./modules/platform/index.js";
import { PickupScanEventHandler, ShipmentModule } from "./modules/shipment/index.js";
import { AppConfigModule } from "./shared/config/config.module.js";
import { AppConfigService } from "./shared/config/index.js";
import { DatabaseModule } from "./shared/database/database.module.js";
import { DatabaseService } from "./shared/database/database.service.js";
import type { Database } from "./shared/database/index.js";
import { ValkeyModule } from "./shared/valkey/valkey.module.js";

/**
 * The `dp_relay` connection (docs/03-event-storming.md §2.3).
 *
 * A dedicated, low-concurrency pool: the relay is one loop, not a request fleet.
 * `prepare: false` keeps it PgBouncer-compatible like the app pool.
 */
const RELAY_POSTGRES_CLIENT = Symbol("RELAY_POSTGRES_CLIENT");

/**
 * Each stream consumer gets its OWN Valkey connection.
 *
 * An `XREADGROUP ... BLOCK` holds its connection for the whole wait, so sharing
 * one connection across the relay and every consumer would serialise them all
 * behind a single 5-second block. These connections also deliberately carry NO
 * tight `commandTimeout` — unlike the shared `VALKEY_CLIENT`, whose timeout exists
 * to stop the relay pinning Postgres row locks — because a blocking read is
 * SUPPOSED to wait up to `EVENT_CONSUMER_BLOCK_MS`; a 5s command timeout on a 5s
 * block would abort every idle poll. `maxRetriesPerRequest: null` is ioredis's
 * blocking-safe setting.
 */
const NOTIFICATION_STREAM_CLIENT = Symbol("NOTIFICATION_STREAM_CLIENT");
const LEDGER_STREAM_CLIENT = Symbol("LEDGER_STREAM_CLIENT");
const PICKUP_SCAN_STREAM_CLIENT = Symbol("PICKUP_SCAN_STREAM_CLIENT");
const NOTIFICATION_CONSUMER = Symbol("NOTIFICATION_CONSUMER");
const LEDGER_CONSUMER = Symbol("LEDGER_CONSUMER");
const PICKUP_SCAN_CONSUMER = Symbol("PICKUP_SCAN_CONSUMER");

/** A Valkey connection tuned for blocking stream reads (see the symbols above). */
function makeStreamClient(config: AppConfigService, logger: PinoLogger, component: string): Redis {
  const client = new Redis(config.get("VALKEY_URL"), { maxRetriesPerRequest: null });
  // An ioredis client is an EventEmitter; an unhandled 'error' would crash the
  // process. Surface transport/reconnect errors as structured logs.
  client.on("error", (error: Error) => {
    logger.error({ err: error, component }, "Valkey stream client error");
  });
  return client;
}

/** Adapts the app's Pino logger to a consumer/relay's narrow logger port. */
function taggedLogger(logger: PinoLogger, component: string): ConsumerLogger {
  return {
    info: (obj, msg) => {
      logger.info({ ...obj, component }, msg);
    },
    warn: (obj, msg) => {
      logger.warn({ ...obj, component }, msg);
    },
    error: (obj, msg) => {
      logger.error({ ...obj, component }, msg);
    },
  };
}

/**
 * The core-worker composition root (docs/01-mvp-scope.md §2 — same image,
 * queue-consumer entrypoint).
 *
 * Runs the background plane: the outbox relay (dp_relay) drains Postgres → Valkey,
 * and one {@link EventStreamConsumer} per consumer group drains Valkey → handlers.
 * Consumers write tenant-scoped tables as dp_app (via the global DatabaseModule),
 * setting tenant context per event, so RLS holds on the async path too.
 *
 * At MVP three consumer groups run here: `notification` (customer SMS), `ledger`
 * (the double-entry COD postings), and `pickup-scan` (a scanned parcel becomes
 * driver custody on the shipment). Each is an independent group with its own
 * Valkey position and its own connection, so a slow or failing consumer never
 * blocks the others — or the relay.
 */
@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    ValkeyModule,
    PlatformModule,
    NotificationModule,
    FinanceModule,
    ShipmentModule,
    LoggerModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        pinoHttp: {
          level: config.get("LOG_LEVEL"),
          ...(config.isProduction
            ? {}
            : {
                transport: {
                  target: "pino-pretty",
                  options: { singleLine: true, translateTime: "HH:MM:ss.l" },
                },
              }),
          customProps: () => ({ service: "core-worker" }),
        },
      }),
    }),
  ],
  providers: [
    {
      provide: RELAY_POSTGRES_CLIENT,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService): Sql =>
        postgres(config.get("RELAY_DATABASE_URL"), {
          max: 4,
          prepare: false,
          onnotice: () => undefined,
          connection: {
            application_name: "core-worker-relay",
            statement_timeout: config.get("DATABASE_STATEMENT_TIMEOUT_MS"),
          },
        }),
    },
    {
      provide: RELAY_DATABASE,
      inject: [RELAY_POSTGRES_CLIENT],
      useFactory: (client: Sql): Database => drizzle(client),
    },
    {
      provide: EVENT_PUBLISHER,
      useClass: ValkeyStreamEventPublisher,
    },
    {
      provide: RELAY_LOGGER,
      inject: [PinoLogger],
      useFactory: (logger: PinoLogger): RelayLogger => taggedLogger(logger, "outbox-relay"),
    },
    OutboxRelayService,

    // ── Event-stream consumers ────────────────────────────────────────────────
    // One dedicated blocking connection + one EventStreamConsumer per group.
    {
      provide: NOTIFICATION_STREAM_CLIENT,
      inject: [AppConfigService, PinoLogger],
      useFactory: (config: AppConfigService, logger: PinoLogger): Redis =>
        makeStreamClient(config, logger, "notification-consumer"),
    },
    {
      provide: LEDGER_STREAM_CLIENT,
      inject: [AppConfigService, PinoLogger],
      useFactory: (config: AppConfigService, logger: PinoLogger): Redis =>
        makeStreamClient(config, logger, "ledger-consumer"),
    },
    {
      provide: PICKUP_SCAN_STREAM_CLIENT,
      inject: [AppConfigService, PinoLogger],
      useFactory: (config: AppConfigService, logger: PinoLogger): Redis =>
        makeStreamClient(config, logger, "pickup-scan-consumer"),
    },
    {
      // The notification consumer: shipment events → customer SMS.
      provide: NOTIFICATION_CONSUMER,
      inject: [
        NOTIFICATION_STREAM_CLIENT,
        DatabaseService,
        NotificationEventHandler,
        AppConfigService,
        PinoLogger,
      ],
      useFactory: (
        valkey: Redis,
        database: DatabaseService,
        handler: NotificationEventHandler,
        config: AppConfigService,
        logger: PinoLogger,
      ): EventStreamConsumer =>
        new EventStreamConsumer(
          valkey,
          database,
          handler,
          taggedLogger(logger, "event-consumer:notification"),
          config,
        ),
    },
    {
      // The ledger consumer: cod.collected → double-entry postings (finance).
      provide: LEDGER_CONSUMER,
      inject: [
        LEDGER_STREAM_CLIENT,
        DatabaseService,
        LedgerEventHandler,
        AppConfigService,
        PinoLogger,
      ],
      useFactory: (
        valkey: Redis,
        database: DatabaseService,
        handler: LedgerEventHandler,
        config: AppConfigService,
        logger: PinoLogger,
      ): EventStreamConsumer =>
        new EventStreamConsumer(
          valkey,
          database,
          handler,
          taggedLogger(logger, "event-consumer:ledger"),
          config,
        ),
    },
    {
      // The pickup-scan consumer: a scanned parcel → driver custody on the shipment.
      provide: PICKUP_SCAN_CONSUMER,
      inject: [
        PICKUP_SCAN_STREAM_CLIENT,
        DatabaseService,
        PickupScanEventHandler,
        AppConfigService,
        PinoLogger,
      ],
      useFactory: (
        valkey: Redis,
        database: DatabaseService,
        handler: PickupScanEventHandler,
        config: AppConfigService,
        logger: PinoLogger,
      ): EventStreamConsumer =>
        new EventStreamConsumer(
          valkey,
          database,
          handler,
          taggedLogger(logger, "event-consumer:pickup-scan"),
          config,
        ),
    },
  ],
})
export class WorkerModule implements OnApplicationShutdown {
  constructor(
    @Inject(RELAY_POSTGRES_CLIENT) private readonly relayClient: Sql,
    @Inject(NOTIFICATION_STREAM_CLIENT) private readonly notificationStream: Redis,
    @Inject(LEDGER_STREAM_CLIENT) private readonly ledgerStream: Redis,
    @Inject(PICKUP_SCAN_STREAM_CLIENT) private readonly pickupScanStream: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    // Consumers have already stopped their loops (onModuleDestroy) by now, so the
    // connections are idle. Close the relay pool and every consumer connection.
    await this.relayClient.end({ timeout: 5 });
    await this.notificationStream.quit();
    await this.ledgerStream.quit();
    await this.pickupScanStream.quit();
  }
}
