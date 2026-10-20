import { z } from "zod";

import type { Money } from "../core/money";
import { readMeta, writeMeta } from "../platform/database";
import { today } from "./field";

/**
 * The cash handovers this device declared today. The server's ledger is the
 * truth (the hub counts and confirms); this is the driver's own record, so the
 * wallet can say what is still in their pocket without a finance permission.
 */
const handoverSchema = z.array(
  z.object({
    code: z.string(),
    amountMinor: z.string().regex(/^\d+$/u),
    currency: z.string(),
    currencyExponent: z.number().int(),
    at: z.number(),
  }),
);
export type Handover = z.infer<typeof handoverSchema>[number];

const key = (day: string) => `cash.handovers.${day}`;

export async function handoversToday(): Promise<Handover[]> {
  const raw = await readMeta(key(today()));
  if (raw === null) return [];
  try {
    const parsed = handoverSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export async function recordHandover(code: string, money: Money): Promise<void> {
  const list = await handoversToday();
  await writeMeta(key(today()), JSON.stringify([...list, { code, ...money, at: Date.now() }]));
}
