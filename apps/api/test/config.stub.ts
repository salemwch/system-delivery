import type { AppConfigService } from "../src/shared/config/index.js";
import type { AppConfig } from "../src/shared/config/index.js";

/**
 * Minimal AppConfigService stub for unit-style tests.
 *
 * Typed against the real `AppConfig`, so adding a config key that a service
 * depends on surfaces here as a type error rather than as `undefined` at
 * runtime. Only the keys services actually read are provided.
 */
type StubbedKeys =
  | "JWT_ACCESS_SECRET"
  | "JWT_REFRESH_SECRET"
  | "JWT_ACCESS_TTL_SECONDS"
  | "JWT_REFRESH_TTL_DAYS"
  | "DRIVER_ACCESS_TTL_SECONDS"
  | "DRIVER_REFRESH_TTL_DAYS"
  | "TRACKING_TOKEN_SECRET"
  | "TRACKING_TOKEN_TTL_DAYS";

const DEFAULTS: Pick<AppConfig, StubbedKeys> = {
  JWT_ACCESS_SECRET: "a".repeat(48),
  JWT_REFRESH_SECRET: "r".repeat(48),
  JWT_ACCESS_TTL_SECONDS: 600,
  JWT_REFRESH_TTL_DAYS: 30,
  DRIVER_ACCESS_TTL_SECONDS: 3600,
  DRIVER_REFRESH_TTL_DAYS: 90,
  TRACKING_TOKEN_SECRET: "t".repeat(48),
  TRACKING_TOKEN_TTL_DAYS: 30,
};

export function stubConfig(
  overrides: Partial<Pick<AppConfig, StubbedKeys>> = {},
): AppConfigService {
  const values = { ...DEFAULTS, ...overrides };

  const stub = {
    get(key: StubbedKeys) {
      return values[key];
    },
    nodeEnv: "test",
    isProduction: false,
    isTest: true,
    deploymentMode: "saas",
    isSaas: true,
    isDedicated: false,
  };

  // The stub implements exactly the surface these tests exercise. A cast is
  // required because AppConfigService also holds a private Nest ConfigService,
  // which a test has no reason to construct.
  return stub as unknown as AppConfigService;
}
