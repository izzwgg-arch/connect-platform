import { useCallback, useEffect, useState } from "react";
import { FlatList, Image, Pressable, SafeAreaView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError, mediaUrl } from "../../api/client";
import { Chip, Empty, Field, Icon, Skeleton, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { HomeStackParamList } from "../../navigation/types";

type GroupRow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  category: string | null;
  isPrivate: boolean;
  coverAssetId: string | null;
  logoAssetId: string | null;
  memberCount: number;
  myMembership: { role: string; state: string } | null;
};

type Props = NativeStackScreenProps<HomeStackParamList, "GroupsList">;

export function GroupsListScreen({ navigation }: Props) {
  const { theme } = useTheme();
  const toast = useToast();
  const [tab, setTab] = useState<"mine" | "discover">("mine");
  const [q, setQ] = useState("");
  const [items, setItems] = useState<GroupRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (tab === "mine") {
        const res = await api<{ items: GroupRow[] }>("/me/groups");
        setItems(res.items);
      } else {
        const qs = new URLSearchParams();
        if (q.trim()) qs.set("q", q.trim());
        const res = await api<{ items: GroupRow[] }>(`/groups?${qs.toString()}`);
        setItems(res.items);
      }
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setLoading(false);
    }
  }, [tab, q]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={{ padding: 12, gap: 10 }}>
        <Text style={{ color: theme.text, fontSize: 20, fontWeight: "800" }}>Groups</Text>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Chip label="Mine" active={tab === "mine"} onPress={() => setTab("mine")} />
          <Chip label="Discover" active={tab === "discover"} onPress={() => setTab("discover")} />
        </View>
        {tab === "discover" ? <Field placeholder="Search groups" value={q} onChangeText={setQ} onSubmitEditing={load} testID="groups-search" /> : null}
      </View>
      {loading ? (
        <View style={{ padding: 12 }}>
          <Skeleton height={100} radius={14} />
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(g) => g.id}
          contentContainerStyle={{ padding: 12, gap: 10 }}
          ListEmptyComponent={<Empty icon="group" title={tab === "mine" ? "You haven't joined any groups" : "No groups match"} />}
          renderItem={({ item }) => {
            const logo = mediaUrl(item.logoAssetId, "thumb");
            return (
              <Pressable
                onPress={() => navigation.navigate("GroupDetail", { slug: item.slug })}
                accessibilityRole="button"
                style={{ flexDirection: "row", gap: 10, alignItems: "center", backgroundColor: theme.panel, borderRadius: 14, borderWidth: 1, borderColor: theme.border, padding: 12 }}
              >
                {logo ? (
                  <Image source={{ uri: logo }} style={{ width: 44, height: 44, borderRadius: 10, backgroundColor: theme.panel2 }} />
                ) : (
                  <View style={{ width: 44, height: 44, borderRadius: 10, backgroundColor: theme.panel2, alignItems: "center", justifyContent: "center" }}>
                    <Icon name="group" size={20} />
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={{ color: theme.text, fontWeight: "700" }}>
                    {item.name} {item.isPrivate ? <Icon name="lock" size={12} /> : null}
                  </Text>
                  <Text style={{ color: theme.dim, fontSize: 12 }} numberOfLines={1}>
                    {item.memberCount} members{item.category ? ` · ${item.category}` : ""}
                  </Text>
                </View>
                {item.myMembership ? <Chip label={item.myMembership.state === "PENDING" ? "Pending" : "Joined"} /> : null}
              </Pressable>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}
