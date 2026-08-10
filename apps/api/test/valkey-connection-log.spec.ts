import { describe, expect, it } from "vitest";

import { ConnectionErrorLog } from "../src/shared/valkey/connection-log.js";
import type { ConnectionLogSink } from "../src/shared/valkey/connection-log.js";

interface Recorded {
  readonly level: "error" | "info";
  readonly context: Record<string, unknown>;
  readonly message: string;
}

/**
 * A logger that keeps what it was told.
 *
 * No cast anywhere: `ConnectionLogSink` is exactly the two methods the class
 * calls, and the real `PinoLogger` satisfies the same interface structurally.
 * The fake and production therefore go through one contract rather than two.
 */
function recordingLogger(): { logger: ConnectionLogSink; lines: Recorded[] } {
  const lines: Recorded[] = [];
  const capture =
    (level: "error" | "info") =>
    (context: Record<string, unknown>, message: string): void => {
      lines.push({ level, context, message });
    };
  return { logger: { error: capture("error"), info: capture("info") }, lines };
}

/**
 * A Node system error, complete with the `code` the throttle keys on.
 *
 * A real class rather than `Object.assign` onto an Error: the lint rules ban
 * that shape outright, and `name` still reports "Error" because it is inherited
 * from `Error.prototype` — which is what the production describe() reads.
 */
class SystemError extends Error {
  constructor(
    readonly code: string,
    message = "connect failed",
  ) {
    super(message);
  }
}

/**
 * What ioredis actually emitted during the outage.
 *
 * ⚠️ An EMPTY message with the real detail in `errors[]`, one entry per address
 * the resolver tried. This is the exact shape that logged as
 * "AggregateError [ECONNREFUSED]:" with nothing after the colon.
 */
class MultiAddressError extends AggregateError {
  constructor(readonly code = "ECONNREFUSED") {
    super(
      [
        new SystemError("ECONNREFUSED", "connect ECONNREFUSED ::1:6379"),
        new SystemError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:6379"),
      ],
      "",
    );
  }
}

function systemError(code: string, message?: string): Error {
  return message === undefined ? new SystemError(code) : new SystemError(code, message);
}

describe("ConnectionErrorLog", () => {
  it("logs the first failure immediately", () => {
    const { logger, lines } = recordingLogger();
    const log = new ConnectionErrorLog(logger, "valkey", 30_000, () => 0);

    log.record(systemError("ECONNREFUSED"));

    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe("error");
    // An outage is never delayed by the throttle — that would be the one
    // regression that makes this worse than the unthrottled version.
    expect(lines[0]?.message).toContain("valkey unreachable");
  });

  it("suppresses an unchanged failure inside the window", () => {
    const { logger, lines } = recordingLogger();
    let now = 0;
    const log = new ConnectionErrorLog(logger, "valkey", 30_000, () => now);

    // 2s apart, exactly like ioredis's retry cadence. Fifteen attempts span
    // t=0..28s, so the whole burst sits inside the 30s window.
    for (let i = 0; i < 15; i += 1) {
      log.record(systemError("ECONNREFUSED"));
      now += 2_000;
    }

    // ⚠️ THE POINT OF THE CHANGE. Unthrottled this is 15 full AggregateError
    // stacks — and the real outage ran for hours across two clients, which is
    // how one dead Postgres produced a wall of Valkey frames.
    expect(lines).toHaveLength(1);
    expect(lines[0]?.context.attempts).toBe(1);
  });

  it("restates an ongoing outage once the window expires, carrying the counts", () => {
    const { logger, lines } = recordingLogger();
    let now = 0;
    const log = new ConnectionErrorLog(logger, "valkey", 30_000, () => now);

    log.record(systemError("ECONNREFUSED"));
    for (let i = 0; i < 20; i += 1) {
      now += 2_000;
      log.record(systemError("ECONNREFUSED"));
    }

    const restated = lines[1];
    expect(restated).toBeDefined();
    // Nothing is silently dropped: the swallowed attempts ride on the next line,
    // so the true rate is recoverable from the log alone.
    expect(restated?.context.suppressed).toBe(14);
    expect(restated?.context.attempts).toBe(16);
    expect(restated?.context.outageMs).toBe(30_000);
  });

  it("logs a changed failure immediately rather than swallowing it", () => {
    const { logger, lines } = recordingLogger();
    let now = 0;
    const log = new ConnectionErrorLog(logger, "valkey", 30_000, () => now);

    log.record(systemError("ECONNREFUSED"));
    now += 2_000;
    log.record(systemError("ECONNREFUSED"));
    now += 2_000;
    // ECONNREFUSED → ETIMEDOUT is a different failure, not a repeat of one.
    // Throttling on elapsed time alone would hide the transition.
    log.record(systemError("ETIMEDOUT"));

    expect(lines).toHaveLength(2);
    expect(lines[1]?.message).toContain("ETIMEDOUT");
  });

  it("keys on code, not message, so alternating addresses do not defeat it", () => {
    const { logger, lines } = recordingLogger();
    let now = 0;
    const log = new ConnectionErrorLog(logger, "valkey", 30_000, () => now);

    // ioredis alternates ::1 and 127.0.0.1 as the resolver retries. Keying the
    // throttle on the message would treat every attempt as new and suppress
    // nothing at all.
    for (const address of ["::1:6379", "127.0.0.1:6379", "::1:6379", "127.0.0.1:6379"]) {
      log.record(systemError("ECONNREFUSED", `connect ECONNREFUSED ${address}`));
      now += 2_000;
    }

    expect(lines).toHaveLength(1);
  });

  it("describes an AggregateError whose own message is empty", () => {
    const { logger, lines } = recordingLogger();
    const log = new ConnectionErrorLog(logger, "valkey", 30_000, () => 0);

    log.record(new MultiAddressError());

    // Logged plainly this rendered as "AggregateError [ECONNREFUSED]:" with
    // nothing after the colon — the reason the original output was unreadable.
    expect(lines[0]?.message).toBe(
      "valkey unreachable: AggregateError [ECONNREFUSED]: connect ECONNREFUSED ::1:6379",
    );
  });

  it("logs recovery once, with the outage duration", () => {
    const { logger, lines } = recordingLogger();
    let now = 0;
    const log = new ConnectionErrorLog(logger, "valkey", 30_000, () => now);

    log.record(systemError("ECONNREFUSED"));
    now += 8_000;
    log.record(systemError("ECONNREFUSED"));
    now += 2_000;
    log.recovered();

    const recovery = lines.at(-1);
    expect(recovery?.level).toBe("info");
    expect(recovery?.message).toBe("valkey reconnected");
    expect(recovery?.context.outageMs).toBe(10_000);
    expect(recovery?.context.attempts).toBe(2);
  });

  it("stays silent on a healthy first connect", () => {
    const { logger, lines } = recordingLogger();
    const log = new ConnectionErrorLog(logger, "valkey", 30_000, () => 0);

    // ioredis fires 'ready' on the first successful connect too. Announcing a
    // recovery from an outage that never happened is exactly the noise this
    // class removes.
    log.recovered();

    expect(lines).toHaveLength(0);
  });

  it("treats a later outage as new after recovery", () => {
    const { logger, lines } = recordingLogger();
    let now = 0;
    const log = new ConnectionErrorLog(logger, "valkey", 30_000, () => now);

    log.record(systemError("ECONNREFUSED"));
    now += 5_000;
    log.recovered();

    now += 5_000;
    log.record(systemError("ECONNREFUSED"));

    // The second outage logs immediately despite being inside the repeat window
    // of the first, and its counters start from zero rather than accumulating.
    const second = lines.at(-1);
    expect(second?.level).toBe("error");
    expect(second?.context.attempts).toBe(1);
    expect(second?.context.outageMs).toBe(0);
  });

  it("tells the two clients apart", () => {
    const { logger, lines } = recordingLogger();
    const shared = new ConnectionErrorLog(logger, "valkey", 30_000, () => 0);
    const subscriber = new ConnectionErrorLog(logger, "realtime-subscriber", 30_000, () => 0);

    // One Valkey outage trips both clients at once. Identical component names
    // would make a single incident read as two unrelated ones.
    shared.record(systemError("ECONNREFUSED"));
    subscriber.record(systemError("ECONNREFUSED"));

    expect(lines.map((line) => line.context.component)).toStrictEqual([
      "valkey",
      "realtime-subscriber",
    ]);
  });

  it("survives an error carrying no code at all", () => {
    const { logger, lines } = recordingLogger();
    const log = new ConnectionErrorLog(logger, "valkey", 30_000, () => 0);

    // Not every ioredis error is a Node system error — a command timeout throws
    // a plain Error. Reading `code` off it must not throw inside the handler,
    // because an exception here reaches an EventEmitter and crashes the process.
    log.record(new Error("Command timed out"));

    expect(lines).toHaveLength(1);
    expect(lines[0]?.message).toBe("valkey unreachable: Error: Command timed out");
  });
});
