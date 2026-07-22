import { Injectable } from "@nestjs/common";
import type { CallHandler, ExecutionContext, NestInterceptor } from "@nestjs/common";
import { Observable } from "rxjs";

import { TenantContext, asTenantId } from "../../../shared/database/index.js";
import type { AuthenticatedRequest } from "./request-context.js";

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
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = request.principal;

    // Unauthenticated (public) routes run without tenant context. Any
    // tenant-scoped query they attempt throws rather than silently returning
    // another tenant's rows — fail closed.
    if (principal === undefined) {
      return next.handle();
    }

    // Spread conditionally rather than assigning `undefined`: under
    // `exactOptionalPropertyTypes` an explicit undefined is not an absent
    // property.
    const state = {
      tenantId: asTenantId(principal.tenantId),
      actorId: principal.userId,
      actorType: principal.actorType,
      ...(typeof request.id === "string" ? { requestId: request.id } : {}),
    };

    return new Observable((subscriber) => {
      let teardown: (() => void) | undefined;

      TenantContext.run(state, () => {
        const subscription = next.handle().subscribe({
          next: (value) => subscriber.next(value),
          error: (error: unknown) => subscriber.error(error),
          complete: () => subscriber.complete(),
        });
        teardown = () => subscription.unsubscribe();
      });

      return () => teardown?.();
    });
  }
}
