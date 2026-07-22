import { Injectable } from "@nestjs/common";
import { ConfigService as NestConfigService } from "@nestjs/config";

import { DeploymentMode } from "./config.schema.js";
import type { AppConfig, NodeEnv } from "./config.schema.js";

/**
 * Typed accessor over validated configuration.
 *
 * Wrapping Nest's ConfigService gives compile-time key checking: a typo in a
 * config key becomes a build error rather than an `undefined` discovered in
 * production. Nothing in the codebase reads `process.env` directly.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: NestConfigService<AppConfig, true>) {}

  get<K extends keyof AppConfig>(key: K): AppConfig[K] {
    return this.config.get(key, { infer: true });
  }

  get nodeEnv(): NodeEnv {
    return this.get("NODE_ENV");
  }

  get isProduction(): boolean {
    return this.nodeEnv === "production";
  }

  get isTest(): boolean {
    return this.nodeEnv === "test";
  }

  get deploymentMode(): DeploymentMode {
    return this.get("DEPLOYMENT_MODE");
  }

  /**
   * True when this instance serves many courier companies.
   *
   * Gates self-serve signup, plan/billing surfaces, and platform-admin
   * tooling — none of which exist in a dedicated single-company deployment.
   */
  get isSaas(): boolean {
    return this.deploymentMode === DeploymentMode.Saas;
  }

  /** True when this instance is owned and run by a single courier company. */
  get isDedicated(): boolean {
    return this.deploymentMode === DeploymentMode.Dedicated;
  }
}
