import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, RefreshControl, SafeAreaView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError, newIdempotencyKey } from "../../api/client";
import type { PersonCard } from "../../api/types";
import { Avatar, Button, Empty, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { NetworkStackParamList } from "../../navigation/types";

type Pending = { id: string; person: PersonCard | null; message: string | null; createdAt: string };
type Suggestion = { person: PersonCard; reason: string; recommendationId: string };

type Props = NativeStackScreenProps<NetworkStackParamList, "Network">;

export function NetworkScreen({ navigation }: Props) {
  const { theme } = useTheme();
  const toast = useToast();
  const [incoming, setIncoming] = useState<Pending[]>([]);
  const [outgoing, setOutgoing] = useState<Pending[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [pending, sugg] = await Promise.all([
        api<{ incoming: Pending[]; outgoing: Pending[] }>("/connections/pending"),
        api<{ items: Suggestion[] }>("/network/suggestions?limit=12"),
      ]);
      setIncoming(pending.incoming);
      setOutgoing(pending.outgoing);
      setSuggestions(sugg.items);
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function onRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  async function respond(id: string, action: "accept" | "ignore") {
    try {
      await api(`/connections/${id}/${action}`, { method: "POST" });
      setIncoming((prev) => prev.filter((p) => p.id !== id));
      toast(action === "accept" ? "Connected." : "Request ignored.");
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  async function withdraw(id: string) {
    try {
      await api(`/connections/${id}/withdraw`, { method: "POST" });
      setOutgoing((prev) => prev.filter((p) => p.id !== id));
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  async function connect(s: Suggestion) {
    try {
      await api("/connections/request", { method: "POST", body: { personId: s.person.id }, idempotencyKey: newIdempotencyKey() });
      setSuggestions((prev) => prev.filter((x) => x.person.id !== s.person.id));
      toast("Request sent.");
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  async function dismiss(s: Suggestion) {
    try {
      await api(`/network/suggestions/${s.recommendationId}/dismiss`, { method: "POST" });
      setSuggestions((prev) => prev.filter((x) => x.person.id !== s.person.id));
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <FlatList
        data={[{ key: "body" }]}
        keyExtractor={(x) => x.key}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accent} />}
        contentContainerStyle={{ padding: 16, gap: 16 }}
        renderItem={() => (
          <View style={{ gap: 20 }}>
            <Button title="Manage all connections" onPress={() => navigation.navigate("Connections", undefined)} testID="network-connections" />

            <Section title={`Invitations (${incoming.length})`}>
              {incoming.length === 0 ? (
                <Empty icon="people" title="No pending invitations" />
              ) : (
                incoming.map((p) => (
                  <Row key={p.id} onPress={() => p.person && navigation.navigate("PersonProfile", { username: p.person.username })}>
                    <Avatar assetId={p.person?.avatarAssetId} name={p.person?.name} />
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: theme.text, fontWeight: "700" }}>{p.person?.name ?? "Someone"}</Text>
                      {p.message ? (
                        <Text numberOfLines={2} style={{ color: theme.dim, fontSize: 12 }}>
                          {p.message}
                        </Text>
                      ) : null}
                    </View>
                    <Button title="Accept" kind="primary" onPress={() => respond(p.id, "accept")} testID={`invite-accept-${p.id}`} />
                    <Button title="Ignore" onPress={() => respond(p.id, "ignore")} testID={`invite-ignore-${p.id}`} />
                  </Row>
                ))
              )}
            </Section>

            <Section title={`Sent (${outgoing.length})`}>
              {outgoing.map((p) => (
                <Row key={p.id}>
                  <Avatar assetId={p.person?.avatarAssetId} name={p.person?.name} />
                  <Text style={{ color: theme.text, flex: 1 }}>{p.person?.name ?? "Someone"}</Text>
                  <Button title="Withdraw" onPress={() => withdraw(p.id)} testID={`invite-withdraw-${p.id}`} />
                </Row>
              ))}
            </Section>

            <Section title="People you may know">
              {suggestions.map((s) => (
                <Row key={s.person.id} onPress={() => navigation.navigate("PersonProfile", { username: s.person.username })}>
                  <Avatar assetId={s.person.avatarAssetId} name={s.person.name} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: theme.text, fontWeight: "700" }}>{s.person.name}</Text>
                    <Text style={{ color: theme.dim, fontSize: 12 }}>{s.reason}</Text>
                  </View>
                  <Button title="Connect" kind="primary" onPress={() => connect(s)} testID={`pymk-connect-${s.person.id}`} />
                  <Button title="Dismiss" onPress={() => dismiss(s)} testID={`pymk-dismiss-${s.person.id}`} />
                </Row>
              ))}
            </Section>
          </View>
        )}
      />
    </SafeAreaView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const { theme } = useTheme();
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: theme.text, fontWeight: "800", fontSize: 15 }}>{title}</Text>
      {children}
    </View>
  );
}

function Row({ children, onPress }: { children: React.ReactNode; onPress?: () => void }) {
  const { theme } = useTheme();
  const style = { flexDirection: "row" as const, alignItems: "center" as const, gap: 10, backgroundColor: theme.panel, padding: 10, borderRadius: 12, borderWidth: 1, borderColor: theme.border };
  if (onPress) {
    return (
      <Pressable onPress={onPress} accessibilityRole="button" style={style}>
        {children}
      </Pressable>
    );
  }
  return <View style={style}>{children}</View>;
}
