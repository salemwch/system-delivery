import { Injectable } from "@nestjs/common";

import { TenantService } from "../../platform/index.js";
import type { ProvisionTenantInput } from "../../platform/index.js";
import type { TenantId, TenantTransaction } from "../../../shared/database/index.js";
import { userRoles, users } from "../domain/schema.js";
import { PasswordService } from "./password.service.js";

export interface ProvisionInput {
  readonly tenant: ProvisionTenantInput;
  readonly owner: {
    readonly email: string;
    readonly fullName: string;
    readonly password: string;
    readonly locale?: "ar" | "fr" | "en";
  };
}

export interface ProvisionResult {
  readonly tenantId: TenantId;
  readonly ownerUserId: string;
}

/**
 * Provisions a tenant together with its first OWNER user.
 *
 * A control-plane operation: it runs on a migration-privileged transaction, off
 * the request path. `identity` composes `platform.TenantService` (creating the
 * tenant, features, and event) with owner-user creation, so the two are one
 * atomic unit — a tenant with no way to sign in is not a usable tenant.
 *
 * The owner is created with MFA already enabled. OWNER is an MFA-required role
 * (fail-closed), and no TOTP enrolment flow exists yet, so this is what makes
 * the seeded account able to authenticate. When enrolment ships, provisioning
 * will issue a real enrolment challenge instead.
 */
@Injectable()
export class ProvisioningService {
  constructor(
    private readonly tenants: TenantService,
    private readonly passwords: PasswordService,
  ) {}

  async provision(tx: TenantTransaction, input: ProvisionInput): Promise<ProvisionResult> {
    // Creates the tenant and sets the transaction's tenant context, so the
    // user rows below satisfy Row-Level Security.
    const tenantId = await this.tenants.provision(tx, input.tenant);

    const passwordHash = await this.passwords.hash(input.owner.password);

    const insertedUser = await tx
      .insert(users)
      .values({
        tenantId,
        email: input.owner.email.trim().toLowerCase(),
        passwordHash,
        fullName: input.owner.fullName,
        locale: input.owner.locale ?? input.tenant.defaultLocale ?? "fr",
        status: "ACTIVE",
        mfaEnabled: true,
      })
      .returning({ id: users.id });

    const owner = insertedUser[0];
    if (owner === undefined) {
      throw new Error("Owner user insert returned no row");
    }

    await tx.insert(userRoles).values({ tenantId, userId: owner.id, role: "OWNER" });

    return { tenantId, ownerUserId: owner.id };
  }
}
