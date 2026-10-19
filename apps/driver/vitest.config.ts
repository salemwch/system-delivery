import { defineConfig } from "vitest/config";

/**
 * Unit tests for the app's platform-free core (src/core): sampling policy,
 * telemetry batching and retry, session refresh, ids, i18n. That code imports
 * nothing from React Native, so it runs on Node with no native mocks, and the
 * rules the field test depends on are proven before any device is involved.
 * (docs/08 §11: Vitest for unit tests; Detox for the end-to-end flows.)
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.spec.ts"],
  },
});
