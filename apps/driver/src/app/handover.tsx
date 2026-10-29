import * as Haptics from "expo-haptics";
import * as ScreenCapture from "expo-screen-capture";
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { ApiError } from "../core/api";
import { submitRemittance } from "../core/field-endpoints";
import type { Remittance } from "../core/field-endpoints";
import { fill } from "../core/i18n";
import { cashCollected, collectedParcels } from "../core/manifest";
import { GROUP_SEPARATOR, formatAmount, formatMoney, parseAmount, remaining } from "../core/money";
import type { Money } from "../core/money";
import { handoversToday, recordHandover } from "../services/cash";
import { useField } from "../services/field";
import { api, newId } from "../services/runtime";
import { BackHeader } from "../ui/back-header";
import { useI18n } from "../ui/i18n-context";
import { Banner, Button, Card, Field, Icon, Screen } from "../ui/kit";
import { colors, space, type } from "../ui/theme";

/**
 * The cash handover at the hub (docs/01 4.6): the driver declares the amount
 * counted in front of the hub agent; the hub confirms or disputes it on their
 * side, against the ledger.
 *
 * An idempotency key is minted when the screen opens and sent with every
 * attempt. The backend returns the same remittance on replay, so a retry
 * after a lost answer is safe — it never creates a second remittance.
 */
export default function Handover() {
  const { t, locale } = useI18n();
  const field = useField();
  const [handed, setHanded] = useState<Money[] | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ remittance: Remittance; exponent: number } | null>(null);
  const prefilled = useRef(false);
  const idempotencyKey = useRef(newId());

  const screenshotPrevention = field.features["DRIVER_SCREENSHOT_PREVENTION_ENABLED"] === true;
  useEffect(() => {
    if (!screenshotPrevention) return;
    void ScreenCapture.preventScreenCaptureAsync("handover");
    return () => {
      void ScreenCapture.allowScreenCaptureAsync("handover");
    };
  }, [screenshotPrevention]);

  useEffect(() => {
    void handoversToday().then((list) =>
      setHanded(
        list.map((h) => ({
          amountMinor: h.amountMinor,
          currency: h.currency,
          currencyExponent: h.currencyExponent,
        })),
      ),
    );
  }, []);

  const due =
    remaining(cashCollected(field.todayManifests, field.pending), handed ?? [])[0] ?? null;
  const hubId = field.todayManifests.find((m) => m.startHubId !== null)?.startHubId ?? null;
  const driverId = field.shift?.driverId ?? null;

  useEffect(() => {
    // Prefilled once with what is due; the driver types what they actually counted.
    if (due !== null && !prefilled.current) {
      prefilled.current = true;
      setTyped(
        formatAmount(due.amountMinor, due.currencyExponent, "en").split(GROUP_SEPARATOR).join(""),
      );
    }
  }, [due]);

  const declare = async () => {
    if (due === null || hubId === null || driverId === null) return;
    const minor = parseAmount(typed, due.currencyExponent);
    if (minor === null) return setError(t.amountInvalid);
    setBusy(true);
    setError(null);
    try {
      const remittance = await submitRemittance(await api(), {
        driverId,
        hubId,
        declaredAmountMinor: minor,
        currency: due.currency,
        shipmentIds: collectedParcels(field.todayManifests, field.pending).map(
          (p) => p.shipment.shipmentId,
        ),
        idempotencyKey: idempotencyKey.current,
      });
      await recordHandover(remittance.code, {
        amountMinor: minor,
        currency: due.currency,
        currencyExponent: due.currencyExponent,
      });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setDone({ remittance, exponent: due.currencyExponent });
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 429) {
        setError(t.needsNetwork);
      } else {
        setError(t.tryAgain);
      }
    } finally {
      setBusy(false);
    }
  };

  if (done !== null) {
    const { remittance: r } = done;
    const money = (amountMinor: string): Money => ({
      amountMinor,
      currency: r.currency,
      currencyExponent: done.exponent,
    });
    const difference = BigInt(r.declaredAmountMinor) - BigInt(r.expectedAmountMinor);
    return (
      <Screen
        edges={["top", "bottom"]}
        footer={<Button label={t.dismiss} icon="check" onPress={() => router.back()} />}
      >
        <BackHeader title={t.handoverTitle} />
        <Card style={{ alignItems: "center", paddingVertical: space.xxl }}>
          <Icon name="check-decagram" size={56} color={colors.success} />
          <Text style={type.title}>{fill(t.declared, { code: r.code })}</Text>
        </Card>
        <Card>
          <Line label={t.amountCounted} value={formatMoney(money(r.declaredAmountMinor), locale)} />
          <Line label={t.expected} value={formatMoney(money(r.expectedAmountMinor), locale)} />
          <Line
            label={t.difference}
            value={formatMoney(money(difference.toString()), locale)}
            tone={difference === 0n ? colors.success : colors.danger}
          />
        </Card>
      </Screen>
    );
  }

  const blocked = hubId === null ? t.noHub : driverId === null ? t.needsNetwork : null;

  return (
    <Screen
      edges={["top", "bottom"]}
      footer={
        <Button
          label={t.declare}
          icon="bank-transfer-in"
          variant="cash"
          busy={busy}
          disabled={due === null || blocked !== null}
          onPress={() => void declare()}
        />
      }
    >
      <BackHeader title={t.handoverTitle} />
      <Text style={type.body}>{t.handoverBody}</Text>
      {due === null ? null : (
        <Card tone="cash">
          <Text style={[type.label, { color: colors.cash }]}>{t.toHandOver.toUpperCase()}</Text>
          <Text style={ho.amount}>{formatMoney(due, locale)}</Text>
        </Card>
      )}
      <Field
        label={`${t.amountCounted} (${due?.currency ?? ""})`}
        value={typed}
        onChangeText={setTyped}
        keyboardType="decimal-pad"
        style={ho.input}
      />
      {blocked === null ? null : <Banner tone="warning" icon="alert-outline" text={blocked} />}
      {error === null ? null : <Banner tone="danger" icon="alert-circle-outline" text={error} />}
    </Screen>
  );
}

function Line({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: string;
  readonly tone?: string;
}) {
  return (
    <View style={ho.line}>
      <Text style={type.caption}>{label}</Text>
      <Text style={[type.heading, tone === undefined ? null : { color: tone }]}>{value}</Text>
    </View>
  );
}

const ho = StyleSheet.create({
  amount: { fontSize: 32, fontWeight: "800", color: colors.ink, fontVariant: ["tabular-nums"] },
  input: {
    minHeight: 64,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 14,
    backgroundColor: colors.surface,
    color: colors.ink,
    fontSize: 28,
    fontWeight: "800",
    textAlign: "center",
    fontVariant: ["tabular-nums"],
  },
  line: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    minHeight: 40,
  },
});
