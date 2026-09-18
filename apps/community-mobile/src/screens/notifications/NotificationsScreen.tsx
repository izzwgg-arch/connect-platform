import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, SafeAreaView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError } from "../../api/client";
import type { NotificationItem } from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import { resolveDeepLinkPath } from "../../navigation/linking";
import { Avatar, Button, Chip, Empty, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { MeStackParamList } from "../../navigation/types";

const FILTERS = ["all", "decisions", "network", "rfq", "jobs", "posts", "events", "security"];

type Props = NativeStackScreenProps<MeStackParamList, "Notifications">;

export function NotificationsScreen({ navigation }: Props) {
  const { theme } = useTheme();
  const toast = useToast();
  const { setCounts } = useAuth();
  const [filter, setFilter] = useState("all");
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await api<{ items: NotificationItem[] }>(`/notifications?filter=${filter}`);
      setItems(res.items);
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  async function markAllRead() {
    await api("/notifications/read", { method: "POST", body: { all: true } });
    setItems((prev) => prev.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })));
    setCounts({ notifications: 0 });
  }

  async function open(n: NotificationItem) {
    if (!n.readAt) {
      await api("/notifications/read", { method: "POST", body: { ids: [n.id] } });
      setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)));
    }
    if (n.href) {
      const target = resolveDeepLinkPath(n.href);
      if (target?.screen === "PersonProfile") navigation.navigate("PersonProfile", target.params as any);
      else if (target?.screen === "Company") navigation.navigate("Company", target.params as any);
    }
  }

  async function respondConnection(n: NotificationItem, action: "accept" | "ignore") {
    if (!n.objectId) return;
    try {
      await api(`/connections/${n.objectId}/${action}`, { method: "POST" });
      toast(action === "accept" ? "Connected." : "Ignored.");
      load();
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  const groups: Array<[string, NotificationItem[]]> = [
    ["Today", items.filter((n) => n.group === "today")],
    ["This week", items.filter((n) => n.group === "week")],
    ["Earlier", items.filter((n) => n.group === "earlier")],
  ].filter(([, list]) => list.length > 0) as any;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 16 }}>
        <Text style={{ color: theme.text, fontSize: 20, fontWeight: "800" }}>Notifications</Text>
        <Pressable onPress={markAllRead} accessibilityRole="button" testID="notifications-mark-all">
          <Text style={{ color: theme.accent, fontWeight: "700" }}>Mark all read</Text>
        </Pressable>
      </View>
      <FlatList
        horizontal
        data={FILTERS}
        keyExtractor={(f) => f}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8, paddingHorizontal: 16, paddingBottom: 8 }}
        renderItem={({ item }) => <Chip label={item} active={filter === item} onPress={() => setFilter(item)} />}
      />
      <FlatList
        data={groups}
        keyExtractor={([label]) => label}
        ListEmptyComponent={!loading ? <Empty icon="bell" title="You're all caught up" /> : null}
        renderItem={({ item: [label, list] }) => (
          <View>
            <Text style={{ color: theme.dim, fontWeight: "700", padding: 12, paddingBottom: 4 }}>{label}</Text>
            {list.map((n) => (
              <Pressable
                key={n.id}
                onPress={() => open(n)}
                accessibilityRole="button"
                style={{ flexDirection: "row", gap: 10, padding: 14, backgroundColor: n.readAt ? "transparent" : theme.panel2 }}
              >
                <Avatar assetId={n.actor?.avatarAssetId} name={n.actor?.name} size={36} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: theme.text, fontWeight: "700" }}>{n.title}</Text>
                  {n.body ? (
                    <Text numberOfLines={2} style={{ color: theme.dim, fontSize: 13 }}>
                      {n.body}
                    </Text>
                  ) : null}
                  {n.kind === "connection.request" ? (
                    <View style={{ flexDirection: "row", gap: 8, marginTop: 6 }}>
                      <Button title="Accept" kind="primary" onPress={() => respondConnection(n, "accept")} />
                      <Button title="Ignore" onPress={() => respondConnection(n, "ignore")} />
                    </View>
                  ) : null}
                </View>
              </Pressable>
            ))}
          </View>
        )}
      />
    </SafeAreaView>
  );
}
