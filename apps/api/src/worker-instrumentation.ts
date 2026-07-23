// Side-effecting bootstrap for core-worker. Imported as the FIRST statement of
// worker.ts, for the same reason as instrumentation.ts: the instrumentations
// must patch ioredis (and any http client) before the worker graph requires
// them. Separate file so the service name differs from the API's.
import { startTelemetry } from "./shared/observability/telemetry.js";

startTelemetry("core-worker");
