// MUST be first: starts OpenTelemetry before any instrumented module loads.
import "./instrumentation.js";
import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import { FastifyAdapter } from "@nestjs/platform-fastify";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Logger } from "nestjs-pino";

import { AppModule } from "./app.module.js";
import { AppConfigService } from "./shared/config/index.js";
import { ProblemDetailsFilter } from "./shared/http/index.js";

/**
 * Process entry point.
 *
 * Configuration is validated inside AppModule construction, so an invalid
 * environment fails here — before the server binds a port and before any
 * request can be accepted.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      // Reject oversized payloads at the transport layer rather than after
      // parsing (docs/07-security-architecture.md §7).
      bodyLimit: 1_048_576,
      trustProxy: true,
    }),
    { bufferLogs: true },
  );

  app.useLogger(app.get(Logger));

  const config = app.get(AppConfigService);
  const logger = app.get(Logger);

  // Every error leaves as RFC 9457 Problem Details with a stable code.
  app.useGlobalFilters(new ProblemDetailsFilter());

  app.enableCors({
    origin: config.get("CORS_ALLOWED_ORIGINS"),
    credentials: true,
  });

  // Fail closed on unknown routes rather than leaking framework defaults.
  app.enableShutdownHooks();

  const port = config.get("PORT");
  await app.listen({ port, host: "0.0.0.0" });

  logger.log(
    {
      port,
      nodeEnv: config.nodeEnv,
      deploymentMode: config.deploymentMode,
    },
    "core-api started",
  );
}

bootstrap().catch((error: unknown) => {
  // The logger may not exist yet if configuration failed, so this is the one
  // place a direct stderr write is correct.
  process.stderr.write(
    `Fatal: core-api failed to start\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
