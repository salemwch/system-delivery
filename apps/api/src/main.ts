// MUST be first: starts OpenTelemetry before any instrumented module loads.
import "./instrumentation.js";
import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { Logger } from "nestjs-pino";

import { AppModule } from "./app.module.js";
import { RealtimeGateway, registerRealtime } from "./modules/tracking/index.js";
import { AppConfigService } from "./shared/config/index.js";
import { ProblemDetailsFilter, createFastifyAdapter } from "./shared/http/index.js";

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
    createFastifyAdapter(),
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

  // The dispatcher realtime channel, upgraded on the server already listening
  // rather than a second one beside it (docs/05-api-contracts.md §10).
  await registerRealtime(app.getHttpAdapter().getInstance(), app.get(RealtimeGateway));

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
