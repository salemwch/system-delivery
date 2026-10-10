import { Injectable } from "@nestjs/common";
import type { CallHandler, ExecutionContext, NestInterceptor } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { Observable } from "rxjs";

import {
  DatabaseService,
  NO_DRIVER,
  TenantContext,
  asTenantId,
} from "../../../shared/database/index.js";
import type { Principal } from "../application/token.service.js";
import { accountManagerScope } from "../domain/permissions.js";
import type { AuthenticatedRequest } from "./request-context.js";

/** The role whose reads are narrowed to its own assignments (invariant I28). */
const DRIVER_ROLE = "DRIVER";

/**
 * A user agent is attacker-controlled and unbounded. Truncated before it is
 * stored so a client cannot inflate an append-only, seven-year table one header
 * at a time. Long enough to keep every real browser and device string intact.
 */
const MAX_USER_AGENT_LENGTH = 512;

/**
 * Binds the ambient tenant context for the duration of a request.
 *
 * Runs after AuthGuard, so the tenant comes from a VERIFIED token claim. Every
 * database call downstream reads this to set `app.current_tenant_id`, which is
 * what PostgreSQL Row-Level Security enforces against.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE MANUAL Observable WRAPPER
 *
 * The obvious implementation —
 *
 *     return TenantContext.run(state, () => next.handle());
 *
 * — is subtly broken. `next.handle()` only CREATES an Observable; the route
 * handler does not execute until something subscribes, and that subscription
 * happens after `run()` has already returned. The handler would then run with
 * no tenant context bound, and `requireTenantId()` would throw at the first
 * query.
 *
 * Wrapping the SUBSCRIPTION inside `run()` is what actually places the handler
 * (and every async continuation it spawns) inside the AsyncLocalStorage scope.
 * ─────────────────────────────────────────────────────────────────────────────
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(private readonly database: DatabaseService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = request.principal;

    // Unauthenticated (public) routes run without tenant context. Any
    // tenant-scoped query they attempt throws rather than silently returning
    // another tenant's rows — fail closed.
    if (principal === undefined) {
      return next.handle();
    }

    const managerScope = accountManagerScope(principal);

    // Spread conditionally rather than assigning `undefined`: under
    // `exactOptionalPropertyTypes` an explicit undefined is not an absent
    // property.
    const base = {
      tenantId: asTenantId(principal.tenantId),
      actorId: principal.userId,
      actorType: principal.actorType,
      // Narrows a MERCHANT login to its own rows for the whole request
      // (invariant I24). Taken from the signed token, never from the request —
      // a merchant must not be able to widen their own scope by asking.
      ...(principal.merchantId === null ? {} : { merchantId: principal.merchantId }),
      // Narrows a COMMERCIAL login to the merchants they manage (invariant
      // I25). Derived from the signed role claim rather than carried as a
      // claim of its own, so there is no separate value a tampered token could
      // put out of step with `rol`.
      ...(managerScope === null ? {} : { accountManagerId: managerScope }),
      ...(typeof request.id === "string" ? { requestId: request.id } : {}),
      // Origin of the request, carried for the audit trail. Read from Fastify's
      // own `ip`, which already honours `trustProxy` — parsing
      // `x-forwarded-for` by hand here would let a client forge its own source
      // address on any deployment that does not sit behind a trusted proxy.
      ...(typeof request.ip === "string" ? { ipAddress: request.ip } : {}),
      ...(typeof request.headers["user-agent"] === "string"
        ? { userAgent: request.headers["user-agent"].slice(0, MAX_USER_AGENT_LENGTH) }
        : {}),
    };

    return new Observable((subscriber) => {
      let teardown: (() => void) | undefined;
      let closed = false;

      // The driver scope needs one lookup, so the handler is subscribed only
      // once it is known. It must be bound before the handler runs: a handler
      // that started unscoped would read the whole tenant.
      void this.driverScopeOf(principal).then(
        (driverId) => {
          if (closed) {
            return;
          }
          const state = driverId === null ? base : { ...base, driverId };
          TenantContext.run(state, () => {
            const subscription = next.handle().subscribe({
              next: (value) => subscriber.next(value),
              error: (error: unknown) => subscriber.error(error),
              complete: () => subscriber.complete(),
            });
            teardown = () => subscription.unsubscribe();
          });
        },
        // No scope, no handler: a failed lookup must not degrade to unscoped.
        (error: unknown) => subscriber.error(error),
      );

      return () => {
        closed = true;
        teardown?.();
      };
    });
  }

  /**
   * The `drivers.id` that narrows this request (invariant I28), or null when
   * the caller does not hold the DRIVER role.
   *
   * Keyed on the signed ROLE claim, never on how the user signed in: a DRIVER
   * who used a password is still a driver. A DRIVER with no driver record
   * gets {@link NO_DRIVER}, which RLS matches against nothing. That is the case
   * that once fell through to the staff path (audit finding F1).
   *
   * Looked up per request rather than carried in the token, so unlinking a
   * driver takes effect on the next request instead of at token expiry. One
   * indexed probe (`drivers_tenant_user_uq`, 0043), only for driver sessions.
   * A raw RLS-scoped read of the fleet table, the pattern
   * `InvoiceService.partiesFor` uses, because identity must not import fleet.
   */
  private async driverScopeOf(principal: Principal): Promise<string | null> {
    if (!principal.roles.includes(DRIVER_ROLE)) {
      return null;
    }
    const rows = await this.database.withTenant(
      (tx) =>
        tx.execute<{ id: string }>(sql`select id from drivers where user_id = ${principal.userId}`),
      asTenantId(principal.tenantId),
    );
    return rows[0]?.id ?? NO_DRIVER;
  }
}
