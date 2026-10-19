import { Redirect } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";

import { permissions } from "../platform/device";
import { secureSessions } from "../platform/secure";
import { colors, styles } from "../ui/theme";

type Target = "/sign-in" | "/disclosure" | "/shift";

/**
 * Where a launch lands: sign-in without a session, the location disclosure
 * until background location is granted, otherwise the shift screen.
 */
export default function Index() {
  const [target, setTarget] = useState<Target | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const session = await secureSessions.load();
      const granted = session === null ? null : await permissions();
      if (!alive) return;
      if (session === null) setTarget("/sign-in");
      else if (granted?.background !== true) setTarget("/disclosure");
      else setTarget("/shift");
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (target === null) {
    return (
      <View style={[styles.screen, { justifyContent: "center" }]}>
        <ActivityIndicator color={colors.brand} />
      </View>
    );
  }
  return <Redirect href={target} />;
}
