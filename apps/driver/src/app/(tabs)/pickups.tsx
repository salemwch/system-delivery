import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import type { Pickup } from "../../core/field-endpoints";
import { fill } from "../../core/i18n";
import type { MessageKey } from "../../core/i18n";
import { cachedPickups, refreshPickups } from "../../services/pickups";
import { clock } from "../../ui/format";
import { useI18n } from "../../ui/i18n-context";
import { Chip, EmptyState, Icon } from "../../ui/kit";
import type { ChipTone } from "../../ui/kit";
import { colors, elevation, radius, space, type } from "../../ui/theme";

const STATUS: Readonly<Record<string, { label: MessageKey; tone: ChipTone }>> = {
  ASSIGNED: { label: "pickupASSIGNED", tone: "brand" },
  COLLECTED: { label: "pickupCOLLECTED", tone: "warning" },
  COMPLETED: { label: "pickupCOMPLETED", tone: "success" },
  CANCELLED: { label: "pickupCANCELLED", tone: "neutral" },
};
/** To collect first, then to drop at the hub, then the finished ones. */
const ORDER: Readonly<Record<string, number>> = {
  ASSIGNED: 0,
  COLLECTED: 1,
  COMPLETED: 2,
  CANCELLED: 3,
};

/** Collections assigned to this driver, soonest window first. */
export default function Pickups() {
  const { t, locale } = useI18n();
  const [list, setList] = useState<readonly Pickup[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      setList(await cachedPickups());
      const fresh = await refreshPickups();
      if (fresh !== null) setList(fresh);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load().catch(() => undefined);
    }, [load]),
  );

  const sorted = [...list].sort(
    (a, b) =>
      (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) ||
      a.requestedWindowFrom.localeCompare(b.requestedWindowFrom),
  );

  return (
    <SafeAreaView style={pk.root} edges={["top"]}>
      <Text style={[type.title, pk.title]}>{t.tabPickups}</Text>
      <FlatList
        data={sorted}
        keyExtractor={(p) => p.id}
        contentContainerStyle={pk.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void load().catch(() => undefined)}
            colors={[colors.brand]}
          />
        }
        ListEmptyComponent={<EmptyState icon="package-variant" title={t.pickupsEmpty} />}
        renderItem={({ item }) => {
          const status = STATUS[item.status];
          return (
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push({ pathname: "/pickup/[id]", params: { id: item.id } })}
              style={({ pressed }) => [pk.card, pressed && { opacity: 0.85 }]}
            >
              <View style={pk.icon}>
                <Icon name="storefront-outline" color={colors.brand} />
              </View>
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={type.heading} numberOfLines={1}>
                  {item.merchantName ?? item.contactName}
                </Text>
                <Text style={type.caption}>
                  {item.code} ·{" "}
                  {fill(t.pickupWindow, {
                    from: clock(item.requestedWindowFrom, locale),
                    to: clock(item.requestedWindowTo, locale),
                  })}
                </Text>
                <View style={pk.chips}>
                  {status === undefined ? null : (
                    <Chip tone={status.tone} label={t[status.label]} />
                  )}
                  <Chip
                    icon="package-variant"
                    label={fill(t.expectedParcels, {
                      n: item.actualParcelCount ?? item.estimatedParcelCount,
                    })}
                  />
                </View>
              </View>
              <Icon name="chevron-right" color={colors.muted} />
            </Pressable>
          );
        }}
      />
    </SafeAreaView>
  );
}

const pk = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  title: { paddingHorizontal: space.xl, paddingTop: space.lg, paddingBottom: space.md },
  list: { paddingHorizontal: space.xl, paddingBottom: space.xxl * 2, gap: space.md },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    ...elevation.card,
  },
  icon: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    backgroundColor: colors.brandSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
});
