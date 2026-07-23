// MUST be first: starts OpenTelemetry before any instrumented module loads.
import "./worker-instrumentation.js";
import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";

import { WorkerModule } from "./worker.module.js";

/**
 * core-worker entry point (docs/01-mvp-scope.md §2).
 *
 * A headless application context — no HTTP server. The outbox relay starts from
 * its `onApplicationBootstrap` hook and runs until a shutdown signal, at which
 * point `enableShutdownHooks` drives the graceful stop: the relay finishes its
 * in-flight pass, then the Valkey and Postgres connections close.
 *
 * Configuration is validated during module construction, so a bad environment
 * fails here before any work begins.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });

  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();

  app.get(Logger).log("core-worker started");
}

bootstrap().catch((error: unknown) => {
  // The logger may not exist yet if configuration failed, so this is the one
  // place a direct stderr write is correct.
  process.stderr.write(
    `Fatal: core-worker failed to start\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
