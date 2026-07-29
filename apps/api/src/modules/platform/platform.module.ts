import { Module } from "@nestjs/common";

import { ConfigController } from "./api/config.controller.js";
import { ConfigBootstrapService } from "./application/config-bootstrap.service.js";
import { FeatureService } from "./application/feature.service.js";
import { OutboxService } from "./application/outbox.service.js";
import { AuditService } from "./application/audit.service.js";
import { TenantService } from "./application/tenant.service.js";

/**
 * Platform context (docs/04-context-map.md §3.1).
 *
 * Cross-cutting mechanics only — no business rules. Layer 0: depends on nothing
 * but shared infrastructure.
 */
@Module({
  controllers: [ConfigController],
  providers: [OutboxService, FeatureService, TenantService, ConfigBootstrapService, AuditService],
  exports: [OutboxService, FeatureService, TenantService, AuditService],
})
export class PlatformModule {}
