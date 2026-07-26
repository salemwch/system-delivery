import { Controller, Get, Param, Query } from "@nestjs/common";
import { z } from "zod";

import { ForbiddenError } from "../../../shared/errors/index.js";
import { Public } from "../../identity/index.js";
import { FeatureService, TenantService } from "../../platform/index.js";
import { TrackingService } from "../application/tracking.service.js";
import type { PublicTrackingView } from "../application/tracking.service.js";

const tokenQuery = z.object({ token: z.string().min(1) });

@Controller("v1/track")
export class TrackingController {
  constructor(
    private readonly tracking: TrackingService,
    private readonly tenants: TenantService,
    private readonly features: FeatureService,
  ) {}

  @Get(":tenantSlug/:trackingNumber")
  @Public()
  async track(
    @Param("tenantSlug") slug: string,
    @Param("trackingNumber") trackingNumber: string,
    @Query() query: unknown,
  ): Promise<PublicTrackingView> {
    const { token } = tokenQuery.parse(query);

    const verified = this.tracking.verifyToken(token);
    if (verified === null) {
      throw new ForbiddenError("Invalid or expired tracking token");
    }

    if (verified.trackingNumber !== trackingNumber) {
      throw new ForbiddenError("Token does not match tracking number");
    }

    const tenantId = await this.tenants.resolveBySlug(slug);
    if (verified.tenantId !== tenantId) {
      throw new ForbiddenError("Token does not match tenant");
    }

    await this.features.requireEnabled(tenantId, "TRACKING_PAGE_ENABLED");

    return this.tracking.getPublicTracking(tenantId, trackingNumber);
  }
}
