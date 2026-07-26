import { Controller, Get } from "@nestjs/common";

import { RequirePermissions } from "../../identity/index.js";
import { ConfigBootstrapService } from "../application/config-bootstrap.service.js";
import type { BootstrapConfig } from "../application/config-bootstrap.service.js";

@Controller("v1/config")
export class ConfigController {
  constructor(private readonly bootstrap: ConfigBootstrapService) {}

  @Get("bootstrap")
  @RequirePermissions("shipment:read")
  async getBootstrap(): Promise<BootstrapConfig> {
    return this.bootstrap.getBootstrap();
  }
}
