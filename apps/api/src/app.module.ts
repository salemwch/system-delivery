import { Module } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";

import { DirectoryModule } from "./modules/directory/index.js";
import { IdentityModule } from "./modules/identity/index.js";
import { PlatformModule } from "./modules/platform/index.js";
import { AppConfigModule } from "./shared/config/config.module.js";
import { AppConfigService } from "./shared/config/index.js";
import { DatabaseModule } from "./shared/database/database.module.js";

/**
 * Application root.
 *
 * Domain modules are registered here as they are built, in the layer order
 * defined in docs/04-context-map.md. Boundary enforcement lives in ESLint
 * (`pnpm lint:rules`), not in this file.
 */
@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    PlatformModule,
    IdentityModule,
    DirectoryModule,
    LoggerModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        pinoHttp: {
          level: config.get("LOG_LEVEL"),
          // Human-readable logs locally; structured JSON everywhere else, because
          // production logs are parsed by machines, not read by people.
          //
          // Spread conditionally rather than assigning `undefined`: under
          // `exactOptionalPropertyTypes` an explicit `undefined` is not the same
          // as an absent property, and pino's types reject it.
          ...(config.isProduction
            ? {}
            : {
                transport: {
                  target: "pino-pretty",
                  options: { singleLine: true, translateTime: "HH:MM:ss.l" },
                },
              }),
          // Correlation id for every request. Asynchronous event fan-out is
          // undebuggable without it (docs/09-infrastructure.md §7).
          genReqId: (req, res) => {
            const existing = req.headers["x-request-id"];
            const id =
              typeof existing === "string" && existing.length > 0 ? existing : crypto.randomUUID();
            res.setHeader("x-request-id", id);
            return id;
          },
          // PII must never reach the logs (docs/07-security-architecture.md §6.3).
          redact: {
            paths: [
              "req.headers.authorization",
              "req.headers.cookie",
              "req.headers['x-api-key']",
              "req.body.password",
              "req.body.token",
              "req.body.recipientPhone",
              "req.body.contactPhone",
              "req.body.phone",
              "res.headers['set-cookie']",
            ],
            censor: "[redacted]",
          },
          customProps: () => ({ service: config.get("OTEL_SERVICE_NAME") }),
        },
      }),
    }),
  ],
})
export class AppModule {}
