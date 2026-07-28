import { Injectable } from "@nestjs/common";

import { ShipmentService } from "./shipment.service.js";
import type { CommandContext } from "./shipment.service.js";
import type { Shipment } from "../domain/schema.js";

export interface BulkItem {
  readonly input: unknown;
  readonly idempotencyKey: string;
}

interface BulkResult {
  readonly index: number;
  readonly success: boolean;
  readonly shipment: Shipment | null;
  readonly error: string | null;
  readonly code: string | null;
}

export interface BulkCreateResult {
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly results: readonly BulkResult[];
}

@Injectable()
export class BulkShipmentService {
  constructor(private readonly shipments: ShipmentService) {}

  async createBulk(items: readonly BulkItem[], ctx: CommandContext): Promise<BulkCreateResult> {
    const results: BulkResult[] = [];
    let succeeded = 0;
    let failed = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item === undefined) continue;
      try {
        const shipment = await this.shipments.create(item.input, ctx);
        results.push({ index: i, success: true, shipment, error: null, code: null });
        succeeded += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        const code = hasCode(error) ? error.code : "UNKNOWN";
        results.push({ index: i, success: false, shipment: null, error: message, code });
        failed += 1;
      }
    }

    return { total: items.length, succeeded, failed, results };
  }
}

function hasCode(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as Record<string, unknown>)["code"] === "string"
  );
}
