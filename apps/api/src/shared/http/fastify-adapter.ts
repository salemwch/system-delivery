import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { FastifyAdapter } from "@nestjs/platform-fastify";

/** Any RFC 4122 version — an upstream service may legitimately mint v4 or v7. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/** 1 MiB. Oversized payloads are refused at the transport layer, before parsing. */
const BODY_LIMIT_BYTES = 1_048_576;

/**
 * The HTTP adapter, configured once.
 *
 * Lives here rather than inline in `main.ts` so a test can mount a controller on
 * the SAME transport configuration production uses. Inline, the only place the
 * request-id rule below existed was a file no test can import — `main.ts` calls
 * `bootstrap()` at module load, so importing it starts a server — and a rule
 * nothing can exercise is a rule that breaks unnoticed.
 */
export function createFastifyAdapter(): FastifyAdapter {
  const adapter = new FastifyAdapter({
    // Reject oversized payloads at the transport layer rather than after
    // parsing (docs/07-security-architecture.md §7).
    bodyLimit: BODY_LIMIT_BYTES,
    trustProxy: true,

    /**
     * ⚠️ The request id must be a UUID, and this is load-bearing rather than
     * cosmetic.
     *
     * `TenantContextInterceptor` puts `request.id` into the tenant context and
     * `AuditService` writes it to `audit_log.correlation_id`, a **UUID**
     * column. Fastify's default generator produces `req-1`, `req-2`, … so that
     * INSERT failed with `invalid input syntax for type uuid` — and because the
     * audit row is written in the caller's transaction, the whole command
     * rolled back with it. **Every audited mutating endpoint answered 500 over
     * HTTP**: creating a user, suspending a merchant, approving a settlement.
     * Unit tests never saw it because they call services directly, with a real
     * UUID or no request id at all.
     *
     * It belongs HERE and not in the pino config, which also declares a
     * `genReqId`. On Fastify that one never decides anything: Fastify assigns
     * `request.id` itself and pino logs the value it finds, which is why the
     * logs read `req-7` while a perfectly good UUID generator sat in
     * `app.module.ts` doing nothing.
     *
     * A client-supplied `x-request-id` is honoured so a trace can be followed
     * across services, but ONLY when it is already a UUID — echoing an
     * arbitrary string back into that column is the same bug with a remote
     * trigger.
     */
    genReqId: (req: IncomingMessage) => {
      const supplied = req.headers["x-request-id"];
      return typeof supplied === "string" && UUID_PATTERN.test(supplied) ? supplied : randomUUID();
    },
  });

  // Echo the id so a caller can join its own logs to ours. A hook rather than
  // the logger's `genReqId`, which only runs when the pino module is wired —
  // this is an HTTP contract and must hold on any app built from this adapter.
  adapter.getInstance().addHook("onRequest", (request, reply, done) => {
    void reply.header("x-request-id", request.id);
    done();
  });

  return adapter;
}
