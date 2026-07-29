import type { Principal } from "../../identity/index.js";
import { withinBbox } from "./protocol.js";
import type { Bbox, PositionFrameEntry, ServerMessage } from "./protocol.js";

/** The transport, narrowed to what a connection actually needs. */
export interface Socket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** Bytes queued in the kernel/library buffer — the backpressure signal. */
  readonly bufferedAmount: number;
}

/** A position update as it arrives from ingest, before viewport filtering. */
export interface DriverPositionUpdate {
  readonly driverId: string;
  readonly lat: number;
  readonly lon: number;
  readonly headingDeg: number | null;
  readonly speedMps: number | null;
  readonly batteryPct: number | null;
  readonly routeId: string | null;
}

/**
 * Above this many bytes queued on the socket, the client is not keeping up.
 *
 * Position frames are then dropped and only the newest state is kept, because a
 * stale position has no value once a newer one exists. Events are never dropped.
 */
const BACKPRESSURE_BYTES = 1_048_576;

/**
 * One dispatcher's connection: what it is subscribed to, and what it is owed.
 *
 * The two rules from docs/05-api-contracts.md §10 both live here, and both exist
 * because a dispatcher watching 200 drivers is the difference between a usable
 * board and a browser tab that melts:
 *
 *  1. **One coalesced `positions` frame per second, never one per driver.**
 *     Positions accumulate into a map keyed by driver — the newest wins — and
 *     the whole map ships on the next tick. 200 drivers moving at 1 Hz is one
 *     message a second, not 200.
 *
 *  2. **Under backpressure, drop superseded positions but never
 *     `shipment_updated` or `alert`.** A position is a sample of a continuous
 *     signal: the next one makes the last irrelevant, so dropping is free. A
 *     status change or an alert is a fact that happened once — dropping it means
 *     a dispatcher never learns a delivery failed. Two queues, two policies.
 */
export class RealtimeConnection {
  private readonly channels = new Set<string>();
  private viewport: Bbox | null = null;

  /** Latest position per driver, awaiting the next tick. Newest always wins. */
  private readonly pending = new Map<string, PositionFrameEntry>();
  /** Facts that must arrive. Never dropped, only delayed. */
  private readonly events: ServerMessage[] = [];

  private closed = false;
  private droppedFrames = 0;

  constructor(
    readonly principal: Principal,
    private readonly socket: Socket,
  ) {}

  get tenantId(): string {
    return this.principal.tenantId;
  }

  /** Diagnostics — asserted by tests so behaviour is checked, not timing. */
  stats(): { pending: number; queuedEvents: number; droppedFrames: number } {
    return {
      pending: this.pending.size,
      queuedEvents: this.events.length,
      droppedFrames: this.droppedFrames,
    };
  }

  subscribe(channels: readonly string[], viewport: Bbox | undefined): void {
    for (const channel of channels) {
      this.channels.add(channel);
    }
    if (viewport !== undefined) {
      this.viewport = viewport;
    }
  }

  unsubscribe(channels: readonly string[]): void {
    for (const channel of channels) {
      this.channels.delete(channel);
      if (channel === "drivers:viewport") {
        this.viewport = null;
      }
    }
  }

  isSubscribedTo(channel: string): boolean {
    return this.channels.has(channel);
  }

  /**
   * Queues a position if this client cares about it.
   *
   * Filtered here rather than at the publisher: every connection has its own
   * viewport, and a driver visible to one dispatcher is off-screen for another.
   */
  offerPosition(update: DriverPositionUpdate): void {
    if (this.closed || !this.wants(update)) {
      return;
    }
    // Overwrites any earlier position for this driver — that is the coalescing.
    this.pending.set(update.driverId, {
      id: update.driverId,
      lat: update.lat,
      lon: update.lon,
      hdg: update.headingDeg,
      spd: update.speedMps,
      bat: update.batteryPct,
    });
  }

  /** Queues a fact. Never coalesced, never dropped. */
  offerEvent(message: ServerMessage): void {
    if (this.closed) {
      return;
    }
    this.events.push(message);
  }

  /**
   * Ships everything owed. Called once per second by the gateway's tick.
   *
   * Events go first: under load, a dispatcher learning that a delivery failed
   * matters more than the map being a second fresher.
   */
  flush(now: Date): void {
    if (this.closed) {
      return;
    }

    while (this.events.length > 0) {
      const event = this.events.shift();
      if (event !== undefined) {
        this.write(event);
      }
    }

    if (this.pending.size === 0) {
      return;
    }

    if (this.socket.bufferedAmount > BACKPRESSURE_BYTES) {
      // The client is behind. Discard this frame and keep only the newest state
      // — sending a backlog of superseded positions would make it further
      // behind, which is how a slow consumer turns into a stuck one.
      this.pending.clear();
      this.droppedFrames += 1;
      return;
    }

    const drivers = [...this.pending.values()];
    this.pending.clear();
    this.write({ op: "positions", ts: now.toISOString(), drivers });
  }

  send(message: ServerMessage): void {
    if (!this.closed) {
      this.write(message);
    }
  }

  close(code?: number, reason?: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.pending.clear();
    this.events.length = 0;
    this.socket.close(code, reason);
  }

  markClosed(): void {
    this.closed = true;
    this.pending.clear();
    this.events.length = 0;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private wants(update: DriverPositionUpdate): boolean {
    if (update.routeId !== null && this.channels.has(`route:${update.routeId}`)) {
      return true;
    }
    if (!this.channels.has("drivers:viewport")) {
      return false;
    }
    // Subscribed to the viewport channel but with no bbox set yet: send
    // everything rather than nothing, so a client that subscribes before its map
    // has settled still sees drivers.
    return this.viewport === null || withinBbox(this.viewport, update.lat, update.lon);
  }

  private write(message: ServerMessage): void {
    try {
      this.socket.send(JSON.stringify(message));
    } catch {
      // A send on a socket the peer has already dropped throws. That is a closed
      // connection, not an error worth propagating into the broadcast loop —
      // one dead client must never interrupt delivery to the others.
      this.markClosed();
    }
  }
}
