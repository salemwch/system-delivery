/** Wall clock, injectable so tests advance time without waiting for it. */
export type Clock = () => number;

/**
 * The two log methods this class uses, and nothing else.
 *
 * ⚠️ Narrower than `PinoLogger` ON PURPOSE. `PinoLogger` satisfies it
 * structurally — its `error(obj: unknown, msg?: string)` accepts these
 * arguments — so the modules pass the real logger unchanged, while a test can
 * pass a plain recording object. Depending on the full class instead would
 * force every caller that isn't Nest to fake ~15 methods or reach for a type
 * assertion, and assertions are banned here.
 */
export interface ConnectionLogSink {
  error(context: Record<string, unknown>, message: string): void;
  info(context: Record<string, unknown>, message: string): void;
}

/** How long an unchanged failure stays quiet before it is restated. */
const DEFAULT_REPEAT_AFTER_MS = 30_000;

/**
 * Collapses a Valkey reconnect storm into a readable outage record.
 *
 * ⚠️ WHY THIS EXISTS. An ioredis client emits `error` on EVERY reconnect
 * attempt, roughly every two seconds, for as long as the server is unreachable
 * — and the platform runs two clients (the shared one and the realtime
 * subscriber). A local Docker outage therefore produced a full `AggregateError`
 * stack four times a second, forever. That is not a logging inconvenience: it
 * is a diagnostic failure. It buried the actual cause (Postgres was down too)
 * under thousands of identical Valkey frames, so the outage read as a Valkey
 * problem when Valkey was merely the loudest casualty.
 *
 * The policy is deliberately NOT "log less". Every attempt is still counted and
 * every distinct failure is still reported at `error`:
 *
 * - the FIRST failure logs immediately — an outage is never delayed;
 * - a failure whose signature CHANGES logs immediately, because
 *   `ECONNREFUSED → ETIMEDOUT` is new information, not a repeat;
 * - an unchanged failure is restated every {@link DEFAULT_REPEAT_AFTER_MS},
 *   carrying how many attempts it swallowed and how long the outage has run;
 * - recovery logs once at `info`, which is the line that tells an operator the
 *   incident is over — previously nothing at all marked the end.
 *
 * Suppressed attempts are never silently dropped: `attempts` and `suppressed`
 * ride on the next record, so the count is recoverable from the log.
 */
export class ConnectionErrorLog {
  /** `name:code` of the last failure reported, or null before the first. */
  private signature: string | null = null;
  /** Attempts swallowed since the last line was written. */
  private suppressed = 0;
  /** Attempts in the current outage, including the ones written. */
  private attempts = 0;
  /** Start of the current outage; null when the connection is healthy. */
  private outageStartedAt: number | null = null;
  private lastLoggedAt = 0;

  constructor(
    private readonly logger: ConnectionLogSink,
    /** Names the connection in logs — the two clients must be tellable apart. */
    private readonly component: string,
    private readonly repeatAfterMs: number = DEFAULT_REPEAT_AFTER_MS,
    private readonly now: Clock = Date.now,
  ) {}

  /** Records one `error` event, logging it only when it carries new signal. */
  record(error: Error): void {
    const at = this.now();
    const signature = signatureOf(error);

    this.attempts += 1;
    // `??=` and not `=`: the outage started at the FIRST failure, and every
    // later attempt must measure against that, not reset it.
    this.outageStartedAt ??= at;

    const isFirst = this.signature === null;
    const changed = signature !== this.signature;
    const isDue = at - this.lastLoggedAt >= this.repeatAfterMs;

    if (!isFirst && !changed && !isDue) {
      this.suppressed += 1;
      return;
    }

    this.logger.error(
      {
        err: error,
        component: this.component,
        attempts: this.attempts,
        suppressed: this.suppressed,
        outageMs: at - this.outageStartedAt,
      },
      `${this.component} unreachable: ${describe(error)}`,
    );

    this.signature = signature;
    this.suppressed = 0;
    this.lastLoggedAt = at;
  }

  /**
   * Records a successful (re)connect.
   *
   * ⚠️ Silent when no failure preceded it. ioredis fires `ready` on the first
   * healthy connect too, and "reconnected after 0 attempts" on every boot would
   * be exactly the noise this class exists to remove.
   */
  recovered(): void {
    if (this.outageStartedAt === null) {
      return;
    }

    this.logger.info(
      {
        component: this.component,
        attempts: this.attempts,
        suppressed: this.suppressed,
        outageMs: this.now() - this.outageStartedAt,
      },
      `${this.component} reconnected`,
    );

    this.signature = null;
    this.suppressed = 0;
    this.attempts = 0;
    this.outageStartedAt = null;
    this.lastLoggedAt = 0;
  }
}

/**
 * What makes two failures "the same" for throttling.
 *
 * Name plus code, never the message: a message carries the port and address,
 * which alternate between `::1` and `127.0.0.1` as the resolver retries. Keying
 * on it would defeat the throttle entirely, since every other attempt would
 * look new.
 */
function signatureOf(error: Error): string {
  return `${error.name}:${codeOf(error) ?? ""}`;
}

/** Node attaches `code` to system errors; nothing guarantees it is present. */
function codeOf(error: Error): string | undefined {
  if (!("code" in error)) {
    return undefined;
  }
  const value: unknown = error.code;
  return typeof value === "string" ? value : undefined;
}

/**
 * A one-line description, which the raw error does not always provide.
 *
 * ⚠️ An `AggregateError` from a failed multi-address connect has an EMPTY
 * message — the detail lives in `errors[]`, one entry per address tried. Logged
 * plainly it renders as `AggregateError [ECONNREFUSED]:` with nothing after the
 * colon, which is what made the original output so hard to read.
 */
function describe(error: Error): string {
  const code = codeOf(error);
  const prefix = code === undefined ? error.name : `${error.name} [${code}]`;
  const detail = detailOf(error);
  return detail === "" ? prefix : `${prefix}: ${detail}`;
}

function detailOf(error: Error): string {
  if (error.message !== "") {
    return error.message;
  }
  if (!("errors" in error)) {
    return "";
  }
  const value: unknown = error.errors;
  if (!Array.isArray(value)) {
    return "";
  }
  // Re-typed rather than asserted: `Array.isArray` narrows `unknown` to `any[]`,
  // and `any` is banned. Assigning to `readonly unknown[]` restores safety.
  const nested: readonly unknown[] = value;
  const first = nested.find((candidate): candidate is Error => candidate instanceof Error);
  return first?.message ?? "";
}
