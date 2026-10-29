import { AudioModule, RecordingPresets, useAudioRecorder, useAudioRecorderState } from "expo-audio";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useI18n } from "./i18n-context";
import { Icon } from "./kit";
import { colors, radius, space, type } from "./theme";

const MIN_DURATION_MS = 1_500;
const MAX_DURATION_MS = 30_000;

export function VoiceRecorder({ onRecorded }: { readonly onRecorded: (uri: string) => void }) {
  const { t } = useI18n();
  const recorder = useAudioRecorder(RecordingPresets.LOW_QUALITY);
  const state = useAudioRecorderState(recorder, 500);
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopping = useRef(false);

  useEffect(() => {
    return () => {
      if (timer.current !== null) clearInterval(timer.current);
    };
  }, []);

  const start = async () => {
    setError(null);
    stopping.current = false;
    const { granted } = await AudioModule.requestRecordingPermissionsAsync();
    if (!granted) return;
    await recorder.prepareToRecordAsync();
    recorder.record();
    setSeconds(0);
    timer.current = setInterval(() => {
      setSeconds((s) => {
        if (s >= MAX_DURATION_MS / 1000) {
          void stop();
          return s;
        }
        return s + 1;
      });
    }, 1000);
  };

  const stop = async () => {
    if (stopping.current) return;
    stopping.current = true;
    if (timer.current !== null) {
      clearInterval(timer.current);
      timer.current = null;
    }
    await recorder.stop();
    const uri = recorder.uri;
    const durationMs = state.durationMillis;
    if (uri === null || durationMs < MIN_DURATION_MS) {
      setError(t.voiceNoteTooShort);
      return;
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    onRecorded(uri);
  };

  const active = state.isRecording;

  return (
    <View style={s.wrapper}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={active ? t.recordingVoice : t.recordVoiceNote}
        onPress={() => void (active ? stop() : start())}
        style={[s.button, active && s.recording]}
      >
        <Icon
          name={active ? "stop-circle-outline" : "microphone-outline"}
          color={active ? colors.danger : colors.brand}
          size={28}
        />
        <Text style={[type.label, { color: active ? colors.danger : colors.brand }]}>
          {active ? `${t.recordingVoice} ${String(seconds)}s` : t.recordVoiceNote}
        </Text>
      </Pressable>
      {error !== null ? (
        <Text style={[type.caption, { color: colors.danger }]}>{error}</Text>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  wrapper: { gap: space.xs },
  button: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.lg,
    borderWidth: 2,
    borderStyle: "dashed",
    borderColor: colors.brand,
    backgroundColor: colors.brandSoft,
  },
  recording: {
    borderColor: colors.danger,
    backgroundColor: colors.dangerSoft,
  },
});
