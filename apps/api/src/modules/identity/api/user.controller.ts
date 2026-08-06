import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { z } from "zod";

import { zodBody } from "../../../shared/http/index.js";
import { UserService } from "../application/user.service.js";
import type { AdminUser, CreatedUser } from "../application/user.service.js";
import {
  createMerchantLoginSchema,
  createUserSchema,
  disableUserSchema,
  updateUserSchema,
} from "../domain/dtos.js";
import { CurrentPrincipal, RequirePermissions } from "./request-context.js";
import type { Principal } from "../application/token.service.js";

/**
 * User administration (docs/05-api-contracts.md, docs/07-security-architecture.md §4.2).
 *
 * This is where a courier's OWNER creates the merchant logins they hand out —
 * the *expéditeur* does not self-register (docs/01-mvp-scope.md §5).
 *
 * Two permissions, deliberately split: `user:read` is a directory of who has
 * access, `user:manage` mints and revokes it. Only OWNER holds the second.
 */

interface UserResponse {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly phone: string | null;
  readonly locale: string;
  readonly status: string;
  readonly mfaEnabled: boolean;
  readonly merchantId: string | null;
  readonly hubScope: readonly string[];
  readonly roles: readonly string[];
  readonly lastLoginAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface CreatedUserResponse {
  readonly user: UserResponse;
  /**
   * Present only when the server generated the password, and only on this one
   * response. It is stored as an Argon2id hash and can never be read back — if
   * it is lost, the only route back in is `POST /:id/reset-password`.
   */
  readonly temporaryPassword: string | null;
}

interface PageResponse<T> {
  readonly data: readonly T[];
  readonly page: { readonly nextCursor: string | null; readonly hasMore: boolean };
}

@Controller("v1/users")
export class UserController {
  constructor(private readonly usersService: UserService) {}

  @Post()
  @RequirePermissions("user:manage")
  async create(
    @Body(zodBody(createUserSchema)) body: z.infer<typeof createUserSchema>,
  ): Promise<CreatedUserResponse> {
    return toCreatedResponse(await this.usersService.create(body));
  }

  /**
   * Onboards an *expéditeur*: their merchant record already exists, this gives
   * them the login for it.
   *
   * Gated on `merchant:onboard`, NOT `user:manage`, so a COMMERCIAL can finish
   * the sign-up they started in the shop without also being able to mint an
   * OWNER. The role is fixed to MERCHANT in the service and the merchant must
   * be one the caller manages — enforced in the database (migration 0030).
   */
  @Post("merchant-login")
  @RequirePermissions("merchant:onboard")
  async createMerchantLogin(
    @Body(zodBody(createMerchantLoginSchema)) body: z.infer<typeof createMerchantLoginSchema>,
  ): Promise<CreatedUserResponse> {
    return toCreatedResponse(await this.usersService.createMerchantLogin(body));
  }

  @Get()
  @RequirePermissions("user:read")
  async list(@Query() query: unknown): Promise<PageResponse<UserResponse>> {
    const page = await this.usersService.list(query);
    return {
      data: page.items.map(toResponse),
      page: { nextCursor: page.nextCursor, hasMore: page.nextCursor !== null },
    };
  }

  @Get(":id")
  @RequirePermissions("user:read")
  async getById(@Param("id") id: string): Promise<UserResponse> {
    return toResponse(await this.usersService.getById(id));
  }

  @Patch(":id")
  @RequirePermissions("user:manage")
  async update(
    @Param("id") id: string,
    @Body(zodBody(updateUserSchema)) body: z.infer<typeof updateUserSchema>,
  ): Promise<UserResponse> {
    return toResponse(await this.usersService.update(id, body));
  }

  @Post(":id/disable")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("user:manage")
  async disable(
    @Param("id") id: string,
    @Body(zodBody(disableUserSchema)) body: z.infer<typeof disableUserSchema>,
    @CurrentPrincipal() principal: Principal,
  ): Promise<UserResponse> {
    return toResponse(await this.usersService.disable(id, body.reason, principal.userId));
  }

  @Post(":id/enable")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("user:manage")
  async enable(
    @Param("id") id: string,
    @CurrentPrincipal() principal: Principal,
  ): Promise<UserResponse> {
    return toResponse(await this.usersService.enable(id, principal.userId));
  }

  @Post(":id/reset-password")
  @HttpCode(HttpStatus.OK)
  @RequirePermissions("user:manage")
  async resetPassword(
    @Param("id") id: string,
    @Body() body: unknown,
    @CurrentPrincipal() principal: Principal,
  ): Promise<CreatedUserResponse> {
    return toCreatedResponse(
      await this.usersService.resetPassword(id, body ?? {}, principal.userId),
    );
  }
}

function toResponse(user: AdminUser): UserResponse {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    phone: user.phone,
    locale: user.locale,
    status: user.status,
    mfaEnabled: user.mfaEnabled,
    merchantId: user.merchantId,
    hubScope: user.hubScope,
    roles: user.roles,
    lastLoginAt: user.lastLoginAt === null ? null : user.lastLoginAt.toISOString(),
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

function toCreatedResponse(created: CreatedUser): CreatedUserResponse {
  return { user: toResponse(created.user), temporaryPassword: created.temporaryPassword };
}
