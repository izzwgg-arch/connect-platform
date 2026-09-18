import { useEffect, useState } from "react";
import { FlatList, Pressable, SafeAreaView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError } from "../../api/client";
import type { PersonCard } from "../../api/types";
import { Avatar, Empty, Field, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { MessagesStackParamList } from "../../navigation/types";

type ConnRow = { connection: { id: string }; person: PersonCard | null };

type Props = NativeStackScreenProps<MessagesStackParamList, "NewMessage">;

export function NewMessageScreen({ navigation, route }: Props) {
  const { theme } = useTheme();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [connections, setConnections] = useState<PersonCard[]>([]);
  const [searchResults, setSearchResults] = useState<PersonCard[]>([]);

  useEffect(() => {
    api<{ items: ConnRow[] }>("/connections")
      .then((r) => setConnections(r.items.map((c) => c.person).filter((p): p is PersonCard => !!p)))
      .catch(() => setConnections([]));
  }, []);

  useEffect(() => {
    if (!q.trim()) {
      setSearchResults([]);
      return;
    }
    const t = setTimeout(() => {
      api<{ items: Array<{ type: string; id: string; title: string; subtitle: string | null; avatarAssetId: string | null }> }>(`/search?q=${encodeURIComponent(q)}&type=people`)
        .then((r) =>
          setSearchResults(
            r.items.map((i) => ({
              id: i.id,
              username: i.id,
              name: i.title,
              firstName: "",
              lastName: "",
              headline: i.subtitle,
              avatarAssetId: i.avatarAssetId,
              location: null,
              industry: null,
              verified: [],
              primaryOrg: null,
            })),
          ),
        )
        .catch(() => setSearchResults([]));
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  async function openWith(person: PersonCard) {
    try {
      const thread = await api<{ id: string }>("/threads", { method: "POST", body: { personIds: [person.id] } });
      if (route.params?.forwardMessageId && route.params.forwardFromThreadId) {
        await api(`/threads/${route.params.forwardFromThreadId}/messages/${route.params.forwardMessageId}/forward`, {
          method: "POST",
          body: { toThreadIds: [thread.id] },
        });
        toast("Forwarded.");
        navigation.goBack();
        return;
      }
      navigation.replace("Conversation", { threadId: thread.id, title: person.name });
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  const list = q.trim() ? searchResults : connections;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={{ padding: 16, gap: 10 }}>
        <Text style={{ color: theme.text, fontSize: 18, fontWeight: "800" }}>{route.params?.forwardMessageId ? "Forward to" : "New message"}</Text>
        <Field placeholder="Search people" value={q} onChangeText={setQ} autoFocus testID="newmessage-search" />
      </View>
      <FlatList
        data={list}
        keyExtractor={(p) => p.id}
        ListEmptyComponent={<Empty icon="people" title="No one found" />}
        renderItem={({ item }) => (
          <Pressable onPress={() => openWith(item)} accessibilityRole="button" style={{ flexDirection: "row", alignItems: "center", gap: 10, padding: 14 }}>
            <Avatar assetId={item.avatarAssetId} name={item.name} />
            <View>
              <Text style={{ color: theme.text, fontWeight: "700" }}>{item.name}</Text>
              {item.headline ? <Text style={{ color: theme.dim, fontSize: 12 }}>{item.headline}</Text> : null}
            </View>
          </Pressable>
        )}
      />
    </SafeAreaView>
  );
}
