import { StyleSheet } from "react-native";

/**
 * The driver app's design tokens. One place for colour, space, radius and type,
 * so every screen reads as one product.
 *
 * Built for the street, not the office: high contrast for sunlight, touch
 * targets of 52 dp and more (docs/08 §10: one-handed, outdoors, sometimes in
 * gloves), primary actions in the bottom third of the screen (thumb zone), and
 * logical properties only (start/end, never left/right) so Arabic mirrors.
 */
export const colors = {
  brand: "#0E7C6B",
  brandDark: "#0A5C50",
  brandSoft: "#E3F4F0",
  cash: "#B45309",
  cashSoft: "#FEF3E2",
  success: "#15803D",
  successSoft: "#E7F6EC",
  danger: "#B91C1C",
  dangerSoft: "#FDECEC",
  warning: "#A16207",
  warningSoft: "#FEF7E0",
  info: "#1D4ED8",
  infoSoft: "#E8EFFD",
  ink: "#0B1220",
  text: "#1E293B",
  muted: "#64748B",
  line: "#E2E8F0",
  canvas: "#F4F6F8",
  surface: "#FFFFFF",
  overlay: "rgba(11, 18, 32, 0.55)",
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 28 } as const;
export const radius = { sm: 10, md: 14, lg: 20, pill: 999 } as const;

export const type = StyleSheet.create({
  display: { fontSize: 30, fontWeight: "800", color: colors.ink, letterSpacing: -0.5 },
  title: { fontSize: 22, fontWeight: "700", color: colors.ink },
  heading: { fontSize: 17, fontWeight: "700", color: colors.ink },
  body: { fontSize: 16, lineHeight: 23, color: colors.text },
  label: { fontSize: 13, fontWeight: "600", color: colors.muted, letterSpacing: 0.2 },
  caption: { fontSize: 13, color: colors.muted },
  number: { fontSize: 26, fontWeight: "800", color: colors.ink, fontVariant: ["tabular-nums"] },
});

/** A soft card shadow that reads on Android (elevation) without looking heavy. */
export const elevation = {
  card: {
    shadowColor: "#0B1220",
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  floating: {
    shadowColor: "#0B1220",
    shadowOpacity: 0.14,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
} as const;

export const MIN_TOUCH = 52;
