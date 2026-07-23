-- Outbox trace-context propagation (docs/03-event-storming.md §2.2, docs/09-infrastructure.md §4).
--
-- An event is produced inside a request (under an active trace span), written to
-- this table, relayed to a Valkey Stream, and consumed later in ANOTHER process.
-- None of those steps is a synchronous call, so the runtime cannot link the
-- consumer's work back to the producer's trace on its own. We therefore carry the
-- W3C trace-context in the durable envelope: the producer serialises the active
-- context into `traceparent` (+ optional `tracestate`) at insert time, the relay
-- copies both onto the stream entry, and the consumer re-hydrates them to parent
-- its span. One trace then spans produce → relay → consume.
--
-- Both columns are NULLABLE by design: when tracing is disabled (no OTLP endpoint)
-- or an event is produced outside any span, there is simply no context to carry,
-- and the consumer starts a fresh root trace. Adding nullable columns is a safe,
-- online change on this hot table — no rewrite, no default backfill.
--
-- No new grants: dp_app (INSERT/UPDATE via default privileges) and dp_relay
-- (table-level SELECT/UPDATE from migration 0004) both already cover new columns.

ALTER TABLE outbox
  ADD COLUMN IF NOT EXISTS traceparent TEXT,
  ADD COLUMN IF NOT EXISTS tracestate  TEXT;

COMMENT ON COLUMN outbox.traceparent IS
  'W3C traceparent captured from the active span when the event was produced. NULL when tracing was disabled or no span was active. The relay carries it to the stream so the consumer can join the same trace.';

COMMENT ON COLUMN outbox.tracestate IS
  'Optional W3C tracestate accompanying traceparent (vendor trace state). NULL when absent.';
