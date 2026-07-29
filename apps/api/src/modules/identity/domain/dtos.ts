import { z } from "zod";

import { ROLES } from "./permissions.js";

/**
 * Validated input contracts for user administration (docs/05-api-contracts.md).
 *
 * Every object is strict — unknown keys are rejected, never silently stripped
 * (docs/07-security-architecture.md §4.5). On an endpoint that mints logins,
 * silently ignoring an unexpected key is how a caller believes they set a
 * restriction that was never applied.
 */

/** E.164: a leading '+' and 7–15 digits. */
const e164 = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{6,14}$/u, "must be an E.164 phone number, e.g. +21620123456");

const locale = z.enum(["ar", "fr", "en"]);

/**
 * OWASP Password Storage / Authentication guidance: length is the control that
 * matters, composition rules are not. 12 is the floor for a human-chosen
 * password; generated ones carry 144 bits regardless.
 */
const MIN_PASSWORD_LENGTH = 12;

/**
 * Argon2id has no practical input limit, but an unbounded password is a cheap
 * CPU-exhaustion vector — every login attempt would hash it.
 */
const MAX_PASSWORD_LENGTH = 512;

const password = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `must be at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(MAX_PASSWORD_LENGTH);

const roleName = z.enum(ROLES);

export const createUserSchema = z
  .strictObject({
    email: z.email().max(254).trim().toLowerCase(),
    fullName: z.string().trim().min(1, "fullName is required").max(200),
    phone: e164.optional(),
    locale: locale.optional(),
    /**
     * Optional on purpose. Omitting it makes the server generate one and return
     * it exactly once, which is the safer default: an administrator typing a
     * password for someone else tends to reuse a memorable one across accounts.
     */
    password: password.optional(),
    roles: z.array(roleName).min(1, "at least one role is required"),
    /** Required for MERCHANT, forbidden for every other role (invariant I23). */
    merchantId: z.uuid().optional(),
    /** Restricts a DISPATCHER or HUB_OPERATOR to specific hubs. Empty = all. */
    hubScope: z.array(z.uuid()).max(100).optional(),
  })
  .superRefine((value, ctx) => {
    const unique = new Set(value.roles);
    if (unique.size !== value.roles.length) {
      ctx.addIssue({ code: "custom", path: ["roles"], message: "roles must be unique" });
    }

    // Cross-tenant support access is granted by the platform operator out of
    // band, never by a tenant administrator through the tenant's own API — a
    // tenant that could mint one could reach every other tenant.
    if (unique.has("PLATFORM_ADMIN")) {
      ctx.addIssue({
        code: "custom",
        path: ["roles"],
        message: "PLATFORM_ADMIN cannot be granted through this endpoint",
      });
    }

    const isMerchant = unique.has("MERCHANT");

    // Invariant I23, checked here so the caller gets a field-level 422 instead
    // of a deferred constraint-trigger failure at COMMIT. The database enforces
    // it too (migration 0019) — this is the readable half, not the trusted one.
    if (isMerchant && value.merchantId === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["merchantId"],
        message: "merchantId is required for the MERCHANT role (invariant I23)",
      });
    }
    if (!isMerchant && value.merchantId !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["merchantId"],
        message: "merchantId is only valid for the MERCHANT role (invariant I23)",
      });
    }

    // MERCHANT is scoped below the tenant; every other role sees the whole
    // tenant. Combining them yields an account whose courier-side permissions
    // silently return almost nothing, which reads as data loss rather than as a
    // misconfiguration.
    if (isMerchant && unique.size > 1) {
      ctx.addIssue({
        code: "custom",
        path: ["roles"],
        message: "MERCHANT cannot be combined with another role",
      });
    }

    if (isMerchant && value.hubScope !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["hubScope"],
        message: "hubScope is not applicable to a merchant login",
      });
    }
  });

export const updateUserSchema = z
  .strictObject({
    fullName: z.string().trim().min(1).max(200).optional(),
    phone: e164.nullable().optional(),
    locale: locale.optional(),
    hubScope: z.array(z.uuid()).max(100).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: "at least one field must be provided",
  });

export const listUsersQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.uuid().optional(),
  status: z.enum(["INVITED", "ACTIVE", "DISABLED"]).optional(),
  role: roleName.optional(),
  merchantId: z.uuid().optional(),
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

export const disableUserSchema = z.strictObject({
  reason: z.string().trim().min(1, "reason is required").max(500),
});

export const resetPasswordSchema = z.strictObject({
  /** Omit to have the server generate one and return it exactly once. */
  password: password.optional(),
});
