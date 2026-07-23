import { Global, Inject, Module } from "@nestjs/common";
import type { OnApplicationShutdown } from "@nestjs/common";
import { Redis } from "ioredis";
import { PinoLogger } from "nestjs-pino";

import { AppConfigModule } from "../config/config.module.js";
import { AppConfigService } from "../config/index.js";
import { VALKEY_CLIENT } from "./valkey.tokens.js";

/**
 * Valkey client module.
 *
 * Valkey speaks the Redis protocol, so a Redis client connects to it unchanged.
 * ioredis is the single Redis-protocol client the platform standardises on
 * (docs CLAUDE.md one-tool-per-job): it serves the outbox relay's streams now
 * and the feature cache and BullMQ queues later, so there is never a second
 * client to reason about.
 *
 * Global, because Valkey is cross-cutting infrastructure like the database.
 */
@Global()
@Module({
  imports: [AppConfigModule],
  providers: [
    {
      provide: VALKEY_CLIENT,
      inject: [AppConfigService, PinoLogger],
      useFactory: (config: AppConfigService, logger: PinoLogger): Redis => {
        const client = new Redis(config.get("VALKEY_URL"), {
          // Bounds every command. The outbox relay holds a Postgres transaction
          // across its publish, so a hung Valkey call must fail rather than pin
          // row locks indefinitely.
          commandTimeout: config.get("VALKEY_COMMAND_TIMEOUT_MS"),
          maxRetriesPerRequest: 3,
        });
        // An ioredis client is an EventEmitter: an unhandled 'error' event would
        // crash the process. Surface reconnect/transport errors as structured
        // logs instead — never swallow them.
        client.on("error", (error: Error) => {
          logger.error({ err: error, component: "valkey" }, "Valkey client error");
        });
        return client;
      },
    },
  ],
  exports: [VALKEY_CLIENT],
})
export class ValkeyModule implements OnApplicationShutdown {
  constructor(@Inject(VALKEY_CLIENT) private readonly client: Redis) {}

  /** Closes the connection cleanly so in-flight commands drain on shutdown. */
  async onApplicationShutdown(): Promise<void> {
    await this.client.quit();
  }
}
