import type { QueuedBatch, TelemetryStore, WirePosition } from "../src/core/telemetry";

/**
 * The reference semantics of {@link TelemetryStore}, in memory. The SQLite
 * store on the device implements the same contract (a sealed batch is reused
 * until removed; one shift per batch; oldest first).
 */
export class MemoryTelemetryStore implements TelemetryStore {
  private rows: { seq: number; shiftId: string; position: WirePosition; batchId: string | null }[] =
    [];
  private seq = 0;

  append(shiftId: string, positions: readonly WirePosition[]): Promise<void> {
    for (const position of positions) {
      this.rows.push({ seq: (this.seq += 1), shiftId, position, batchId: null });
    }
    return Promise.resolve();
  }

  nextBatch(max: number, newBatchId: string): Promise<QueuedBatch | null> {
    const sealed = this.rows.find((row) => row.batchId !== null);
    if (sealed !== undefined && sealed.batchId !== null) {
      const batchId = sealed.batchId;
      const rows = this.rows.filter((row) => row.batchId === batchId);
      return Promise.resolve({
        batchId,
        shiftId: sealed.shiftId,
        positions: rows.map((r) => r.position),
      });
    }
    const first = this.rows[0];
    if (first === undefined) {
      return Promise.resolve(null);
    }
    const rows = this.rows.filter((row) => row.shiftId === first.shiftId).slice(0, max);
    for (const row of rows) {
      row.batchId = newBatchId;
    }
    return Promise.resolve({
      batchId: newBatchId,
      shiftId: first.shiftId,
      positions: rows.map((r) => r.position),
    });
  }

  remove(batchId: string): Promise<void> {
    this.rows = this.rows.filter((row) => row.batchId !== batchId);
    return Promise.resolve();
  }

  depth(): Promise<number> {
    return Promise.resolve(this.rows.length);
  }

  oldestAt(): Promise<number | null> {
    const first = this.rows[0];
    return Promise.resolve(first === undefined ? null : Date.parse(first.position.t));
  }
}
