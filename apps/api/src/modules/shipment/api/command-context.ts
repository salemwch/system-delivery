import type { Principal } from "../../identity/index.js";
import type { CommandContext } from "../application/shipment.service.js";

/**
 * The command context of an authenticated caller.
 *
 * ⚠️ The actor type comes from the signed ROLE claim, never from how the user
 * signed in. It used to read `principal.actorType`, which is "driver" only for
 * a phone-code (OTP) session. A DRIVER-role account that signed in with a
 * password became a "DISPATCHER" actor, and the return-closing rule treated an
 * unlinked one as staff at a counter (audit finding F1). Login channel is a
 * fact about the session, not about who the caller is.
 */
export function commandContextOf(
  principal: Pick<Principal, "userId" | "roles" | "permissions">,
): CommandContext {
  return {
    actor: {
      actorType: principal.roles.includes("DRIVER") ? "DRIVER" : "DISPATCHER",
      actorId: principal.userId,
    },
    canOverride: principal.permissions.has("shipment:override_status"),
  };
}
