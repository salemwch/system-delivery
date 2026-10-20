import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { useRef, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import type { MessageKey } from "../core/i18n";
import { markOnboarded } from "../services/onboarding";
import { useI18n } from "../ui/i18n-context";
import { Button, Icon } from "../ui/kit";
import type { IconName } from "../ui/kit";
import { colors, elevation, radius, space, type } from "../ui/theme";

interface Slide {
  readonly key: string;
  readonly icon: IconName;
  readonly badges: readonly IconName[];
  readonly gradient: readonly [string, string];
  readonly title: MessageKey;
  readonly body: MessageKey;
}

const SLIDES: readonly Slide[] = [
  {
    key: "day",
    icon: "map-marker-path",
    badges: ["truck-fast-outline", "clock-outline"],
    gradient: [colors.brand, "#14A38B"],
    title: "onb1Title",
    body: "onb1Body",
  },
  {
    key: "deliver",
    icon: "package-variant-closed-check",
    badges: ["qrcode-scan", "draw"],
    gradient: ["#0F766E", "#0E7490"],
    title: "onb2Title",
    body: "onb2Body",
  },
  {
    key: "offline",
    icon: "cloud-sync-outline",
    badges: ["wifi-off", "shield-check-outline"],
    gradient: ["#1D4ED8", "#0E7C6B"],
    title: "onb3Title",
    body: "onb3Body",
  },
];

/**
 * Three screens, once per install: what the app does for the driver, in their
 * language, before anything is asked of them. Permissions are NOT requested
 * here; each is asked just before the moment it is needed (priming), where
 * the reason is obvious.
 */
export default function Onboarding() {
  const { t } = useI18n();
  const { width } = useWindowDimensions();
  const list = useRef<FlatList<Slide>>(null);
  const [index, setIndex] = useState(0);
  const last = index === SLIDES.length - 1;

  const finish = async () => {
    await markOnboarded();
    router.replace("/sign-in");
  };

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const page = Math.round(Math.abs(e.nativeEvent.contentOffset.x) / width);
    if (page !== index) setIndex(page);
  };

  return (
    <SafeAreaView style={on.root} edges={["top", "bottom"]}>
      <View style={on.top}>
        {last ? (
          <View style={{ height: 44 }} />
        ) : (
          <Pressable accessibilityRole="button" onPress={() => void finish()} style={on.skip}>
            <Text style={[type.label, { color: colors.muted }]}>{t.onbSkip}</Text>
          </Pressable>
        )}
      </View>

      <FlatList
        ref={list}
        data={SLIDES}
        keyExtractor={(s) => s.key}
        horizontal
        pagingEnabled
        bounces={false}
        showsHorizontalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={16}
        renderItem={({ item }) => (
          <View style={[on.slide, { width }]}>
            <Illustration slide={item} />
            <View style={on.copy}>
              <Text style={[type.display, { textAlign: "center" }]}>{t[item.title]}</Text>
              <Text style={[type.body, on.body]}>{t[item.body]}</Text>
            </View>
          </View>
        )}
      />

      <View style={on.bottom}>
        <View style={on.dots}>
          {SLIDES.map((s, i) => (
            <View key={s.key} style={[on.dot, i === index && on.dotActive]} />
          ))}
        </View>
        <Button
          label={last ? t.onbStart : t.onbNext}
          icon={last ? "check" : "arrow-right"}
          onPress={() => {
            if (last) {
              void finish();
            } else {
              list.current?.scrollToIndex({ index: index + 1, animated: true });
            }
          }}
        />
      </View>
    </SafeAreaView>
  );
}

function Illustration({ slide }: { readonly slide: Slide }) {
  return (
    <View style={on.art}>
      <View style={on.halo} />
      <LinearGradient
        colors={slide.gradient}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={on.disc}
      >
        <Icon name={slide.icon} size={88} color={colors.surface} />
      </LinearGradient>
      {slide.badges.map((badge, i) => (
        <View key={badge} style={[on.badge, i === 0 ? on.badgeStart : on.badgeEnd]}>
          <Icon name={badge} size={24} color={colors.brand} />
        </View>
      ))}
    </View>
  );
}

const DISC = 200;

const on = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.surface },
  top: { flexDirection: "row", justifyContent: "flex-end", paddingHorizontal: space.lg },
  skip: { minHeight: 44, minWidth: 64, alignItems: "center", justifyContent: "center" },
  slide: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: space.xxl },
  art: { width: DISC + 80, height: DISC + 80, alignItems: "center", justifyContent: "center" },
  halo: {
    position: "absolute",
    width: DISC + 70,
    height: DISC + 70,
    borderRadius: radius.pill,
    backgroundColor: colors.brandSoft,
  },
  disc: {
    width: DISC,
    height: DISC,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    ...elevation.floating,
  },
  badge: {
    position: "absolute",
    width: 52,
    height: 52,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
    ...elevation.floating,
  },
  badgeStart: { top: 18, start: 8 },
  badgeEnd: { bottom: 22, end: 4 },
  copy: { marginTop: space.xxl, gap: space.md, maxWidth: 420 },
  body: { textAlign: "center", color: colors.muted, fontSize: 17, lineHeight: 25 },
  bottom: { paddingHorizontal: space.xl, paddingBottom: space.lg, gap: space.xl },
  dots: { flexDirection: "row", justifyContent: "center", gap: 8 },
  dot: { width: 8, height: 8, borderRadius: radius.pill, backgroundColor: colors.line },
  dotActive: { width: 26, backgroundColor: colors.brand },
});
