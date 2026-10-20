import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ApiError } from "../core/api";
import { requestCode, tenantBySlug, verifyCode } from "../core/endpoints";
import { fill, toE164 } from "../core/i18n";
import { permissions } from "../platform/device";
import { deviceId } from "../platform/secure";
import { disclosureDeclined } from "../services/onboarding";
import { api } from "../services/runtime";
import { useI18n } from "../ui/i18n-context";
import { Banner, Button, Field, Icon } from "../ui/kit";
import { colors, radius, space, type } from "../ui/theme";

type Step =
  | { readonly kind: "phone" }
  | { readonly kind: "code"; readonly tenantId: string; readonly phone: string };

/**
 * Driver sign-in by phone (docs/01 1.4): courier code → phone → SMS code.
 *
 * The server answers a code request identically whether or not the number is
 * a driver (no enumeration oracle), so this screen never says "unknown
 * number": a wrong number simply never receives a code.
 */
export default function SignIn() {
  const { t } = useI18n();
  const [step, setStep] = useState<Step>({ kind: "phone" });
  const [courier, setCourier] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const explain = (failure: unknown): string => {
    if (failure instanceof ApiError) {
      if (failure.transient) return t.offline;
      if (failure.status === 404) return t.unknownCourier;
      if (failure.status === 401) return t.wrongCode;
    }
    return t.tryAgain;
  };

  const sendCode = async () => {
    const e164 = toE164(phone);
    if (courier.trim() === "" || e164 === null) {
      setError(t.tryAgain);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const client = await api();
      const tenant = await tenantBySlug(client, courier.trim().toLowerCase());
      await requestCode(client, tenant.id, e164);
      setStep({ kind: "code", tenantId: tenant.id, phone: e164 });
    } catch (failure) {
      setError(explain(failure));
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    if (step.kind !== "code" || !/^\d{6}$/u.test(code.trim())) {
      setError(t.wrongCode);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const client = await api();
      const session = await verifyCode(
        client,
        step.tenantId,
        step.phone,
        code.trim(),
        await deviceId(),
      );
      if (!session.user.roles.includes("DRIVER")) {
        // A staff login has no place in the driver app; keep no session for it.
        setError(t.tryAgain);
        return;
      }
      await client.adopt(session);
      const granted = await permissions();
      router.replace(
        granted.background || (await disclosureDeclined()) ? "/(tabs)" : "/disclosure",
      );
    } catch (failure) {
      setError(explain(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={si.root}>
      <LinearGradient colors={[colors.brand, colors.brandDark]} style={si.hero}>
        <SafeAreaView edges={["top"]} style={si.heroInner}>
          <View style={si.logo}>
            <Icon name="truck-delivery" size={34} color={colors.brand} />
          </View>
          <Text style={si.heroTitle}>{t.signInTitle}</Text>
          <Text style={si.heroBody}>{t.signInSubtitle}</Text>
        </SafeAreaView>
      </LinearGradient>
      <KeyboardAvoidingView behavior="height" style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={si.form} keyboardShouldPersistTaps="handled">
          {step.kind === "phone" ? (
            <>
              <Field
                label={t.courierCode}
                value={courier}
                onChangeText={setCourier}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="next"
              />
              <Field
                label={t.phone}
                value={phone}
                onChangeText={setPhone}
                keyboardType="phone-pad"
                autoComplete="tel"
                placeholder="24 201 314"
              />
              <Button
                label={t.sendCode}
                icon="message-processing-outline"
                onPress={() => void sendCode()}
                busy={busy}
              />
            </>
          ) : (
            <>
              <Text style={type.body}>{fill(t.codeSentTo, { phone: step.phone })}</Text>
              <Field
                label={t.code}
                value={code}
                onChangeText={setCode}
                keyboardType="number-pad"
                autoComplete="sms-otp"
                textContentType="oneTimeCode"
                maxLength={6}
                style={[si.code]}
                autoFocus
              />
              <Button label={t.signIn} icon="login" onPress={() => void verify()} busy={busy} />
              <Button
                label={t.changeNumber}
                variant="ghost"
                onPress={() => {
                  setCode("");
                  setError(null);
                  setStep({ kind: "phone" });
                }}
              />
            </>
          )}
          {error === null ? null : (
            <Banner tone="danger" icon="alert-circle-outline" text={error} />
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const si = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  hero: { borderBottomStartRadius: radius.lg * 1.5, borderBottomEndRadius: radius.lg * 1.5 },
  heroInner: {
    paddingHorizontal: space.xl,
    paddingTop: space.xl,
    paddingBottom: space.xxl,
    gap: space.sm,
  },
  logo: {
    width: 64,
    height: 64,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: space.md,
  },
  heroTitle: { color: colors.surface, fontSize: 30, fontWeight: "800" },
  heroBody: { color: "rgba(255,255,255,0.85)", fontSize: 16 },
  form: { padding: space.xl, gap: space.lg },
  code: {
    minHeight: 64,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    color: colors.ink,
    fontSize: 28,
    letterSpacing: 10,
    textAlign: "center",
    fontWeight: "700",
  },
});
