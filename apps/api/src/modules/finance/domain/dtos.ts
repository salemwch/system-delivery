import { z } from "zod";

/**
 * Finance command DTOs (docs/05-api-contracts.md). Validated at the boundary with
 * Zod in strict mode — unknown properties are rejected. Money is carried as bigint
 * minor units end-to-end (never a float), the amount + currency always paired.
 */

/** A non-negative integer amount in minor units, carried as bigint. */
const amountMinor = z
  .union([
    z.number().int().nonnegative(),
    z.string().regex(/^\d+$/u, "must be a whole amount"),
    // Idempotent under a second parse — see the note in shipment/domain/dtos.ts.
    // The controller pipe and the service both apply these schemas, and a
    // type-changing transform that cannot re-accept its own output breaks the
    // endpoint outright.
    z.bigint().nonnegative(),
  ])
  .transform((value) => BigInt(value));

const currencyCode = z
  .string()
  .trim()
  .length(3, "must be a 3-letter ISO 4217 currency code")
  .transform((value) => value.toUpperCase());

/** Driver → hub: the driver declares what they are handing over (domain §3.13). */
export const submitRemittanceSchema = z.strictObject({
  driverId: z.uuid(),
  hubId: z.uuid(),
  declaredAmountMinor: amountMinor,
  currency: currencyCode,
  /** The collections this remittance covers — informational; expected is ledger-derived. */
  shipmentIds: z.array(z.uuid()).max(1000).optional(),
  notes: z.string().trim().min(1).max(2000).optional(),
});
export type SubmitRemittanceDto = z.infer<typeof submitRemittanceSchema>;

/** Hub operator: counts the cash and confirms. Variance needs a reason (rule 3). */
export const confirmRemittanceSchema = z.strictObject({
  countedAmountMinor: amountMinor,
  varianceReason: z.string().trim().min(1).max(2000).optional(),
  notes: z.string().trim().min(1).max(2000).optional(),
});
export type ConfirmRemittanceDto = z.infer<typeof confirmRemittanceSchema>;

/** Hub operator: flags a submitted remittance for investigation instead of confirming. */
export const disputeRemittanceSchema = z.strictObject({
  reason: z.string().trim().min(1).max(2000),
});
export type DisputeRemittanceDto = z.infer<typeof disputeRemittanceSchema>;

/** An ISO date (YYYY-MM-DD), used for a settlement window. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "must be an ISO date (YYYY-MM-DD)");

/** Finance drafts a merchant settlement for a period. Gross is computed, not given. */
export const createSettlementSchema = z
  .strictObject({
    merchantId: z.uuid(),
    periodFrom: isoDate,
    periodTo: isoDate,
    currency: currencyCode,
    deliveryFeesMinor: amountMinor.optional(),
  })
  .refine((dto) => dto.periodTo >= dto.periodFrom, {
    message: "periodTo must not be before periodFrom",
    path: ["periodTo"],
  });
export type CreateSettlementDto = z.infer<typeof createSettlementSchema>;

/** Finance records a settlement as paid (the ledger posts here, not on approval). */
export const markSettlementPaidSchema = z.strictObject({
  paymentMethod: z.enum(["BANK_TRANSFER", "CHEQUE", "CASH"]),
  paymentReference: z.string().trim().min(1).max(200).optional(),
});
export type MarkSettlementPaidDto = z.infer<typeof markSettlementPaidSchema>;
