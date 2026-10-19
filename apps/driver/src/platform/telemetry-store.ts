import { wirePositionSchema } from "../core/telemetry";
import type { QueuedBatch, TelemetryStore, WirePosition } from "../core/telemetry";
import { database } from "./database";

/**
 * The telemetry queue in SQLCipher, implementing the contract the core relies
 * on (test/memory-store.ts is the reference): a sealed batch is reused until
 * removed, one shift per batch, oldest first. Sealing is one UPDATE inside a
 * transaction, so a batch is never half-formed if the process is killed.
 */
export const sqliteTelemetryStore: TelemetryStore = {
  async append(shiftId: string, positions: readonly WirePosition[]): Promise<void> {
    if (positions.length === 0) return;
    const db = await database();
    await db.transaction(async (tx) => {
      for (const position of positions) {
        await tx.execute("INSERT INTO positions (shift_id, t, t_ms, body) VALUES (?, ?, ?, ?)", [
          shiftId,
          position.t,
          Date.parse(position.t),
          JSON.stringify(position),
        ]);
      }
    });
  },

  async nextBatch(max: number, newBatchId: string): Promise<QueuedBatch | null> {
    const db = await database();
    // Set inside the transaction; a holder, so the type survives the callback.
    const sealed: { batchId: string | null } = { batchId: null };
    await db.transaction(async (tx) => {
      const open = await tx.execute(
        "SELECT batch_id FROM positions WHERE batch_id IS NOT NULL ORDER BY seq LIMIT 1",
      );
      const existing = open.rows[0]?.["batch_id"];
      if (typeof existing === "string") {
        sealed.batchId = existing;
        return;
      }
      const first = await tx.execute("SELECT shift_id FROM positions ORDER BY seq LIMIT 1");
      const shiftId = first.rows[0]?.["shift_id"];
      if (typeof shiftId !== "string") {
        return;
      }
      await tx.execute(
        `UPDATE positions SET batch_id = ?
          WHERE seq IN (SELECT seq FROM positions WHERE shift_id = ? AND batch_id IS NULL
                         ORDER BY seq LIMIT ?)`,
        [newBatchId, shiftId, max],
      );
      sealed.batchId = newBatchId;
    });
    const batchId = sealed.batchId;
    if (batchId === null) {
      return null;
    }
    const rows = await db.execute(
      "SELECT shift_id, body FROM positions WHERE batch_id = ? ORDER BY seq",
      [batchId],
    );
    const shiftId = rows.rows[0]?.["shift_id"];
    if (typeof shiftId !== "string") {
      return null;
    }
    const positions: WirePosition[] = [];
    for (const row of rows.rows) {
      const body = row["body"];
      const parsed = typeof body === "string" ? wirePositionSchema.safeParse(safeJson(body)) : null;
      if (parsed?.success === true) {
        positions.push(parsed.data);
      }
    }
    return { batchId, shiftId, positions };
  },

  async remove(batchId: string): Promise<void> {
    const db = await database();
    await db.execute("DELETE FROM positions WHERE batch_id = ?", [batchId]);
  },

  async depth(): Promise<number> {
    const db = await database();
    const result = await db.execute("SELECT COUNT(*) AS n FROM positions");
    return Number(result.rows[0]?.["n"] ?? 0);
  },

  async oldestAt(): Promise<number | null> {
    const db = await database();
    const result = await db.execute("SELECT MIN(t_ms) AS t FROM positions");
    const value = result.rows[0]?.["t"];
    return typeof value === "number" ? value : null;
  },
};

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
