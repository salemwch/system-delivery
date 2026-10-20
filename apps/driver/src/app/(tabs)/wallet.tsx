import { LinearGradient } from "expo-linear-gradient";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { cashCollected, collectedParcels } from "../../core/manifest";
import { formatMoney, remaining } from "../../core/money";
import type { Money } from "../../core/money";
import { handoversToday } from "../../services/cash";
import type { Handover } from "../../services/cash";
import { useField } from "../../services/field";
import { clock } from "../../ui/format";
import { useI18n } from "../../ui/i18n-context";
import { Button, Card, EmptyState, Icon, ListRow, Screen, SectionTitle } from "../../ui/kit";
import { colors, radius, space, type } from "../../ui/theme";

/**
 * The cash in the driver's pocket: collected today (every COD parcel
 * delivered, sent or still queued), minus what was already declared at the
 * hub. Amounts are per currency and to the millime; nothing is rounded.
 */
export default function Wallet() {
  const { t, locale } = useI18n();
  const field = useField();
  const [handovers, setHandovers] = useState<readonly Handover[]>([]);

  useFocusEffect(
    useCallback(() => {
      void handoversToday().then(setHandovers);
    }, []),
  );

  const collected = cashCollected(field.todayManifests, field.pending);
  const handed: Money[] = handovers.map((h) => ({
    amountMinor: h.amountMinor,
    currency: h.currency,
    currencyExponent: h.currencyExponent,
  }));
  const toHand = remaining(collected, handed);
  const parcels = collectedParcels(field.todayManifests, field.pending);
  const amount = (list: readonly Money[]) =>
    list.length === 0 ? "0" : list.map((m) => formatMoney(m, locale)).join(" · ");

  return (
    <Screen
      {...(toHand.length === 0
        ? {}
        : {
            footer: (
              <Button
                label={t.handOver}
                icon="bank-transfer-in"
                variant="cash"
                onPress={() => router.push("/handover")}
              />
            ),
          })}
    >
      <Text style={type.title}>{t.walletTitle}</Text>
      <LinearGradient
        colors={["#B45309", "#92400E"]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={wl.hero}
      >
        <View style={wl.heroTop}>
          <Text style={wl.heroLabel}>{t.toHandOver.toUpperCase()}</Text>
          <Icon name="cash-multiple" color="rgba(255,255,255,0.9)" size={28} />
        </View>
        <Text style={wl.heroAmount}>{amount(toHand)}</Text>
        <View style={wl.heroRow}>
          <View>
            <Text style={wl.heroSmall}>{t.collectedToday}</Text>
            <Text style={wl.heroValue}>{amount(collected)}</Text>
          </View>
          <View>
            <Text style={wl.heroSmall}>{t.handedOver}</Text>
            <Text style={wl.heroValue}>{amount(handed)}</Text>
          </View>
        </View>
      </LinearGradient>

      {handovers.length === 0 ? null : (
        <>
          <SectionTitle>{t.handedOver}</SectionTitle>
          <Card>
            {handovers.map((h) => (
              <ListRow
                key={h.code}
                title={formatMoney(h, locale)}
                subtitle={`${h.code} · ${clock(h.at, locale)}`}
                leading={<Icon name="check-decagram" color={colors.success} />}
              />
            ))}
          </Card>
        </>
      )}

      <SectionTitle>{t.collectedParcels}</SectionTitle>
      {parcels.length === 0 ? (
        <EmptyState icon="cash-remove" title={t.walletEmpty} />
      ) : (
        <Card>
          {parcels.map((p) => (
            <ListRow
              key={p.shipment.shipmentId}
              title={p.shipment.recipientName}
              subtitle={p.shipment.trackingNumber}
              leading={
                <View style={wl.parcelIcon}>
                  <Icon
                    name={p.unsent ? "cloud-upload-outline" : "check"}
                    color={p.unsent ? colors.warning : colors.success}
                    size={20}
                  />
                </View>
              }
              trailing={
                <Text style={[type.heading, { color: colors.cash }]}>
                  {formatMoney(p.shipment.cod, locale)}
                </Text>
              }
            />
          ))}
        </Card>
      )}
    </Screen>
  );
}

const wl = StyleSheet.create({
  hero: { borderRadius: radius.lg, padding: space.xl, gap: space.md },
  heroTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  heroLabel: {
    color: "rgba(255,255,255,0.85)",
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 0.4,
  },
  heroAmount: {
    color: colors.surface,
    fontSize: 34,
    fontWeight: "800",
    fontVariant: ["tabular-nums"],
  },
  heroRow: { flexDirection: "row", gap: space.xxl },
  heroSmall: { color: "rgba(255,255,255,0.8)", fontSize: 12, fontWeight: "600" },
  heroValue: {
    color: colors.surface,
    fontSize: 16,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  parcelIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.pill,
    backgroundColor: colors.canvas,
    alignItems: "center",
    justifyContent: "center",
  },
});
