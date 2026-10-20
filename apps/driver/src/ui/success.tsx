import { useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";

import { Icon } from "./kit";
import { colors, radius, space, type } from "./theme";

/**
 * The moment after a delivery: a check that springs in, and a word. The
 * driver is already looking at the next door; this tells them, at a glance,
 * that the last one is recorded.
 */
export function Success({
  title,
  body,
}: {
  readonly title: string;
  readonly body?: string | undefined;
}) {
  const scale = useRef(new Animated.Value(0.4)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.spring(scale, { toValue: 1, friction: 5, tension: 120, useNativeDriver: true }),
      Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }),
    ]).start();
  }, [scale, opacity]);

  return (
    <View style={su.root} accessibilityLiveRegion="assertive">
      <Animated.View style={[su.disc, { opacity, transform: [{ scale }] }]}>
        <Icon name="check-bold" size={64} color={colors.surface} />
      </Animated.View>
      <Text style={[type.title, { textAlign: "center" }]}>{title}</Text>
      {body === undefined ? null : <Text style={[type.body, su.body]}>{body}</Text>}
    </View>
  );
}

const su = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: space.lg,
    backgroundColor: colors.surface,
    padding: space.xxl,
  },
  disc: {
    width: 128,
    height: 128,
    borderRadius: radius.pill,
    backgroundColor: colors.success,
    alignItems: "center",
    justifyContent: "center",
  },
  body: { textAlign: "center", color: colors.muted },
});
