import { ActivityIndicator, Pressable, Text } from "react-native";

import { colors, styles } from "./theme";

type Variant = "primary" | "secondary" | "danger";

/**
 * The app's one button: 52 dp tall, a spinner while busy, disabled while busy
 * so a double tap is one action (the server is idempotent; the UI should not
 * rely on it).
 */
export function Button({
  label,
  onPress,
  busy = false,
  disabled = false,
  variant = "primary",
}: {
  readonly label: string;
  readonly onPress: () => void;
  readonly busy?: boolean;
  readonly disabled?: boolean;
  readonly variant?: Variant;
}) {
  const inactive = busy || disabled;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
      onPress={onPress}
      style={[
        styles.button,
        variant === "secondary" && styles.buttonSecondary,
        variant === "danger" && styles.buttonDanger,
        inactive && styles.buttonDisabled,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={variant === "secondary" ? colors.text : colors.surface} />
      ) : (
        <Text style={[styles.buttonText, variant === "secondary" && styles.buttonTextSecondary]}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}
