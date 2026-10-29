import * as Location from "expo-location";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { dayStops, nextStop } from "../../core/manifest";
import type { StopView } from "../../core/manifest";
import { syncNow, useField } from "../../services/field";
import { useI18n } from "../../ui/i18n-context";
import { Banner, Button, EmptyState, Icon } from "../../ui/kit";
import { StopCard } from "../../ui/stop-card";
import { colors, radius, space, type } from "../../ui/theme";

type Filter = "todo" | "done" | "all";

/**
 * Every stop of the day in route order. "To do" is the default: what is left
 * is what matters; done stops are one tap away. Pull to refresh syncs.
 */
export default function Stops() {
  const { t } = useI18n();
  const field = useField();
  const [filter, setFilter] = useState<Filter>("todo");
  const [reordered, setReordered] = useState(false);
  const [driverPos, setDriverPos] = useState<{ latitude: number; longitude: number } | null>(null);
  const all = dayStops(field.manifests, field.pending);
  const next = nextStop(field.manifests, field.pending);
  const smartReorder = field.features["DRIVER_SMART_REORDER_ENABLED"] === true;

  useEffect(() => {
    void Location.getLastKnownPositionAsync().then((loc) => {
      if (loc !== null)
        setDriverPos({ latitude: loc.coords.latitude, longitude: loc.coords.longitude });
    });
  }, []);

  const sorted = (() => {
    if (!reordered || !smartReorder) return all;
    const open = all.filter((s) => s.open);
    const failed = all.filter((s) => s.open && s.parcels.every((p) => p.state === "FAILED"));
    const nonFailed = open.filter((s) => !s.parcels.every((p) => p.state === "FAILED"));
    const closed = all.filter((s) => !s.open);
    return [...nonFailed, ...failed, ...closed];
  })();

  const shown = sorted.filter((s) =>
    filter === "all" ? true : filter === "todo" ? s.open : !s.open,
  );
  const counts: Record<Filter, number> = {
    todo: all.filter((s) => s.open).length,
    done: all.filter((s) => !s.open).length,
    all: all.length,
  };
  const hasFailed = all.some((s) => s.open && s.parcels.every((p) => p.state === "FAILED"));

  return (
    <SafeAreaView style={st.root} edges={["top"]}>
      <View style={st.header}>
        <Text style={type.title}>{t.tabStops}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t.scanParcel}
          onPress={() => router.push({ pathname: "/scan", params: { mode: "find" } })}
          style={st.scan}
        >
          <Icon name="barcode-scan" color={colors.brand} />
        </Pressable>
      </View>
      <View style={st.segment}>
        {(["todo", "done", "all"] as const).map((key) => (
          <Pressable
            key={key}
            accessibilityRole="tab"
            accessibilityState={{ selected: filter === key }}
            onPress={() => setFilter(key)}
            style={[st.segmentItem, filter === key && st.segmentActive]}
          >
            <Text style={[st.segmentText, filter === key && { color: colors.surface }]}>
              {key === "todo" ? t.filterTodo : key === "done" ? t.filterDone : t.filterAll} ·{" "}
              {counts[key]}
            </Text>
          </Pressable>
        ))}
      </View>
      {smartReorder && hasFailed && !reordered ? (
        <View style={{ paddingHorizontal: space.xl }}>
          <Button
            label={t.reorderStops}
            icon="sort-variant"
            variant="secondary"
            compact
            onPress={() => setReordered(true)}
          />
        </View>
      ) : null}
      {reordered ? (
        <View style={{ paddingHorizontal: space.xl }}>
          <Banner tone="info" icon="check-circle-outline" text={t.reorderDone} />
        </View>
      ) : null}
      <FlatList<StopView>
        data={shown}
        keyExtractor={(s) => s.stop.id}
        contentContainerStyle={st.list}
        refreshControl={
          <RefreshControl
            refreshing={field.syncing}
            onRefresh={() => void syncNow().catch(() => undefined)}
            colors={[colors.brand]}
          />
        }
        renderItem={({ item }) => (
          <StopCard
            view={item}
            highlight={item.stop.id === next?.stop.id}
            driverPosition={driverPos}
            onPress={() => router.push({ pathname: "/stop/[id]", params: { id: item.stop.id } })}
          />
        )}
        ListEmptyComponent={
          <EmptyState
            icon={
              filter === "todo" && all.length > 0
                ? "check-decagram-outline"
                : "map-marker-off-outline"
            }
            title={filter === "todo" && all.length > 0 ? t.stopsAllDone : t.stopsEmpty}
          />
        }
      />
    </SafeAreaView>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: space.xl,
    paddingTop: space.lg,
  },
  scan: {
    width: 48,
    height: 48,
    borderRadius: radius.pill,
    backgroundColor: colors.brandSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  segment: {
    flexDirection: "row",
    margin: space.xl,
    marginBottom: space.md,
    padding: 4,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
  },
  segmentItem: {
    flex: 1,
    minHeight: 40,
    borderRadius: radius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  segmentActive: { backgroundColor: colors.brand },
  segmentText: { fontSize: 14, fontWeight: "700", color: colors.text },
  list: { paddingHorizontal: space.xl, paddingBottom: space.xxl * 2, gap: space.md },
});
