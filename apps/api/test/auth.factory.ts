import { randomBytes } from "node:crypto";

import { AuthService } from "../src/modules/identity/application/auth.service.js";
import { MfaService } from "../src/modules/identity/application/mfa.service.js";
import { OtpService } from "../src/modules/identity/application/otp.service.js";
import { PasswordService } from "../src/modules/identity/application/password.service.js";
import { TokenService } from "../src/modules/identity/application/token.service.js";
import { AuditService } from "../src/modules/platform/application/audit.service.js";
import type {
  DeliveryReceipt,
  NotificationProvider,
  OutboundMessage,
} from "../src/modules/platform/domain/notification-provider.js";
import { FieldCipher } from "../src/shared/crypto/field-cipher.js";
import type { DatabaseService } from "../src/shared/database/database.service.js";
import { stubConfig } from "./config.stub.js";

/**
 * Builds the authentication stack the way the Nest container does.
 *
 * Exists so that adding a dependency to `AuthService` is a one-line change here
 * instead of an identical edit in five spec files — the churn that produced was
 * pure noise, and noisy diffs hide real ones.
 *
 * Everything is real except the SMS transport, which cannot be: the OTP has to
 * be readable by the test to be verifiable.
 */

/** Captures messages instead of sending them, so a test can read the code. */
export class CapturingNotificationProvider implements NotificationProvider {
  readonly name = "capturing";
  readonly sent: OutboundMessage[] = [];

  send(message: OutboundMessage): Promise<DeliveryReceipt> {
    this.sent.push(message);
    return Promise.resolve({
      providerMessageId: `test-${String(this.sent.length)}`,
      accepted: true,
    });
  }

  /** The 6-digit code from the most recent message to `phone`, if any. */
  lastCodeFor(phone: string): string | null {
    for (let i = this.sent.length - 1; i >= 0; i -= 1) {
      const message = this.sent[i];
      if (message?.to === phone) {
        return /\b(\d{6})\b/u.exec(message.body)?.[1] ?? null;
      }
    }
    return null;
  }

  clear(): void {
    this.sent.length = 0;
  }
}

export interface AuthStack {
  readonly auth: AuthService;
  readonly mfa: MfaService;
  readonly otp: OtpService;
  readonly tokens: TokenService;
  readonly audit: AuditService;
  readonly passwords: PasswordService;
  readonly cipher: FieldCipher;
  readonly sms: CapturingNotificationProvider;
}

/**
 * @param db a DatabaseService bound to the test database.
 * @param cipher share one with a fixture that seeds encrypted columns directly,
 *   or a fresh key is generated.
 */
export function buildAuthStack(db: DatabaseService, cipher?: FieldCipher): AuthStack {
  const passwords = new PasswordService();
  const audit = new AuditService(db);
  const fieldCipher = cipher ?? new FieldCipher(randomBytes(32));
  const sms = new CapturingNotificationProvider();
  const mfa = new MfaService(db, passwords, audit, fieldCipher);
  const otp = new OtpService(db, passwords, audit, sms);
  const tokens = new TokenService(stubConfig());

  return {
    auth: new AuthService(db, passwords, tokens, audit, mfa, otp),
    mfa,
    otp,
    tokens,
    audit,
    passwords,
    cipher: fieldCipher,
    sms,
  };
}
