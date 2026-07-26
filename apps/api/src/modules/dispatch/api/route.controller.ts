import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { z } from "zod";

import { zodBody } from "../../../shared/http/index.js";
import { CurrentPrincipal, RequirePermissions } from "../../identity/index.js";
import type { Principal } from "../../identity/application/token.service.js";
import { RouteService } from "../application/route.service.js";
import type { DispatchContext, ManifestView, OptimizeResult, RoutePlan } from "../application/route.service.js";
import { AssignmentService } from "../application/assignment.service.js";
import type { ScoredDriver } from "../application/assignment.service.js";
import type { Route } from "../domain/schema.js";
import {
  addStopsSchema,
  cancelRouteSchema,
  createRouteSchema,
  removeStopsSchema,
  suggestDriversSchema,
} from "../domain/dtos.js";

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).optional(),
  status: z.enum(["DRAFT", "OPTIMIZING", "PUBLISHED", "IN_PROGRESS", "COMPLETED", "CANCELLED"]).optional(),
  driverId: z.string().min(1).optional(),
  plannedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
});

interface RouteResponse {
  readonly id: string;
  readonly code: string;
  readonly driverId: string | null;
  readonly vehicleId: string | null;
  readonly startHubId: string | null;
  readonly endHubId: string | null;
  readonly plannedDate: string;
  readonly status: string;
  readonly plannedStartAt: string | null;
  readonly plannedEndAt: string | null;
  readonly actualStartAt: string | null;
  readonly actualEndAt: string | null;
  readonly plannedDistanceM: number | null;
  readonly plannedDurationS: number | null;
  readonly actualDistanceM: number | null;
  readonly actualDurationS: number | null;
  readonly stopCount: number;
  readonly optimizationJobId: string | null;
  readonly publishedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface PageResponse<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

function dispatchCtx(principal: Principal): DispatchContext {
  return {
    actor: { actorType: "DISPATCHER", actorId: principal.userId },
  };
}

@Controller("v1/routes")
export class RouteController {
  constructor(
    private readonly routes: RouteService,
    private readonly assignments: AssignmentService,
  ) {}

  @Post()
  @RequirePermissions("route:create")
  async create(
    @Body(zodBody(createRouteSchema)) body: z.infer<typeof createRouteSchema>,
  ): Promise<RouteResponse> {
    const route = await this.routes.create(body);
    return toResponse(route);
  }

  @Get()
  @RequirePermissions("route:read")
  async list(@Query() query: unknown): Promise<PageResponse<RouteResponse>> {
    const parsed = listQuerySchema.parse(query);
    const page = await this.routes.list({
      ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
      ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
      ...(parsed.status === undefined ? {} : { status: parsed.status }),
      ...(parsed.driverId === undefined ? {} : { driverId: parsed.driverId }),
      ...(parsed.plannedDate === undefined ? {} : { plannedDate: parsed.plannedDate }),
    });
    return {
      data: page.items.map(toResponse),
      page: { nextCursor: page.nextCursor, hasMore: page.nextCursor !== null },
    };
  }

  @Get(":id")
  @RequirePermissions("route:read")
  async getById(@Param("id") id: string): Promise<RouteResponse> {
    const route = await this.routes.getById(id);
    return toResponse(route);
  }

  @Get(":id/manifest")
  @RequirePermissions("route:read")
  async getManifest(@Param("id") id: string): Promise<ManifestView> {
    return this.routes.getManifest(id);
  }

  @Post(":id/stops")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("route:create")
  async addStops(
    @Param("id") id: string,
    @Body(zodBody(addStopsSchema)) body: z.infer<typeof addStopsSchema>,
  ): Promise<RoutePlan> {
    return this.routes.addStops(id, body);
  }

  @Post(":id/stops/remove")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("route:create")
  async removeStops(
    @Param("id") id: string,
    @Body(zodBody(removeStopsSchema)) body: z.infer<typeof removeStopsSchema>,
  ): Promise<RoutePlan> {
    return this.routes.removeStops(id, body);
  }

  @Post(":id/optimize")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("route:optimize")
  async optimize(
    @Param("id") id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<OptimizeResult> {
    return this.routes.optimize(id, dispatchCtx(principal));
  }

  @Post(":id/publish")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("route:publish")
  async publish(
    @Param("id") id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<RouteResponse> {
    const route = await this.routes.publish(id, dispatchCtx(principal));
    return toResponse(route);
  }

  @Post(":id/start")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("route:publish")
  async start(
    @Param("id") id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<RouteResponse> {
    const route = await this.routes.start(id, dispatchCtx(principal));
    return toResponse(route);
  }

  @Post(":id/complete")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("route:publish")
  async complete(@Param("id") id: string): Promise<RouteResponse> {
    const route = await this.routes.complete(id);
    return toResponse(route);
  }

  @Post(":id/cancel")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("route:publish")
  async cancel(
    @Param("id") id: string,
    @Body(zodBody(cancelRouteSchema)) body: z.infer<typeof cancelRouteSchema>,
  ): Promise<RouteResponse> {
    const route = await this.routes.cancel(id, body);
    return toResponse(route);
  }

  @Post("suggest-drivers")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("route:create")
  async suggestDrivers(
    @Body(zodBody(suggestDriversSchema)) body: z.infer<typeof suggestDriversSchema>,
  ): Promise<{ data: readonly ScoredDriver[] }> {
    const scored = await this.assignments.suggestDrivers(body);
    return { data: scored };
  }
}

function toResponse(r: Route): RouteResponse {
  return {
    id: r.id,
    code: r.code,
    driverId: r.driverId,
    vehicleId: r.vehicleId,
    startHubId: r.startHubId,
    endHubId: r.endHubId,
    plannedDate: r.plannedDate,
    status: r.status,
    plannedStartAt: r.plannedStartAt?.toISOString() ?? null,
    plannedEndAt: r.plannedEndAt?.toISOString() ?? null,
    actualStartAt: r.actualStartAt?.toISOString() ?? null,
    actualEndAt: r.actualEndAt?.toISOString() ?? null,
    plannedDistanceM: r.plannedDistanceM,
    plannedDurationS: r.plannedDurationS,
    actualDistanceM: r.actualDistanceM,
    actualDurationS: r.actualDurationS,
    stopCount: r.stopCount,
    optimizationJobId: r.optimizationJobId,
    publishedAt: r.publishedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}
