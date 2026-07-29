import { Module } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";

import { PlatformModule } from "../platform/index.js";
import { AccessService } from "./application/access.service.js";
import { AuthService } from "./application/auth.service.js";
import { PasswordService } from "./application/password.service.js";
import { ProvisioningService } from "./application/provisioning.service.js";
import { TokenService } from "./application/token.service.js";
import { MfaService } from "./application/mfa.service.js";
import { OtpService } from "./application/otp.service.js";
import { UserService } from "./application/user.service.js";
import { AuditController } from "./api/audit.controller.js";
import { MfaController } from "./api/mfa.controller.js";
import { AuthController } from "./api/auth.controller.js";
import { UserController } from "./api/user.controller.js";
import { AuthGuard } from "./api/auth.guard.js";
import { PermissionGuard } from "./api/permission.guard.js";
import { TenantContextInterceptor } from "./api/tenant-context.interceptor.js";

/**
 * Identity context (docs/04-context-map.md §3.2).
 *
 * Registers the request pipeline GLOBALLY, in this order:
 *   1. AuthGuard              — authenticate; deny by default
 *   2. PermissionGuard        — authorize against @RequirePermissions
 *   3. TenantContextInterceptor — bind tenant context for RLS
 *
 * Guards run before interceptors in Nest, so the tenant bound in step 3 always
 * comes from a token already verified in step 1.
 */
@Module({
  imports: [PlatformModule],
  controllers: [AuthController, UserController, AuditController, MfaController],
  providers: [
    PasswordService,
    TokenService,
    AuthService,
    AccessService,
    ProvisioningService,
    UserService,
    MfaService,
    OtpService,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
  ],
  exports: [PasswordService, TokenService, AuthService, AccessService, ProvisioningService],
})
export class IdentityModule {}
