import { defineConfig } from "vitest/config";

/**
 * Tests for this app's PURE logic — money parsing and formatting above all.
 *
 * No jsdom: the components are thin wrappers around server actions, and a DOM
 * harness would test React rather than anything written here. The behaviour that
 * matters is verified end to end against the real API.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.spec.ts"],
    environment: "node",
  },
});
