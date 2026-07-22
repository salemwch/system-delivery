import { Module } from "@nestjs/common";

import { FeatureService } from "./application/feature.service.js";
import { OutboxService } from "./application/outbox.service.js";
import { TenantService } from "./application/tenant.service.js";

/**
 * Platform context (docs/04-context-map.md §3.1).
 *
 * Cross-cutting mechanics only — no business rules. Layer 0: depends on nothing
 * but shared infrastructure.
 */
@Module({
  providers: [OutboxService, FeatureService, TenantService],
  exports: [OutboxService, FeatureService, TenantService],
})
export class PlatformModule {}
