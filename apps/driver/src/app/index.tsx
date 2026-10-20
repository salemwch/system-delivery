import { Redirect } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect, useState } from "react";
import { View } from "react-native";

import { permissions } from "../platform/device";
import { secureSessions } from "../platform/secure";
import { disclosureDeclined, isOnboarded } from "../services/onboarding";
import { colors } from "../ui/theme";

type Target = "/onboarding" | "/sign-in" | "/disclosure" | "/(tabs)";

/**
 * Where a launch lands: the introduction once per install, sign-in without a
 * session, the location disclosure until background location is granted (or
 * the driver said "not now"), otherwise the driver's day.
 */
export default function Index() {
  const [target, setTarget] = useState<Target | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const onboarded = await isOnboarded();
      const session = onboarded ? await secureSessions.load() : null;
      const granted = session === null ? null : await permissions();
      const declined = await disclosureDeclined();
      if (!alive) return;
      if (!onboarded) setTarget("/onboarding");
      else if (session === null) setTarget("/sign-in");
      else if (granted?.background !== true && !declined) setTarget("/disclosure");
      else setTarget("/(tabs)");
    })().finally(() => {
      void SplashScreen.hideAsync().catch(() => undefined);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (target === null) {
    return <View style={{ flex: 1, backgroundColor: colors.canvas }} />;
  }
  return <Redirect href={target} />;
}
