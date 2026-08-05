"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import {
  ApiError,
  bootstrapMfaConfirm,
  bootstrapMfaEnrol,
  login as apiLogin,
  verifyMfa,
} from "./api";
import { toLocale } from "./i18n";
import { clearSession, writeSession } from "./session";
import type { LoginState } from "./login-state";

const loginSchema = z.object({
  email: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(200),
});

export async function signIn(
  locale: string,
  _previous: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: "invalid", fieldErrors: {} };
  }

  try {
    const result = await apiLogin(parsed.data.email, parsed.data.password);
    if (result.kind === "mfa") {
      if (result.status === "MFA_ENROLMENT_REQUIRED") {
        const enrol = await bootstrapMfaEnrol(result.challenge);
        return {
          kind: "mfa",
          status: result.status,
          challenge: result.challenge,
          uri: enrol.uri,
          secret: enrol.secret,
        };
      }
      return { kind: "mfa", status: result.status, challenge: result.challenge };
    }
    await writeSession(result.session);
  } catch (error) {
    if (error instanceof ApiError) {
      return { error: "invalid", fieldErrors: {} };
    }
    throw error;
  }

  redirect(`/${toLocale(locale)}`);
}

const mfaSchema = z.object({
  code: z.string().trim().min(6).max(8),
  challenge: z.string().min(1),
  status: z.enum(["MFA_REQUIRED", "MFA_ENROLMENT_REQUIRED"]),
});

export async function submitMfa(
  locale: string,
  _previous: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const parsed = mfaSchema.safeParse({
    code: formData.get("code"),
    challenge: formData.get("challenge"),
    status: formData.get("status"),
  });
  if (!parsed.success) {
    return { error: "invalid_code", fieldErrors: {} };
  }

  try {
    const session =
      parsed.data.status === "MFA_ENROLMENT_REQUIRED"
        ? await bootstrapMfaConfirm(parsed.data.challenge, parsed.data.code)
        : await verifyMfa(parsed.data.challenge, parsed.data.code);
    await writeSession(session);
  } catch (error) {
    if (error instanceof ApiError) {
      return { error: "invalid_code", fieldErrors: {} };
    }
    throw error;
  }

  redirect(`/${toLocale(locale)}`);
}

export async function signOut(locale: string): Promise<void> {
  await clearSession();
  redirect(`/${toLocale(locale)}/login`);
}
