import { z } from "zod";

/**
 * The dispatcher WebSocket protocol (docs/05-api-contracts.md §10).
 *
 * Wire shapes are fixed by that document; the dispatcher board is written
 * against them. Terse on the server→client side for the same reason the
 * telemetry payload is terse: a `positions` frame goes out once per second per
 * connected dispatcher, forever.
 */

/** A viewport, as [west, south, east, north] — the order every map library uses. */
const bboxSchema = z
  .tuple([
    z.number().min(-180).max(180),
    z.number().min(-90).max(90),
    z.number().min(-180).max(180),
    z.number().min(-90).max(90),
  ])
  // Only latitude is ordered. `west > east` is legal and means the viewport
  // crosses the antimeridian — see `withinBbox`.
  .refine(([, south, , north]) => south <= north, {
    message: "bbox must be [west, south, east, north] with south <= north",
  });
export type Bbox = z.infer<typeof bboxSchema>;

/**
 * Channels a client may subscribe to.
 *
 * `drivers:viewport` is unqualified because it is scoped by the bbox and the
 * connection's tenant. The others name a specific resource, and every one of
 * those ids is verified against the caller's tenant before the subscription is
 * accepted — an unchecked subscribe is a cross-tenant read that RLS cannot see,
 * because a socket is not a database query.
 */
const channelSchema = z.union([
  z.literal("drivers:viewport"),
  z.string().regex(/^route:[0-9a-f-]{36}$/iu),
  z.string().regex(/^shipment:[0-9a-f-]{36}$/iu),
]);

export const clientMessageSchema = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("subscribe"),
    channels: z.array(channelSchema).min(1).max(50),
    viewport: bboxSchema.optional(),
  }),
  z.strictObject({
    op: z.literal("unsubscribe"),
    channels: z.array(channelSchema).min(1).max(50),
  }),
  /** Liveness. The server replies `pong`; an idle socket is reaped without one. */
  z.strictObject({ op: z.literal("ping") }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

/**
 * A position as it travels between API instances over Valkey pub/sub.
 *
 * Validated on receipt rather than trusted: it crossed a process boundary, and
 * a rolling deploy means the publisher may be running different code than the
 * subscriber. Cheap insurance against a malformed frame reaching a dispatcher.
 */
export const positionUpdateSchema = z.object({
  driverId: z.string().min(1),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  headingDeg: z.number().nullable(),
  speedMps: z.number().nullable(),
  batteryPct: z.number().nullable(),
  routeId: z.string().nullable(),
});

/** One driver in a coalesced positions frame. Terse by design — this is the hot path. */
export interface PositionFrameEntry {
  readonly id: string;
  readonly lat: number;
  readonly lon: number;
  readonly hdg: number | null;
  readonly spd: number | null;
  readonly bat: number | null;
}

export type ServerMessage =
  | { readonly op: "positions"; readonly ts: string; readonly drivers: PositionFrameEntry[] }
  | { readonly op: "shipment_updated"; readonly shipment: Record<string, unknown> }
  | {
      readonly op: "alert";
      readonly severity: "info" | "warning" | "critical";
      readonly code: string;
      readonly [key: string]: unknown;
    }
  | { readonly op: "subscribed"; readonly channels: readonly string[] }
  | { readonly op: "pong" }
  | { readonly op: "error"; readonly code: string; readonly message: string };

/**
 * Whether a point falls inside a viewport.
 *
 * Antimeridian-aware: a bbox whose west edge is greater than its east crosses
 * ±180°, and a naive `west <= lon && lon <= east` renders such a viewport empty.
 * Irrelevant in Tunisia, wrong everywhere else, and free to get right here.
 */
export function withinBbox(bbox: Bbox, lat: number, lon: number): boolean {
  const [west, south, east, north] = bbox;
  if (lat < south || lat > north) {
    return false;
  }
  return west <= east ? lon >= west && lon <= east : lon >= west || lon <= east;
}
