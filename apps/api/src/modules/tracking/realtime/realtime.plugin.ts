import websocket from "@fastify/websocket";
import type { WebSocket } from "@fastify/websocket";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { RealtimeConnection } from "./realtime-connection.js";
import type { RealtimeGateway } from "./realtime.gateway.js";

/** Close codes. 4401 is the conventional application-level "unauthorized". */
const CLOSE_UNAUTHORIZED = 4_401;

/**
 * Registers `GET /v1/realtime` as a WebSocket endpoint.
 *
 * Done as a Fastify plugin rather than a Nest gateway on purpose: the app runs
 * on the Fastify adapter, and `@nestjs/platform-ws` would stand a second HTTP
 * server beside it — two ports, two lifecycles, two places for CORS and shutdown
 * to disagree. `@fastify/websocket` upgrades the connection on the server that
 * is already listening.
 */
export async function registerRealtime(
  app: FastifyInstance,
  gateway: RealtimeGateway,
): Promise<void> {
  await app.register(websocket, {
    options: {
      // A dispatcher never sends anything large; the cap stops a malicious
      // client from buying megabytes of server memory per frame.
      maxPayload: 16 * 1_024,
    },
  });

  app.get("/v1/realtime", { websocket: true }, (socket, request: FastifyRequest) => {
    handleConnection(socket, request, gateway);
  });
}

/**
 * How many frames a client may send before it is authenticated.
 *
 * A real client sends exactly one — its `subscribe`. The cap exists because
 * anything buffered before authentication is memory an unauthenticated peer can
 * ask for; `maxPayload` bounds each frame, this bounds the count.
 */
const MAX_PENDING_FRAMES = 16;

/**
 * Wires one upgraded socket to the gateway.
 *
 * ⚠️ SYNCHRONOUS, and the listeners are attached BEFORE the handshake is
 * awaited. This function used to be `async` and registered `socket.on("message")`
 * only after `await gateway.accept(...)` resolved — so a frame arriving during
 * the handshake had no listener and was DROPPED by `ws`, silently.
 *
 * Every real client sends `subscribe` the instant the socket opens, so this was
 * a live race, not a theoretical one: measured at roughly 1 connection in 20,
 * and worst on the FIRST connection for a tenant, where `accept` additionally
 * waits on a Valkey SUBSCRIBE round-trip. The victim saw a socket that opened
 * normally, never received `subscribed`, and never received a position — a
 * dispatcher board that stays silently empty with nothing in any log.
 *
 * Frames that arrive before the connection is ready are queued and replayed in
 * arrival order once it is.
 *
 * Exported so the race itself is testable: it needs a socket that emits a frame
 * while `accept` is still pending, which cannot be arranged through Fastify.
 */
export function handleConnection(
  socket: WebSocket,
  request: FastifyRequest,
  gateway: RealtimeGateway,
): void {
  const pending: string[] = [];
  let connection: RealtimeConnection | null = null;
  let closed = false;

  socket.on("message", (data: unknown) => {
    const frame = String(data);
    if (connection === null) {
      if (pending.length >= MAX_PENDING_FRAMES) {
        // Flooding before authenticating. Not a dispatcher.
        socket.close(CLOSE_UNAUTHORIZED, "unauthorized");
        return;
      }
      pending.push(frame);
      return;
    }
    void gateway.handleMessage(connection, frame);
  });

  socket.on("close", () => {
    closed = true;
    if (connection !== null) {
      gateway.release(connection);
    }
  });

  socket.on("error", () => {
    // A transport error is a dead connection, nothing more. Releasing it keeps
    // the broadcast loop from writing into a socket nobody is reading.
    closed = true;
    if (connection !== null) {
      gateway.release(connection);
    }
  });

  void (async () => {
    const accepted = await gateway.accept(socket, extractToken(request));
    if (accepted === null) {
      // Identical response for missing, expired, tampered, and unentitled — the
      // same non-disclosure the HTTP guard practises.
      socket.close(CLOSE_UNAUTHORIZED, "unauthorized");
      return;
    }
    if (closed) {
      // The client hung up mid-handshake. Release it, or it lingers in the
      // gateway's connection set and the broadcast loop writes into a dead socket.
      gateway.release(accepted);
      return;
    }

    // Drained BEFORE `connection` is set, so a frame arriving mid-drain queues
    // behind the ones already waiting instead of overtaking them. There is no
    // await between the loop exiting and the assignment, so nothing can slip in.
    for (;;) {
      const frame = pending.shift();
      if (frame === undefined) {
        break;
      }
      await gateway.handleMessage(accepted, frame);
    }
    connection = accepted;
  })();
}

/**
 * Reads the access token from the handshake.
 *
 * Browsers cannot set headers on a WebSocket handshake, so the query parameter
 * is the practical option and is what docs/05 §10 assumes ("JWT in handshake").
 * The `Authorization` header is accepted too, for non-browser clients and tests.
 *
 * A token in a query string can land in access logs, so this is a short-lived
 * access token — never a refresh token — and the connection is re-authenticated
 * when it reconnects rather than being trusted indefinitely.
 */
function extractToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (header !== undefined) {
    const [scheme, value] = header.split(" ");
    if (scheme !== undefined && value !== undefined && scheme.toLowerCase() === "bearer") {
      return value;
    }
  }

  const query: unknown = request.query;
  if (typeof query === "object" && query !== null && "token" in query) {
    const { token }: { token?: unknown } = query;
    if (typeof token === "string" && token.length > 0) {
      return token;
    }
  }
  return null;
}
