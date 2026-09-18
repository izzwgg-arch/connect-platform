import { useState } from "react";
import { FlatList, Pressable, SafeAreaView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError } from "../../api/client";
import { Avatar, Button, Card, Field, Icon, Sheet, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { HomeStackParamList } from "../../navigation/types";

type Match = { type: string; id: string; rank: number; why: string; item: any };
type Action = { token: string; kind: string; label: string; needsConfirmation: true };

type Turn = {
  question: string;
  intent: { kind: string; summary: string };
  explanation: string;
  matches: Match[];
  actions: Action[];
  disclaimer: string;
};

type Props = NativeStackScreenProps<HomeStackParamList, "Concierge">;

export function ConciergeScreen({ navigation }: Props) {
  const { theme } = useTheme();
  const toast = useToast();
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [asking, setAsking] = useState(false);
  const [confirmAction, setConfirmAction] = useState<Action | null>(null);

  async function ask() {
    const q = question.trim();
    if (q.length < 3) {
      toast("Say a bit more about what you need.", { kind: "err" });
      return;
    }
    setAsking(true);
    setQuestion("");
    try {
      const res = await api<Turn>("/concierge/ask", { method: "POST", body: { question: q } });
      setTurns((prev) => [...prev, { ...res, question: q }]);
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setAsking(false);
    }
  }

  async function confirm() {
    if (!confirmAction) return;
    try {
      await api("/concierge/act", { method: "POST", body: { token: confirmAction.token } });
      toast("Done.");
      setConfirmAction(null);
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  function openMatch(m: Match) {
    switch (m.type) {
      case "organizations":
        navigation.navigate("Company", { slug: m.item.slug });
        break;
      case "people":
        navigation.navigate("PersonProfile", { username: m.item.username });
        break;
      case "jobs":
        navigation.navigate("JobDetail", { id: m.id });
        break;
      case "events":
        navigation.navigate("EventDetail", { id: m.id, slug: m.item.slug });
        break;
      case "groups":
        navigation.navigate("GroupDetail", { slug: m.item.slug });
        break;
      case "listings":
        navigation.navigate("ListingDetail", { id: m.id });
        break;
      default:
        break;
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={{ padding: 16, borderBottomWidth: 1, borderColor: theme.border }}>
        <Text style={{ color: theme.text, fontSize: 20, fontWeight: "800" }}>Concierge</Text>
        <Text style={{ color: theme.dim, fontSize: 12 }}>Ask for a vendor, a customer, or help writing a request. Nothing is sent until you confirm.</Text>
      </View>
      <FlatList
        data={turns}
        keyExtractor={(_, i) => String(i)}
        contentContainerStyle={{ padding: 16, gap: 16 }}
        renderItem={({ item }) => (
          <View style={{ gap: 10 }}>
            <View style={{ alignSelf: "flex-end", backgroundColor: theme.accent, borderRadius: 12, padding: 10, maxWidth: "85%" }}>
              <Text style={{ color: "#fff" }}>{item.question}</Text>
            </View>
            <Card style={{ gap: 10 }}>
              <Text style={{ color: theme.text }}>{item.explanation}</Text>
              {item.matches.map((m) => (
                <Pressable key={`${m.type}-${m.id}`} onPress={() => openMatch(m)} accessibilityRole="button" style={{ flexDirection: "row", gap: 8, alignItems: "center", paddingVertical: 6 }}>
                  <Avatar assetId={m.item.logoAssetId ?? m.item.avatarAssetId} name={m.item.displayName ?? m.item.name ?? m.item.title} size={30} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: theme.text, fontWeight: "700", fontSize: 13 }}>{m.item.displayName ?? m.item.name ?? m.item.title}</Text>
                    <Text style={{ color: theme.dim, fontSize: 11 }} numberOfLines={1}>
                      {m.why}
                    </Text>
                  </View>
                  <Icon name="arrow" size={14} color={theme.dim} />
                </Pressable>
              ))}
              {item.actions.length ? (
                <View style={{ gap: 8 }}>
                  {item.actions.map((a) => (
                    <Button key={a.token} title={a.label} kind="secondary" onPress={() => setConfirmAction(a)} />
                  ))}
                </View>
              ) : null}
              <Text style={{ color: theme.dim, fontSize: 10, fontStyle: "italic" }}>{item.disclaimer}</Text>
            </Card>
          </View>
        )}
      />
      <View style={{ flexDirection: "row", gap: 8, padding: 12, borderTopWidth: 1, borderColor: theme.border, alignItems: "center" }}>
        <View style={{ flex: 1 }}>
          <Field placeholder="e.g. I need 500 custom signs near Brooklyn" value={question} onChangeText={setQuestion} onSubmitEditing={ask} testID="concierge-input" />
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Ask" onPress={ask} disabled={asking} testID="concierge-ask">
          <Icon name="send" color={theme.accent} />
        </Pressable>
      </View>

      <Sheet visible={!!confirmAction} onClose={() => setConfirmAction(null)} title="Confirm">
        <Text style={{ color: theme.text }}>{confirmAction?.label}</Text>
        <View style={{ height: 14 }} />
        <Button title="Confirm" kind="primary" wide onPress={confirm} testID="concierge-confirm" />
      </Sheet>
    </SafeAreaView>
  );
}
