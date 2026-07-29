import { Body, Controller, Get, HttpCode, HttpStatus, Post, Put } from "@nestjs/common";

import { RequirePermissions } from "../../identity/index.js";
import { TemplateService } from "../application/template.service.js";
import type { TemplateView } from "../application/template.service.js";

/**
 * Per-tenant, per-language notification templates (docs/01-mvp-scope.md §4.6 #6.4).
 *
 * Guarded by `feature:manage`, held only by OWNER. Message copy is what every
 * customer of the tenant reads — it carries the brand, and in a COD market it
 * carries instructions about money. That is not a dispatcher-level authority.
 */
@Controller("v1/notification-templates")
export class TemplateController {
  constructor(private readonly templates: TemplateService) {}

  /** Overrides where they exist, built-in defaults elsewhere. */
  @Get()
  @RequirePermissions("feature:manage")
  async list(): Promise<{ data: readonly TemplateView[] }> {
    return { data: await this.templates.list() };
  }

  @Put()
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("feature:manage")
  async upsert(@Body() body: unknown): Promise<TemplateView> {
    return this.templates.upsert(body);
  }

  /** Removes the override so the built-in default applies again. */
  @Post("revert")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("feature:manage")
  async revert(@Body() body: unknown): Promise<{ reverted: boolean }> {
    return this.templates.revert(body);
  }

  /**
   * Renders with sample values, so an operator sees the message BEFORE it is live.
   *
   * Also returns the SMS segment count: an Arabic body is UCS-2 at 70 characters
   * per segment, so a template that reads naturally can silently cost three
   * segments per delivery.
   */
  @Post("preview")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("feature:manage")
  async preview(@Body() body: unknown): Promise<{ body: string; estimatedSegments: number }> {
    return this.templates.preview(body);
  }
}
