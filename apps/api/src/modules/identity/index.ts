export { IdentityModule } from "./identity.module.js";
export { AuthService } from "./application/auth.service.js";
export { AccessService } from "./application/access.service.js";
export { PasswordService } from "./application/password.service.js";
export { TokenService } from "./application/token.service.js";
export {
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  MFA_REQUIRED_ROLES,
  permissionsForRoles,
  isPermission,
} from "./domain/permissions.js";
export type { Permission, Role } from "./domain/permissions.js";
export type { Principal } from "./application/token.service.js";
export type {
  AuthResult,
  AuthSession,
  LoginRequest,
  AuthFailureReason,
} from "./application/auth.service.js";
export {
  Public,
  RequirePermissions,
  CurrentPrincipal,
  IS_PUBLIC_KEY,
  REQUIRED_PERMISSIONS_KEY,
} from "./api/request-context.js";
export type { AuthenticatedRequest } from "./api/request-context.js";
