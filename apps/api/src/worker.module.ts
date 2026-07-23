import { Inject, Module } from "@nestjs/common";
import type { OnApplicationShutdown } from "@nestjs/common";
import { drizzle } from "drizzle-orm/postgres-js";
import { LoggerModule, PinoLogger } from "nestjs-pino";
import postgres from "postgres";
import type { Sql } from "postgres";

import {
  EVENT_PUBLISHER,
  OutboxRelayService,
  RELAY_DATABASE,
  RELAY_LOGGER,
  ValkeyStreamEventPublisher,
} from "./modules/platform/index.js";
import type { RelayLogger } from "./modules/platform/index.js";
import { AppConfigModule } from "./shared/config/config.module.js";
import { AppConfigService } from "./shared/config/index.js";
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
 * The core-worker composition root (docs/01-mvp-scope.md §2 — same image,
 * queue-consumer entrypoint).
 *
 * Deliberately NOT the API's `DatabaseModule`: the worker connects only as
 * `dp_relay`, never as the request-path `dp_app` role. As more background work
 * lands (notifications, retention, reconciliation) it is registered here.
 */
@Module({
  imports: [
    AppConfigModule,
    ValkeyModule,
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
      // Adapts the app's Pino logger to the relay's narrow logger port, tagging
      // every line with the component so relay logs are trivially filterable.
      provide: RELAY_LOGGER,
      inject: [PinoLogger],
      useFactory: (logger: PinoLogger): RelayLogger => ({
        info: (obj, msg) => {
          logger.info({ ...obj, component: "outbox-relay" }, msg);
        },
        warn: (obj, msg) => {
          logger.warn({ ...obj, component: "outbox-relay" }, msg);
        },
        error: (obj, msg) => {
          logger.error({ ...obj, component: "outbox-relay" }, msg);
        },
      }),
    },
    OutboxRelayService,
  ],
})
export class WorkerModule implements OnApplicationShutdown {
  constructor(@Inject(RELAY_POSTGRES_CLIENT) private readonly relayClient: Sql) {}

  async onApplicationShutdown(): Promise<void> {
    await this.relayClient.end({ timeout: 5 });
  }
}
