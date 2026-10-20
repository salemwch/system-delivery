import { router } from "expo-router";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useI18n } from "./i18n-context";
import { Icon } from "./kit";
import { colors, radius, space, type } from "./theme";

/** A pushed screen's header: back (mirrored in Arabic), the title, an optional action. */
export function BackHeader({
  title,
  action,
}: {
  readonly title: string;
  readonly action?: ReactNode;
}) {
  const { t, rtl } = useI18n();
  return (
    <View style={bh.header}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t.back}
        onPress={() => router.back()}
        style={bh.back}
      >
        <Icon name={rtl ? "arrow-right" : "arrow-left"} />
      </Pressable>
      <Text style={[type.heading, { flex: 1 }]} numberOfLines={1}>
        {title}
      </Text>
      {action}
    </View>
  );
}

const bh = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: space.md },
  back: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
});
