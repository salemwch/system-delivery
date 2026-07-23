// AppConfigModule is deliberately NOT re-exported here. Its `@Module` decorator
// evaluates `NestConfigModule.forRoot({ validate })`, which validates the
// environment SYNCHRONOUSLY at module-evaluation time. Re-exporting it would run
// that validation the moment anything imports `AppConfigService` from this
// barrel — including tests, which stub config and have no real environment — and
// throw. Validation belongs at app bootstrap, so the composition roots import
// AppConfigModule directly from ./config.module.js.
export { AppConfigService } from "./config.service.js";
export { DeploymentMode, validateConfig, configSchema } from "./config.schema.js";
export type { AppConfig, NodeEnv } from "./config.schema.js";
