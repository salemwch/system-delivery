// Side-effecting bootstrap for core-api. Imported as the FIRST statement of
// main.ts so the OpenTelemetry instrumentations patch http/fastify/ioredis
// before those modules are required by the Nest graph. Kept in its own file with
// no other imports precisely so nothing instrumentable loads ahead of it.
import { startTelemetry } from "./shared/observability/telemetry.js";

startTelemetry("core-api");
