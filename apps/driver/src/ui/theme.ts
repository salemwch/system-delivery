import { StyleSheet } from "react-native";

/**
 * One stylesheet for the app's few screens. Logical properties only
 * (paddingHorizontal, marginStart): never left/right, so Arabic mirrors
 * (CLAUDE.md: "CSS logical properties only", applied to React Native).
 * Touch targets ≥ 48 dp: one-handed, outdoors, sometimes in gloves (docs/08 §10).
 */
export const colors = {
  brand: "#0f766e",
  danger: "#b91c1c",
  warning: "#b45309",
  text: "#0f172a",
  muted: "#475569",
  border: "#cbd5e1",
  surface: "#ffffff",
  background: "#f1f5f9",
} as const;

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: 20, gap: 16 },
  title: { fontSize: 22, fontWeight: "700", color: colors.text, textAlign: "auto" },
  body: { fontSize: 16, lineHeight: 24, color: colors.text, textAlign: "auto" },
  muted: { fontSize: 14, color: colors.muted, textAlign: "auto" },
  label: { fontSize: 14, fontWeight: "600", color: colors.muted, textAlign: "auto" },
  input: {
    minHeight: 52,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 14,
    fontSize: 18,
    color: colors.text,
    backgroundColor: colors.surface,
    textAlign: "auto",
  },
  button: {
    minHeight: 52,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
    backgroundColor: colors.brand,
  },
  buttonSecondary: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border },
  buttonDanger: { backgroundColor: colors.danger },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { fontSize: 17, fontWeight: "700", color: colors.surface },
  buttonTextSecondary: { color: colors.text },
  card: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 16,
    gap: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 },
  error: { fontSize: 15, color: colors.danger, textAlign: "auto" },
  warning: { fontSize: 15, color: colors.warning, textAlign: "auto" },
});
