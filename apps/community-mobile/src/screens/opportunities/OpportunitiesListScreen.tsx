import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, SafeAreaView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError } from "../../api/client";
import { Avatar, Button, Chip, Empty, Skeleton, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { HomeStackParamList } from "../../navigation/types";

type OppType = { id: string; slug: string; name: string; description: string; count: number };

type OppRow = {
  opportunity: { id: string; title: string; description: string; location: string | null; interestCount: number; createdAt: string };
  type: { id: string; slug: string; name: string } | null;
  poster: { id: string; name: string; avatarAssetId: string | null } | null;
  organization: { id: string; displayName: string; logoAssetId: string | null } | null;
  myInterest: boolean;
};

type Props = NativeStackScreenProps<HomeStackParamList, "OpportunitiesList">;

export function OpportunitiesListScreen({ navigation }: Props) {
  const { theme } = useTheme();
  const toast = useToast();
  const [types, setTypes] = useState<OppType[]>([]);
  const [typeSlug, setTypeSlug] = useState<string | undefined>(undefined);
  const [items, setItems] = useState<OppRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ types: OppType[] }>("/opportunities/types").then((r) => setTypes(r.types)).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (typeSlug) qs.set("type", typeSlug);
      const res = await api<{ items: OppRow[] }>(`/opportunities?${qs.toString()}`);
      setItems(res.items);
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setLoading(false);
    }
  }, [typeSlug]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={{ padding: 12, gap: 10 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text style={{ color: theme.text, fontSize: 20, fontWeight: "800" }}>Opportunities</Text>
          <Button title="Post" icon="plus" kind="primary" onPress={() => navigation.navigate("PostOpportunity", typeSlug ? { typeSlug } : undefined)} testID="opportunities-post" />
        </View>
        <FlatList
          horizontal
          showsHorizontalScrollIndicator={false}
          data={[{ id: "all", slug: undefined as any, name: "All", description: "", count: 0 }, ...types]}
          keyExtractor={(t) => t.id}
          contentContainerStyle={{ gap: 8 }}
          renderItem={({ item }) => <Chip label={item.slug ? `${item.name} (${item.count})` : "All"} active={typeSlug === item.slug} onPress={() => setTypeSlug(item.slug)} />}
        />
      </View>
      {loading ? (
        <View style={{ padding: 12 }}>
          <Skeleton height={100} radius={14} />
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(r) => r.opportunity.id}
          contentContainerStyle={{ padding: 12, gap: 10 }}
          ListEmptyComponent={<Empty icon="tag" title="No opportunities match" />}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => navigation.navigate("OpportunityDetail", { id: item.opportunity.id })}
              accessibilityRole="button"
              style={{ backgroundColor: theme.panel, borderRadius: 14, borderWidth: 1, borderColor: theme.border, padding: 12, gap: 6 }}
            >
              <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
                <Avatar assetId={item.organization?.logoAssetId ?? item.poster?.avatarAssetId} name={item.organization?.displayName ?? item.poster?.name} size={36} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: theme.text, fontWeight: "800" }}>{item.opportunity.title}</Text>
                  <Text style={{ color: theme.dim, fontSize: 12 }}>{item.organization?.displayName ?? item.poster?.name ?? "Someone"}</Text>
                </View>
                {item.type ? <Chip label={item.type.name} /> : null}
              </View>
              <Text numberOfLines={2} style={{ color: theme.text, fontSize: 13 }}>
                {item.opportunity.description}
              </Text>
              <Text style={{ color: theme.dim, fontSize: 12 }}>
                {item.opportunity.location ?? "Anywhere"} · {item.opportunity.interestCount} interested{item.myInterest ? " · you're interested" : ""}
              </Text>
            </Pressable>
          )}
        />
      )}
    </SafeAreaView>
  );
}
