import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, SafeAreaView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError } from "../../api/client";
import { realtime } from "../../api/realtime";
import type { ThreadListItem } from "../../api/types";
import { Avatar, Chip, Empty, Icon, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { MessagesStackParamList } from "../../navigation/types";

const TABS: Array<{ key: "inbox" | "requests" | "archived"; label: string }> = [
  { key: "inbox", label: "Inbox" },
  { key: "requests", label: "Requests" },
  { key: "archived", label: "Archived" },
];

const CACHE_KEY = "lc.threadsCache";

type Props = NativeStackScreenProps<MessagesStackParamList, "Threads">;

export function ThreadListScreen({ navigation }: Props) {
  const { theme } = useTheme();
  const toast = useToast();
  const [tab, setTab] = useState<"inbox" | "requests" | "archived">("inbox");
  const [items, setItems] = useState<ThreadListItem[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await api<{ items: ThreadListItem[] }>(`/threads?tab=${tab}`);
      setItems(res.items);
      if (tab === "inbox") AsyncStorage.setItem(CACHE_KEY, JSON.stringify(res.items)).catch(() => {});
    } catch (err) {
      if (tab === "inbox") {
        const cached = await AsyncStorage.getItem(CACHE_KEY);
        if (cached) setItems(JSON.parse(cached));
      }
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  // A live "message" or "thread" event (new message, accept, mute/pin/left,
  // etc.) refreshes the current tab instead of waiting for the next manual
  // pull-to-refresh.
  useEffect(() => {
    const off = realtime.onEvent((type) => {
      if (type === "message" || type === "thread") load();
    });
    return off;
  }, [load]);

  function otherName(item: ThreadListItem): string {
    return item.title ?? "Conversation";
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 16 }}>
        <Text style={{ color: theme.text, fontSize: 22, fontWeight: "800" }}>Messages</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="New message" onPress={() => navigation.navigate("NewMessage")} testID="threads-new">
          <Icon name="edit" />
        </Pressable>
      </View>
      <View style={{ flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingBottom: 8 }}>
        {TABS.map((t) => (
          <Chip key={t.key} label={t.label} active={tab === t.key} onPress={() => setTab(t.key)} testID={`threads-tab-${t.key}`} />
        ))}
      </View>
      <FlatList
        data={items}
        keyExtractor={(t) => t.id}
        ListEmptyComponent={!loading ? <Empty icon="chat" title="No conversations" hint={tab === "requests" ? "Message requests from people you're not connected to land here." : undefined} /> : null}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => navigation.navigate("Conversation", { threadId: item.id, title: otherName(item) })}
            accessibilityRole="button"
            style={{ flexDirection: "row", alignItems: "center", gap: 10, padding: 14, borderBottomWidth: 1, borderColor: theme.border }}
          >
            <Avatar assetId={item.participants[0]?.card.avatarAssetId} name={otherName(item)} />
            <View style={{ flex: 1 }}>
              <Text style={{ color: theme.text, fontWeight: item.unreadCount ? "800" : "600" }}>{otherName(item)}</Text>
              <Text numberOfLines={1} style={{ color: theme.dim, fontSize: 13 }}>
                {item.lastMessagePreview ?? "No messages yet"}
              </Text>
            </View>
            {item.unreadCount ? (
              <View style={{ backgroundColor: theme.accent, borderRadius: 10, minWidth: 20, height: 20, alignItems: "center", justifyContent: "center", paddingHorizontal: 5 }}>
                <Text style={{ color: "#fff", fontSize: 11, fontWeight: "700" }}>{item.unreadCount}</Text>
              </View>
            ) : null}
          </Pressable>
        )}
      />
    </SafeAreaView>
  );
}
