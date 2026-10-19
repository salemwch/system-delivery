import { router } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, ScrollView, Text, TextInput } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ApiError } from "../core/api";
import { requestCode, tenantBySlug, verifyCode } from "../core/endpoints";
import { toE164 } from "../core/i18n";
import { deviceId } from "../platform/secure";
import { api } from "../services/runtime";
import { Button } from "../ui/button";
import { useI18n } from "../ui/i18n-context";
import { styles } from "../ui/theme";

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
      router.replace("/disclosure");
    } catch (failure) {
      setError(explain(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView behavior="height" style={styles.screen}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>{t.appName}</Text>
          {step.kind === "phone" ? (
            <>
              <Text style={styles.label}>{t.courierCode}</Text>
              <TextInput
                style={styles.input}
                value={courier}
                onChangeText={setCourier}
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel={t.courierCode}
              />
              <Text style={styles.label}>{t.phone}</Text>
              <TextInput
                style={styles.input}
                value={phone}
                onChangeText={setPhone}
                keyboardType="phone-pad"
                autoComplete="tel"
                accessibilityLabel={t.phone}
              />
              <Button label={t.sendCode} onPress={() => void sendCode()} busy={busy} />
            </>
          ) : (
            <>
              <Text style={styles.label}>{t.code}</Text>
              <TextInput
                style={styles.input}
                value={code}
                onChangeText={setCode}
                keyboardType="number-pad"
                autoComplete="sms-otp"
                textContentType="oneTimeCode"
                maxLength={6}
                accessibilityLabel={t.code}
              />
              <Button label={t.signIn} onPress={() => void verify()} busy={busy} />
            </>
          )}
          {error === null ? null : (
            <Text style={styles.error} accessibilityLiveRegion="polite">
              {error}
            </Text>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
