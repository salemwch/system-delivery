import { MaterialCommunityIcons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import type { ComponentProps, ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { StyleProp, TextInputProps, ViewStyle } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Svg, { Circle } from "react-native-svg";

import { MIN_TOUCH, colors, elevation, radius, space, type } from "./theme";

export type IconName = ComponentProps<typeof MaterialCommunityIcons>["name"];

/** The app's icon set (Material Community Icons): one family, one weight. */
export function Icon({
  name,
  size = 22,
  color = colors.ink,
}: {
  readonly name: IconName;
  readonly size?: number;
  readonly color?: string;
}) {
  return <MaterialCommunityIcons name={name} size={size} color={color} />;
}

/**
 * A screen: safe area, canvas background, optional scroll, and an optional
 * footer pinned to the bottom (the thumb zone) for the primary action.
 */
export function Screen({
  children,
  footer,
  scroll = true,
  scrollEnabled = true,
  edges = ["top"],
}: {
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly scroll?: boolean;
  readonly scrollEnabled?: boolean;
  readonly edges?: readonly ("top" | "bottom")[];
}) {
  return (
    <SafeAreaView style={kit.screen} edges={edges}>
      {scroll ? (
        <ScrollView
          contentContainerStyle={kit.content}
          keyboardShouldPersistTaps="handled"
          scrollEnabled={scrollEnabled}
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[kit.content, { flex: 1 }]}>{children}</View>
      )}
      {footer === undefined ? null : <View style={kit.footer}>{footer}</View>}
    </SafeAreaView>
  );
}

export function Card({
  children,
  style,
  tone,
}: {
  readonly children: ReactNode;
  readonly style?: StyleProp<ViewStyle>;
  readonly tone?: "brand" | "cash";
}) {
  return (
    <View
      style={[
        kit.card,
        tone === "brand" && { backgroundColor: colors.brand, borderColor: colors.brand },
        tone === "cash" && { backgroundColor: colors.cashSoft, borderColor: "#F8DDB4" },
        style,
      ]}
    >
      {children}
    </View>
  );
}

type ButtonVariant = "primary" | "secondary" | "danger" | "ghost" | "cash";

/**
 * The app's button: 56 dp, a spinner while busy, disabled while busy so a
 * double tap is one action, and a light haptic tick on press (outdoors, the
 * hand feels the tap even when the eye is on the road).
 */
export function Button({
  label,
  onPress,
  icon,
  busy = false,
  disabled = false,
  variant = "primary",
  compact = false,
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly icon?: IconName;
  readonly busy?: boolean;
  readonly disabled?: boolean;
  readonly variant?: ButtonVariant;
  readonly compact?: boolean;
}) {
  const inactive = busy || disabled;
  const palette = BUTTON_PALETTE[variant];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      style={({ pressed }) => [
        kit.button,
        compact && kit.buttonCompact,
        { backgroundColor: palette.bg, borderColor: palette.border },
        pressed && { opacity: 0.85, transform: [{ scale: 0.99 }] },
        inactive && { opacity: 0.5 },
      ]}
    >
      {busy ? (
        <ActivityIndicator color={palette.fg} />
      ) : (
        <>
          {icon === undefined ? null : (
            <Icon name={icon} color={palette.fg} size={compact ? 20 : 22} />
          )}
          <Text style={[kit.buttonText, { color: palette.fg }, compact && { fontSize: 15 }]}>
            {label}
          </Text>
        </>
      )}
    </Pressable>
  );
}

const BUTTON_PALETTE: Readonly<Record<ButtonVariant, { bg: string; fg: string; border: string }>> =
  {
    primary: { bg: colors.brand, fg: colors.surface, border: colors.brand },
    secondary: { bg: colors.surface, fg: colors.ink, border: colors.line },
    danger: { bg: colors.danger, fg: colors.surface, border: colors.danger },
    ghost: { bg: "transparent", fg: colors.brand, border: "transparent" },
    cash: { bg: colors.cash, fg: colors.surface, border: colors.cash },
  };

/** A round icon action (call, navigate), labelled for screen readers. */
export function IconAction({
  icon,
  label,
  onPress,
  tone = "brand",
}: {
  readonly icon: IconName;
  readonly label: string;
  readonly onPress: () => void;
  readonly tone?: "brand" | "neutral";
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      style={({ pressed }) => [kit.iconAction, pressed && { opacity: 0.8 }]}
    >
      <View
        style={[
          kit.iconBubble,
          { backgroundColor: tone === "brand" ? colors.brandSoft : colors.canvas },
        ]}
      >
        <Icon name={icon} color={tone === "brand" ? colors.brand : colors.ink} />
      </View>
      <Text style={kit.iconLabel} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

export type ChipTone = "neutral" | "brand" | "success" | "danger" | "warning" | "info" | "cash";

const CHIP: Readonly<Record<ChipTone, { bg: string; fg: string }>> = {
  neutral: { bg: colors.canvas, fg: colors.muted },
  brand: { bg: colors.brandSoft, fg: colors.brandDark },
  success: { bg: colors.successSoft, fg: colors.success },
  danger: { bg: colors.dangerSoft, fg: colors.danger },
  warning: { bg: colors.warningSoft, fg: colors.warning },
  info: { bg: colors.infoSoft, fg: colors.info },
  cash: { bg: colors.cashSoft, fg: colors.cash },
};

/** A status chip: icon + text, never colour alone (docs/08 §10). */
export function Chip({
  label,
  tone = "neutral",
  icon,
}: {
  readonly label: string;
  readonly tone?: ChipTone;
  readonly icon?: IconName;
}) {
  const c = CHIP[tone];
  return (
    <View style={[kit.chip, { backgroundColor: c.bg }]}>
      {icon === undefined ? null : <Icon name={icon} size={14} color={c.fg} />}
      <Text style={[kit.chipText, { color: c.fg }]}>{label}</Text>
    </View>
  );
}

export function SectionTitle({
  children,
  action,
}: {
  readonly children: string;
  readonly action?: ReactNode;
}) {
  return (
    <View style={kit.sectionTitle}>
      <Text style={type.label}>{children.toUpperCase()}</Text>
      {action}
    </View>
  );
}

/** A tappable row with a leading icon or number, title, subtitle and trailing content. */
export function ListRow({
  title,
  subtitle,
  leading,
  trailing,
  onPress,
}: {
  readonly title: string;
  readonly subtitle?: string;
  readonly leading?: ReactNode;
  readonly trailing?: ReactNode;
  readonly onPress?: () => void;
}) {
  const body = (
    <>
      {leading}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={type.heading} numberOfLines={1}>
          {title}
        </Text>
        {subtitle === undefined ? null : (
          <Text style={type.caption} numberOfLines={2}>
            {subtitle}
          </Text>
        )}
      </View>
      {trailing}
    </>
  );
  if (onPress === undefined) {
    return <View style={kit.row}>{body}</View>;
  }
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [kit.row, pressed && { backgroundColor: colors.canvas }]}
    >
      {body}
      <Icon name="chevron-right" color={colors.muted} />
    </Pressable>
  );
}

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  readonly icon: IconName;
  readonly title: string;
  readonly body?: string;
  readonly action?: ReactNode;
}) {
  return (
    <View style={kit.empty}>
      <View style={kit.emptyBubble}>
        <Icon name={icon} size={34} color={colors.brand} />
      </View>
      <Text style={[type.heading, { textAlign: "center" }]}>{title}</Text>
      {body === undefined ? null : (
        <Text style={[type.caption, { textAlign: "center" }]}>{body}</Text>
      )}
      {action}
    </View>
  );
}

export function Banner({
  tone,
  icon,
  text,
}: {
  readonly tone: "warning" | "danger" | "info" | "success";
  readonly icon: IconName;
  readonly text: string;
}) {
  const c = CHIP[tone];
  return (
    <View style={[kit.banner, { backgroundColor: c.bg }]} accessibilityLiveRegion="polite">
      <Icon name={icon} size={20} color={c.fg} />
      <Text style={[type.body, { color: c.fg, flex: 1 }]}>{text}</Text>
    </View>
  );
}

export function Field({ label, ...input }: { readonly label: string } & TextInputProps) {
  return (
    <View style={{ gap: space.sm }}>
      <Text style={type.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colors.muted}
        style={kit.input}
        {...input}
      />
    </View>
  );
}

/** Progress as a ring: done of total, the number in the middle. */
export function ProgressRing({
  done,
  total,
  size = 84,
}: {
  readonly done: number;
  readonly total: number;
  readonly size?: number;
}) {
  const stroke = 8;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const ratio = total === 0 ? 0 : Math.min(1, done / total);
  return (
    <View
      style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}
      accessibilityLabel={`${String(done)} / ${String(total)}`}
    >
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke="rgba(255,255,255,0.25)"
          strokeWidth={stroke}
          fill="none"
        />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={colors.surface}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${String(circumference * ratio)} ${String(circumference)}`}
          transform={`rotate(-90 ${String(size / 2)} ${String(size / 2)})`}
        />
      </Svg>
      <Text style={{ color: colors.surface, fontSize: 20, fontWeight: "800" }}>
        {done}/{total}
      </Text>
    </View>
  );
}

const kit = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  content: { padding: space.xl, gap: space.lg, paddingBottom: space.xxl * 2 },
  footer: {
    paddingHorizontal: space.xl,
    paddingTop: space.md,
    paddingBottom: space.xl,
    gap: space.sm,
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    ...elevation.card,
  },
  button: {
    minHeight: 56,
    borderRadius: radius.md,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
    paddingHorizontal: space.lg,
  },
  buttonCompact: { minHeight: 44, borderRadius: radius.sm },
  buttonText: { fontSize: 17, fontWeight: "700" },
  iconAction: { alignItems: "center", gap: space.xs, minWidth: MIN_TOUCH, flex: 1 },
  iconBubble: {
    width: 52,
    height: 52,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  iconLabel: { fontSize: 13, fontWeight: "600", color: colors.text },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.pill,
    alignSelf: "flex-start",
  },
  chipText: { fontSize: 12, fontWeight: "700" },
  sectionTitle: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: space.sm,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 64,
    paddingVertical: space.sm,
  },
  empty: {
    alignItems: "center",
    gap: space.sm,
    paddingVertical: space.xxl,
    paddingHorizontal: space.lg,
  },
  emptyBubble: {
    width: 72,
    height: 72,
    borderRadius: radius.pill,
    backgroundColor: colors.brandSoft,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: space.sm,
  },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: space.md,
    borderRadius: radius.md,
  },
  input: {
    minHeight: MIN_TOUCH,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    fontSize: 18,
    color: colors.ink,
    backgroundColor: colors.surface,
    textAlign: "auto",
  },
});
