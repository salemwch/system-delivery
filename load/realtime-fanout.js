import ws from "k6/ws";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

/**
 * WebSocket realtime fan-out under load.
 *
 * `docs/05-api-contracts.md` §10 states the rule this scenario exists to verify:
 * **one `positions` frame per second per client, never one per driver.** 200
 * drivers at 1 Hz is 200 messages/sec/client done naively and 1/sec done
 * correctly — a 200× difference in fan-out cost that only shows up under load.
 *
 * With N dispatchers connected and the telemetry scenario running alongside, the
 * measurement is whether frame rate stays flat as drivers move. A per-driver
 * frame rate would grow with fleet size; a coalesced one does not.
 *
 * ⚠️ Run this WITH `load:telemetry` in another terminal. Alone it measures an
 * idle socket, which proves nothing:
 *
 *   pnpm load:telemetry &      # produces the positions
 *   pnpm load:realtime         # measures what reaches dispatchers
 */

const fixture = JSON.parse(open("./fixture.json"));

/** How long each simulated dispatcher keeps its board open. */
const SESSION_SECONDS = 30;

const framesPerSecond = new Trend("frames_per_second");
const positionFrames = new Counter("position_frames");
const otherFrames = new Counter("non_position_frames");
const handshakeOk = new Rate("handshake_ok");
const subscribeOk = new Rate("subscribe_ok");

export const options = {
  scenarios: {
    // ONE full session per VU. A duration-based run starts a second round that
    // the clock cuts short, and a truncated session looks identical to a client
    // that never received frames — which would hide the very thing this measures.
    dispatchers: {
      executor: "shared-iterations",
      // More dispatcher boards than a real courier runs. If coalescing works the
      // per-client cost is flat, so this should be uneventful — and if it is
      // not, the number here is the ceiling.
      vus: 20,
      iterations: 20,
      maxDuration: `${SESSION_SECONDS + 30}s`,
    },
  },
  thresholds: {
    handshake_ok: ["rate>0.99"],
    subscribe_ok: ["rate>0.99"],
    // THE assertion. 1 Hz coalescing plus a small margin for the odd
    // `shipment_updated` or `alert`; anything above this means frames are being
    // emitted per driver rather than per tick.
    frames_per_second: ["p(95)<3"],
  },
};

export default function () {
  // Greater Tunis, matching where the telemetry scenario places its drivers.
  // A TUPLE [west, south, east, north] — the order every map library uses, and
  // the only shape the protocol accepts. An object is rejected as INVALID_MESSAGE.
  const viewport = [10.0, 36.6, 10.4, 37.0];

  // Token in the query string, which the handshake accepts alongside the
  // Authorization header — browsers cannot set headers on a WebSocket.
  const url = `${fixture.baseUrl.replace(/^http/u, "ws")}/v1/realtime?token=${fixture.dispatcherToken}`;

  let positions = 0;
  let openedAt = 0;
  let subscribed = false;

  const response = ws.connect(url, {}, (socket) => {
    socket.on("open", () => {
      openedAt = Date.now();
      handshakeOk.add(true);
      socket.send(JSON.stringify({ op: "subscribe", channels: ["drivers:viewport"], viewport }));
    });

    socket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        otherFrames.add(1);
        return;
      }
      if (message.op === "subscribed") {
        subscribed = true;
        return;
      }
      if (message.op === "positions") {
        positions += 1;
        positionFrames.add(1);
      } else {
        // `shipment_updated` and `alert` are never dropped under backpressure,
        // unlike superseded position frames — counted separately so they cannot
        // be mistaken for a coalescing failure.
        otherFrames.add(1);
      }
    });

    socket.on("error", (e) => {
      // A 1006 close during teardown is the timer firing, not a failure.
      if (e.error() !== "websocket: close sent") {
        handshakeOk.add(false);
      }
    });

    socket.setTimeout(() => {
      socket.close();
    }, SESSION_SECONDS * 1000);
  });

  check(response, { "handshake 101": (r) => r && r.status === 101 });

  // Recorded AFTER the socket closes, so a session that never subscribed counts
  // as a failure rather than vanishing from the metric. Silence is not success.
  subscribeOk.add(subscribed);

  const elapsed = (Date.now() - openedAt) / 1000;
  if (elapsed > 1) {
    framesPerSecond.add(positions / elapsed);
  }

  // A short pause so connections churn rather than every VU reconnecting in
  // lockstep, which would measure a thundering herd instead of steady state.
  sleep(1 + Math.random() * 2);
}
