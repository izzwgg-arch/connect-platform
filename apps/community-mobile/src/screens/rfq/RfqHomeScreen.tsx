import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, SafeAreaView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError } from "../../api/client";
import { Button, Chip, Empty, Skeleton, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { HomeStackParamList } from "../../navigation/types";

type RfqRow = {
  id: string;
  number: string;
  title: string;
  status: string;
  quantity: string | null;
  budgetMin: string | null;
  budgetMax: string | null;
  location: string | null;
  closesAt: string | null;
  quoteCount: number;
  createdAt: string;
  viewedAt?: string | null;
};

const TABS: Array<{ key: "mine" | "inbox" | "browse"; label: string }> = [
  { key: "mine", label: "My requests" },
  { key: "inbox", label: "Vendor inbox" },
  { key: "browse", label: "Browse" },
];

type Props = NativeStackScreenProps<HomeStackParamList, "RfqHome">;

export function RfqHomeScreen({ navigation }: Props) {
  const { theme } = useTheme();
  const toast = useToast();
  const [tab, setTab] = useState<"mine" | "inbox" | "browse">("mine");
  const [items, setItems] = useState<RfqRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (tab === "mine") {
        const res = await api<{ items: RfqRow[] }>("/rfq?role=buyer");
        setItems(res.items);
      } else if (tab === "inbox") {
        const res = await api<{ items: RfqRow[] }>("/rfq/inbox");
        setItems(res.items);
      } else {
        const res = await api<{ items: RfqRow[] }>("/public/rfqs");
        setItems(res.items);
      }
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={{ padding: 12, gap: 10 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text style={{ color: theme.text, fontSize: 20, fontWeight: "800" }}>Request for quotes</Text>
          <Button title="New request" icon="plus" kind="primary" onPress={() => navigation.navigate("RfqNew", undefined)} testID="rfq-new" />
        </View>
        <View style={{ flexDirection: "row", gap: 8 }}>
          {TABS.map((t) => (
            <Chip key={t.key} label={t.label} active={tab === t.key} onPress={() => setTab(t.key)} />
          ))}
        </View>
      </View>
      {loading ? (
        <View style={{ padding: 12, gap: 10 }}>
          <Skeleton height={80} radius={14} />
          <Skeleton height={80} radius={14} />
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ padding: 12, gap: 10 }}
          ListEmptyComponent={
            <Empty
              icon="quote"
              title={tab === "mine" ? "No requests yet" : tab === "inbox" ? "No requests waiting for a quote" : "No public requests right now"}
            />
          }
          renderItem={({ item }) => (
            <Pressable
              onPress={() => navigation.navigate("RfqDetail", { id: item.id })}
              accessibilityRole="button"
              style={{ backgroundColor: theme.panel, borderRadius: 14, borderWidth: 1, borderColor: theme.border, padding: 12, gap: 6 }}
            >
              <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <Text style={{ color: theme.dim, fontSize: 11 }}>{item.number}</Text>
                <Chip label={item.status.toLowerCase()} />
              </View>
              <Text style={{ color: theme.text, fontWeight: "800" }}>{item.title}</Text>
              <Text style={{ color: theme.dim, fontSize: 12 }}>
                {item.quantity ?? "Quantity not specified"} {item.location ? `· ${item.location}` : ""}
              </Text>
              <Text style={{ color: theme.dim, fontSize: 12 }}>{item.quoteCount} quote{item.quoteCount === 1 ? "" : "s"}{tab === "inbox" && !item.viewedAt ? " · new" : ""}</Text>
            </Pressable>
          )}
        />
      )}
    </SafeAreaView>
  );
}
