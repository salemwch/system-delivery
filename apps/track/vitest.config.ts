import { defineConfig } from "vitest/config";

/**
 * Tests for this app's PURE logic only — money formatting, dates, locale
 * fallbacks. No jsdom and no component rendering: every component here is a
 * server component with no state, no effects and no interactivity, so a DOM
 * harness would test React rather than anything we wrote.
 *
 * What the components do is verified end to end against the real API instead,
 * which is the only test that could have caught the two contract gaps this app
 * exposed.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.spec.ts"],
    environment: "node",
  },
});
