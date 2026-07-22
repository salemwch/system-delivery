import path from "node:path";
import process from "node:process";

import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// Node 24 loads .env natively — no dotenv dependency needed. Missing file is
// fine: CI supplies TEST_DATABASE_URL directly, and the harness falls back to
// Testcontainers when neither is present.
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, "../../.env"));
} catch {
  // No local .env — expected in CI.
}

export default defineConfig({
  test: {
    globals: true,
    root: "./",
    environment: "node",
    include: ["src/**/*.spec.ts", "test/**/*.spec.ts"],
    // Integration tests share one PostgreSQL instance and create their own
    // isolated tenants. Running files sequentially keeps failures readable and
    // avoids masking a real isolation bug behind a race.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
  // SWC handles the decorator metadata NestJS relies on; esbuild (Vitest's
  // default) does not emit it.
  plugins: [swc.vite({ module: { type: "es6" } })],
});
