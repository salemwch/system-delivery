import { describe, expect, it } from "vitest";

import { ConsoleNotificationProvider } from "../src/modules/platform/infrastructure/console-notification.provider.js";
import { devSmsLogAllowed } from "../src/shared/config/config.schema.js";

/**
 * DEV_LOG_SMS_BODIES: the development "SMS inbox" that lets a driver sign in
 * with no SMS provider. It must show the code in development and be impossible
 * to switch on in production.
 */
describe("DEV_LOG_SMS_BODIES", () => {
  function provider(enabled: boolean) {
    const lines: { level: string; fields: Record<string, unknown> }[] = [];
    const logger = {
      info: (fields: Record<string, unknown>) => lines.push({ level: "info", fields }),
      warn: (fields: Record<string, unknown>) => lines.push({ level: "warn", fields }),
    };
    const config = {
      get: (key: string) =>
        key === "DEV_LOG_SMS_BODIES" ? enabled : key === "SMS_SENDER_ID" ? "" : undefined,
    };
    // Structural stand-ins for the logger and config the provider reads.
    return { lines, sms: new ConsoleNotificationProvider(logger as never, config as never) };
  }

  it("never logs the recipient or the body by default", async () => {
    const { lines, sms } = provider(false);
    await sms.send({ to: "+21620000099", channel: "SMS", body: "Code: 123456" });
    expect(JSON.stringify(lines)).not.toContain("123456");
    expect(JSON.stringify(lines)).not.toContain("+21620000099");
  });

  it("logs the content, clearly marked, when a developer turns it on", async () => {
    const { lines, sms } = provider(true);
    await sms.send({ to: "+21620000099", channel: "SMS", body: "Code: 123456" });
    expect(lines.find((line) => line.level === "warn")?.fields).toMatchObject({
      to: "+21620000099",
      body: "Code: 123456",
    });
  });

  it("is refused in production, allowed elsewhere", () => {
    expect(devSmsLogAllowed("production", true)).toBe(false);
    expect(devSmsLogAllowed("production", false)).toBe(true);
    expect(devSmsLogAllowed("development", true)).toBe(true);
    expect(devSmsLogAllowed("test", true)).toBe(true);
  });
});
