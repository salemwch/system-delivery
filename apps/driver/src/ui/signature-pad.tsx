import { useImperativeHandle, useRef, useState } from "react";
import type { Ref } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Svg, { Path } from "react-native-svg";
import { captureRef } from "react-native-view-shot";

import { colors, radius, type } from "./theme";

export interface SignatureHandle {
  /** A PNG of the signature in a temporary file, or null when nothing was drawn. */
  capture(): Promise<string | null>;
  clear(): void;
}

type Point = readonly [number, number];

/** Too few points is a tap, not a signature. */
const MIN_POINTS = 8;

function toPath(points: readonly Point[]): string {
  const [first, ...rest] = points;
  if (first === undefined) return "";
  return `M${first[0].toFixed(1)} ${first[1].toFixed(1)}${rest
    .map(([x, y]) => ` L${x.toFixed(1)} ${y.toFixed(1)}`)
    .join("")}`;
}

/**
 * The recipient signs with a finger: strokes drawn as SVG paths while they
 * sign, exported to a PNG (white background, ink only) when the driver
 * confirms. The PNG carries no metadata, so it passes the server's check.
 */
export function SignaturePad({
  label,
  clearLabel,
  onInk,
  onActive,
  ref,
}: {
  readonly label: string;
  readonly clearLabel: string;
  readonly onInk: (hasInk: boolean) => void;
  /** While a finger is down: the screen stops scrolling, so the stroke is not stolen. */
  readonly onActive?: (active: boolean) => void;
  readonly ref: Ref<SignatureHandle>;
}) {
  const [strokes, setStrokes] = useState<readonly string[]>([]);
  const [live, setLive] = useState<readonly Point[]>([]);
  const points = useRef(0);
  // The stroke being drawn lives in a ref (the gesture writes it); the state
  // copy is only what is rendered, so no side effect hides in an updater.
  const stroke = useRef<Point[]>([]);
  const canvas = useRef<View>(null);

  const pan = Gesture.Pan()
    .runOnJS(true)
    .minDistance(0)
    .onBegin((e) => {
      onActive?.(true);
      stroke.current = [[e.x, e.y]];
      setLive(stroke.current);
    })
    .onUpdate((e) => {
      stroke.current = [...stroke.current, [e.x, e.y]];
      setLive(stroke.current);
    })
    .onFinalize(() => {
      onActive?.(false);
      const done = stroke.current;
      stroke.current = [];
      setLive([]);
      if (done.length > 1) {
        points.current += done.length;
        setStrokes((previous) => [...previous, toPath(done)]);
        onInk(points.current >= MIN_POINTS);
      }
    });

  const clear = () => {
    points.current = 0;
    stroke.current = [];
    setStrokes([]);
    setLive([]);
    onInk(false);
  };

  useImperativeHandle(ref, () => ({
    async capture() {
      if (points.current < MIN_POINTS || canvas.current === null) return null;
      return captureRef(canvas, { format: "png", quality: 1, result: "tmpfile" });
    },
    clear,
  }));

  return (
    <View style={pad.frame}>
      <GestureDetector gesture={pan}>
        <View ref={canvas} collapsable={false} style={pad.canvas}>
          <Svg width="100%" height="100%">
            {[...strokes, toPath(live)].map((d, i) =>
              d === "" ? null : (
                <Path
                  key={String(i)}
                  d={d}
                  stroke={colors.ink}
                  strokeWidth={3}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              ),
            )}
          </Svg>
        </View>
      </GestureDetector>
      <View style={pad.footer} pointerEvents="box-none">
        <View style={pad.line} />
        <View style={pad.row}>
          <Text style={type.caption}>{label}</Text>
          <Text
            accessibilityRole="button"
            style={[type.caption, { color: colors.brand, fontWeight: "700" }]}
            onPress={clear}
          >
            {clearLabel}
          </Text>
        </View>
      </View>
    </View>
  );
}

const pad = StyleSheet.create({
  frame: {
    height: 220,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    overflow: "hidden",
  },
  canvas: { flex: 1, backgroundColor: colors.surface },
  footer: { position: "absolute", start: 16, end: 16, bottom: 12, gap: 6 },
  line: { height: 1, backgroundColor: colors.line },
  row: { flexDirection: "row", justifyContent: "space-between" },
});
