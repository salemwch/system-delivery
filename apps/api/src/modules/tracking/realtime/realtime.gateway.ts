import { Inject, Injectable } from "@nestjs/common";
import type { OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { Redis } from "ioredis";
import { PinoLogger } from "nestjs-pino";

import { DatabaseService, asTenantId } from "../../../shared/database/index.js";
import { VALKEY_CLIENT } from "../../../shared/valkey/index.js";
import { TokenService } from "../../identity/index.js";
import type { Principal } from "../../identity/index.js";
import { REALTIME_SUBSCRIBER } from "../tracking.tokens.js";
import { clientMessageSchema, positionUpdateSchema } from "./protocol.js";
import type { ServerMessage } from "./protocol.js";
import { RealtimeConnection } from "./realtime-connection.js";
import type { DriverPositionUpdate, Socket } from "./realtime-connection.js";

/** Emitted once per second per client. Fixed by docs/05 §10, not tunable. */
const TICK_MS = 1_000;

/** Valkey channel carrying one tenant's live positions across API instances. */
function positionChannel(tenantId: string): string {
  return `rt:${tenantId}:positions`;
}

function eventChannel(tenantId: string): string {
  return `rt:${tenantId}:events`;
}

/**
 * The dispatcher realtime gateway (docs/05-api-contracts.md §10).
 *
 * Holds every open dispatcher socket, decides what each one is allowed to see,
 * and ships one coalesced frame per second.
 *
 * **Cross-instance fan-out via Valkey pub/sub.** A driver's ping lands on
 * whichever API instance their phone reached; a dispatcher's socket lives on
 * whichever instance their browser reached. Those are rarely the same, so
 * positions are published to a per-tenant channel and every instance forwards to
 * its own clients (blueprint §3.9: "decouples which gateway holds this
 * dispatcher's socket from which gateway received this driver's ping"). Without
 * it, two replicas means a dispatcher silently sees half the fleet — a bug that
 * does not appear until the second instance is deployed.
 *
 * The channel is per tenant so fan-out cost stays bounded: an instance with no
 * dispatchers for a tenant is not woken by that tenant's traffic.
 */
@Injectable()
export class RealtimeGateway implements OnModuleInit, OnApplicationShutdown {
  private readonly connections = new Set<RealtimeConnection>();
  private tick: NodeJS.Timeout | null = null;
  private readonly subscribedTenants = new Set<string>();

  constructor(
    private readonly tokens: TokenService,
    private readonly database: DatabaseService,
    @Inject(VALKEY_CLIENT) private readonly valkey: Redis,
    @Inject(REALTIME_SUBSCRIBER) private readonly subscriber: Redis,
    private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    this.subscriber.on("message", (channel: string, payload: string) => {
      this.dispatchFromValkey(channel, payload);
    });

    this.tick = setInterval(() => {
      this.flushAll(new Date());
    }, TICK_MS);
    // A heartbeat must never be the reason the process refuses to exit.
    this.tick.unref?.();
  }

  onApplicationShutdown(): void {
    if (this.tick !== null) {
      clearInterval(this.tick);
      this.tick = null;
    }
    // 1001 "going away" tells the client this is a deploy, not a fault, so it
    // reconnects immediately instead of backing off as it would on an error.
    for (const connection of this.connections) {
      connection.close(1_001, "server shutting down");
    }
    this.connections.clear();
  }

  /** Open connection count — used by tests and health reporting. */
  get connectionCount(): number {
    return this.connections.size;
  }

  /**
   * Authenticates a handshake and registers the socket.
   *
   * Returns null when the token is missing or invalid, and the caller closes the
   * socket. Identity comes from `TokenService.authenticate` — the same call the
   * HTTP guard makes — so a socket cannot end up with a different view of who
   * someone is than a request would give.
   */
  async accept(socket: Socket, token: string | null): Promise<RealtimeConnection | null> {
    if (token === null) {
      return null;
    }
    const principal = await this.tokens.authenticate(token);
    if (principal === null) {
      return null;
    }
    if (!principal.permissions.has("driver:location:read_live")) {
      // Authenticated but not entitled to watch the fleet. Refused at the
      // handshake rather than accepted and starved, so the client sees why.
      return null;
    }

    const connection = new RealtimeConnection(principal, socket);
    this.connections.add(connection);
    await this.ensureTenantSubscribed(principal.tenantId);
    return connection;
  }

  /** Removes a closed socket. Idempotent — a close can arrive twice. */
  release(connection: RealtimeConnection): void {
    connection.markClosed();
    this.connections.delete(connection);
  }

  /**
   * Handles one client frame.
   *
   * Every message is parsed with a strict schema before anything acts on it: a
   * WebSocket payload is as untrusted as a request body, and it arrives without
   * the HTTP validation pipe in front of it.
   */
  async handleMessage(connection: RealtimeConnection, raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      connection.send(errorMessage("MALFORMED_MESSAGE", "Message is not valid JSON"));
      return;
    }

    const result = clientMessageSchema.safeParse(parsed);
    if (!result.success) {
      connection.send(errorMessage("INVALID_MESSAGE", "Message does not match the protocol"));
      return;
    }

    const message = result.data;
    if (message.op === "ping") {
      connection.send({ op: "pong" });
      return;
    }
    if (message.op === "unsubscribe") {
      connection.unsubscribe(message.channels);
      connection.send({ op: "subscribed", channels: [] });
      return;
    }

    // ⚠️ Tenant ownership of every named resource is verified here. A socket is
    // not a database query, so RLS never sees this — an unchecked subscribe
    // would let any authenticated dispatcher watch another tenant's route by
    // guessing an id.
    const allowed = await this.filterOwned(connection.principal, message.channels);
    if (allowed.length !== message.channels.length) {
      connection.send(
        errorMessage("SUBSCRIPTION_FORBIDDEN", "One or more channels are not visible to you"),
      );
      return;
    }

    connection.subscribe(allowed, message.viewport);
    connection.send({ op: "subscribed", channels: allowed });
  }

  /**
   * Publishes a driver position to every instance holding sockets for the tenant.
   *
   * Called by telemetry ingest. Fire-and-forget: the dispatcher map is a
   * convenience view, and a Valkey hiccup must never fail a driver's upload.
   */
  publishPosition(tenantId: string, update: DriverPositionUpdate): void {
    void this.valkey
      .publish(positionChannel(tenantId), JSON.stringify(update))
      .catch((error: unknown) => {
        this.logger.warn(
          { err: error instanceof Error ? error : new Error(String(error)), tenantId },
          "failed to publish realtime position",
        );
      });
  }

  /** Publishes a fact — a status change or an alert — to the tenant's dispatchers. */
  publishEvent(tenantId: string, message: ServerMessage): void {
    void this.valkey
      .publish(eventChannel(tenantId), JSON.stringify(message))
      .catch((error: unknown) => {
        this.logger.warn(
          { err: error instanceof Error ? error : new Error(String(error)), tenantId },
          "failed to publish realtime event",
        );
      });
  }

  /** Ships everything owed on every connection. The 1 Hz tick. */
  flushAll(now: Date): void {
    for (const connection of this.connections) {
      connection.flush(now);
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async ensureTenantSubscribed(tenantId: string): Promise<void> {
    if (this.subscribedTenants.has(tenantId)) {
      return;
    }
    this.subscribedTenants.add(tenantId);
    await this.subscriber.subscribe(positionChannel(tenantId), eventChannel(tenantId));
  }

  private dispatchFromValkey(channel: string, payload: string): void {
    const match = /^rt:([0-9a-f-]{36}):(positions|events)$/iu.exec(channel);
    if (match === null) {
      return;
    }
    const [, tenantId, kind] = match;
    if (tenantId === undefined) {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      this.logger.warn({ channel }, "dropping malformed realtime payload");
      return;
    }

    // Validated, not trusted: this crossed a process boundary, and during a
    // rolling deploy the publisher may be running different code than we are.
    const update = kind === "positions" ? positionUpdateSchema.safeParse(parsed) : null;
    const event = kind === "events" ? toServerMessage(parsed) : null;
    if (update?.success === false || (kind === "events" && event === null)) {
      this.logger.warn({ channel }, "dropping realtime payload that failed validation");
      return;
    }

    for (const connection of this.connections) {
      if (connection.tenantId !== tenantId) {
        continue;
      }
      if (update?.success === true) {
        connection.offerPosition(update.data);
      } else if (event !== null) {
        connection.offerEvent(event);
      }
    }
  }

  /**
   * Returns the subset of channels this principal's tenant actually owns.
   *
   * Ids are checked against the database inside the caller's tenant context, so
   * RLS does the filtering: another tenant's route simply does not exist from
   * here. `drivers:viewport` needs no check — it is scoped by the connection's
   * own tenant and its bbox.
   */
  private async filterOwned(principal: Principal, channels: readonly string[]): Promise<string[]> {
    const routeIds: string[] = [];
    const shipmentIds: string[] = [];
    const allowed: string[] = [];

    for (const channel of channels) {
      if (channel === "drivers:viewport") {
        allowed.push(channel);
      } else if (channel.startsWith("route:")) {
        routeIds.push(channel.slice("route:".length));
      } else if (channel.startsWith("shipment:")) {
        shipmentIds.push(channel.slice("shipment:".length));
      }
    }

    if (routeIds.length === 0 && shipmentIds.length === 0) {
      return allowed;
    }

    await this.database.withTenant(async (tx) => {
      if (routeIds.length > 0) {
        const rows: Array<{ id: string }> = await tx
          .select({ id: sql<string>`id` })
          .from(sql`routes`)
          .where(sql`id IN (${idList(routeIds)})`);
        for (const row of rows) {
          allowed.push(`route:${row.id}`);
        }
      }
      if (shipmentIds.length > 0) {
        const rows: Array<{ id: string }> = await tx
          .select({ id: sql<string>`id` })
          .from(sql`shipments`)
          .where(sql`id IN (${idList(shipmentIds)})`);
        for (const row of rows) {
          allowed.push(`shipment:${row.id}`);
        }
      }
    }, asTenantId(principal.tenantId));

    return allowed;
  }
}

/** A parameterised uuid list — one bind per id, never interpolated text. */
function idList(ids: readonly string[]): ReturnType<typeof sql.join> {
  return sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
}

function errorMessage(code: string, message: string): ServerMessage {
  return { op: "error", code, message };
}

/**
 * Narrows a relayed payload to a server message.
 *
 * Only the two kinds that must never be dropped travel this channel; anything
 * else arriving here is a publisher bug and is discarded rather than forwarded
 * to a dispatcher's browser.
 */
function toServerMessage(value: unknown): ServerMessage | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record: Record<string, unknown> = { ...value };
  const op = record["op"];

  if (op === "shipment_updated") {
    const shipment = record["shipment"];
    if (typeof shipment !== "object" || shipment === null) {
      return null;
    }
    return { op: "shipment_updated", shipment: { ...shipment } };
  }

  if (op === "alert") {
    const severity = record["severity"];
    const code = record["code"];
    if (
      typeof code !== "string" ||
      (severity !== "info" && severity !== "warning" && severity !== "critical")
    ) {
      return null;
    }
    return { ...record, op: "alert", severity, code };
  }

  return null;
}
