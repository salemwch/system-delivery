/**
 * A consecutive-failure circuit breaker for one external dependency.
 *
 * Closed until `threshold` calls fail in a row; then open for `cooldownMs`,
 * failing fast; then half-open, letting one call through to probe. Success
 * closes it, failure re-opens it. The same state machine the OSRM, Nominatim
 * and SMS clients each carry inline; new clients use this one.
 */
export class CircuitBreaker {
  private consecutiveFailures = 0;
  private openedAt: number | null = null;

  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(threshold) || threshold < 1) {
      throw new RangeError("threshold must be a positive integer");
    }
  }

  /** True when a call should fail fast without being attempted. */
  get isOpen(): boolean {
    if (this.openedAt === null) {
      return false;
    }
    if (this.now() - this.openedAt >= this.cooldownMs) {
      // Half-open: the next call probes.
      this.openedAt = null;
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedAt = null;
  }

  /** Returns true when this failure opened the breaker. */
  recordFailure(): boolean {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.threshold && this.openedAt === null) {
      this.openedAt = this.now();
      return true;
    }
    return false;
  }
}
