import { Global, Module } from "@nestjs/common";
import postgres from "postgres";

import { AppConfigModule } from "../config/config.module.js";
import { AppConfigService } from "../config/index.js";
import { DatabaseService } from "./database.service.js";
import { POSTGRES_CLIENT } from "./database.tokens.js";

/**
 * Database module.
 *
 * Connects as the application role (no BYPASSRLS). `prepare: false` keeps the
 * client compatible with PgBouncer transaction pooling, which is required from
 * Tier 2 onward (docs/06-database-design.md §7) — enabling it now avoids a
 * surprising behaviour change at the moment we introduce the pooler.
 */
@Global()
@Module({
  imports: [AppConfigModule],
  providers: [
    {
      provide: POSTGRES_CLIENT,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        postgres(config.get("DATABASE_URL"), {
          max: config.get("DATABASE_POOL_MAX"),
          prepare: false,
          onnotice: () => undefined,
          connection: {
            application_name: config.get("OTEL_SERVICE_NAME"),
            // Milliseconds. A runaway query must never hold a pooled connection
            // hostage — the role-level default in 02-roles.sql is the backstop,
            // this makes the intent explicit per connection.
            statement_timeout: config.get("DATABASE_STATEMENT_TIMEOUT_MS"),
          },
        }),
    },
    DatabaseService,
  ],
  exports: [DatabaseService, POSTGRES_CLIENT],
})
export class DatabaseModule {}
