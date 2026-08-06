import { Global, Module } from "@nestjs/common";
import { ConfigModule as NestConfigModule } from "@nestjs/config";

import { validateConfig } from "./config.schema.js";
import { AppConfigService } from "./config.service.js";

/**
 * Global configuration module.
 *
 * Validation runs once at bootstrap. `validate` throws on the first invalid
 * configuration, so the process exits before accepting traffic rather than
 * failing later on a request path.
 */
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // .env is for local development only. In every deployed environment,
      // values come from the platform's secret store — never a file on disk.
      //
      // TWO paths because `envFilePath` resolves against the process CWD, and
      // the monorepo has exactly one .env — at the root. `pnpm --filter
      // @delivery/api start:dev` runs with CWD=apps/api, found nothing, and
      // died on fifteen "expected string, received undefined" lines that read
      // like a broken .env rather than a wrong directory. Ordered nearest-first,
      // so a future per-app .env would still win.
      envFilePath: [".env", "../../.env"],
      // The ONLY sanctioned direct read of process.env in the codebase: this
      // decides whether to load a .env file at all, so it necessarily runs
      // before validated configuration exists. Every other read goes through
      // AppConfigService.
      // eslint-disable-next-line no-restricted-properties -- bootstrap ordering; see comment above
      ignoreEnvFile: process.env["NODE_ENV"] === "production",
      validate: validateConfig,
    }),
  ],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
