import { Linking, SafeAreaView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Button, Icon } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { HomeStackParamList } from "../../navigation/types";

const LABELS: Record<string, string> = {
  jobs: "job listing",
  events: "event",
  groups: "group",
  rfq: "request for quote",
  opportunities: "opportunity",
};

/**
 * Screens not yet built natively (jobs, events, groups, RFQ, opportunities —
 * see docs/community/parity.md). Rather than a dead screen, this offers the
 * same page on the web, which is fully built.
 */
export function ExternalLinkScreen({ route }: NativeStackScreenProps<HomeStackParamList, "ExternalLink">) {
  const { theme } = useTheme();
  const { title, path } = route.params;
  const kind = path.split("/")[0];
  const url = `https://community.loopcom.net/${path}`;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg, justifyContent: "center", alignItems: "center", padding: 24, gap: 16 }}>
      <Icon name="globe" size={32} color={theme.dim} />
      <Text style={{ color: theme.text, fontWeight: "800", fontSize: 18, textAlign: "center" }}>
        {title || `This ${LABELS[kind] ?? "page"} isn't built in the app yet`}
      </Text>
      <Text style={{ color: theme.dim, textAlign: "center" }}>Open it on the Loopcom Community website instead.</Text>
      <Button title="Open on web" kind="primary" icon="link" onPress={() => Linking.openURL(url)} testID="external-open-web" />
    </SafeAreaView>
  );
}
