import { useEffect, useState } from "react";
import { FlatList, Pressable, SafeAreaView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError } from "../../api/client";
import type { SearchResult } from "../../api/types";
import { Avatar, Chip, Empty, Field, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { MeStackParamList } from "../../navigation/types";

const FACETS = [
  { key: "all", label: "All" },
  { key: "people", label: "People" },
  { key: "organizations", label: "Companies" },
  { key: "posts", label: "Posts" },
  { key: "jobs", label: "Jobs" },
  { key: "listings", label: "Listings" },
  { key: "groups", label: "Groups" },
  { key: "events", label: "Events" },
  { key: "rfqs", label: "RFQs" },
  { key: "opportunities", label: "Opportunities" },
];

function rowFor(r: SearchResult): { title: string; subtitle: string; avatarAssetId: string | null } {
  const item = r.item ?? {};
  if (r.type === "people") return { title: item.name, subtitle: item.headline ?? "", avatarAssetId: item.avatarAssetId };
  if (r.type === "organizations") return { title: item.displayName, subtitle: item.industry ?? "", avatarAssetId: item.logoAssetId };
  return { title: item.title ?? item.body ?? item.displayName ?? item.name ?? "Result", subtitle: item.subtitle ?? item.location ?? "", avatarAssetId: item.avatarAssetId ?? item.logoAssetId ?? null };
}

type Props = NativeStackScreenProps<MeStackParamList, "Search">;

export function SearchScreen({ navigation }: Props) {
  const { theme } = useTheme();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [type, setType] = useState("all");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [suggestQueries, setSuggestQueries] = useState<string[]>([]);

  useEffect(() => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const res = await api<{ results: SearchResult[] }>(`/search?q=${encodeURIComponent(q)}&type=${type}`);
        setResults(res.results);
      } catch (err) {
        toast((err as ApiError).message, { kind: "err" });
      }
      try {
        const s = await api<{ queries: string[] }>(`/search/suggest?q=${encodeURIComponent(q)}`);
        setSuggestQueries(s.queries);
      } catch {
        /* suggestions are best-effort */
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q, type]);

  async function openResult(r: SearchResult, index: number) {
    await api("/search/click", { method: "POST", body: { type: r.type, id: r.id, position: index, q } }).catch(() => {});
    if (r.type === "people" && r.item?.username) navigation.navigate("PersonProfile", { username: r.item.username });
    else if (r.type === "organizations" && r.item?.slug) navigation.navigate("Company", { slug: r.item.slug });
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={{ padding: 16, gap: 10 }}>
        <Field placeholder="Search Loopcom Community" value={q} onChangeText={setQ} autoFocus testID="search-input" />
        <FlatList
          horizontal
          data={FACETS}
          keyExtractor={(f) => f.key}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8 }}
          renderItem={({ item }) => <Chip label={item.label} active={type === item.key} onPress={() => setType(item.key)} testID={`search-facet-${item.key}`} />}
        />
      </View>
      {!q.trim() && suggestQueries.length ? (
        <View style={{ paddingHorizontal: 16, gap: 6 }}>
          <Text style={{ color: theme.dim, fontWeight: "700" }}>Recent</Text>
          {suggestQueries.map((s) => (
            <Pressable key={s} onPress={() => setQ(s)} accessibilityRole="button">
              <Text style={{ color: theme.text, paddingVertical: 6 }}>{s}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <FlatList
        data={results}
        keyExtractor={(r) => `${r.type}-${r.id}`}
        ListEmptyComponent={q.trim() ? <Empty icon="search" title="No results" /> : null}
        renderItem={({ item, index }) => {
          const row = rowFor(item);
          return (
            <Pressable onPress={() => openResult(item, index)} accessibilityRole="button" style={{ flexDirection: "row", gap: 10, padding: 14 }}>
              <Avatar assetId={row.avatarAssetId} name={row.title} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: theme.text, fontWeight: "700" }}>{row.title}</Text>
                <Text numberOfLines={1} style={{ color: theme.dim, fontSize: 12 }}>
                  {row.subtitle}
                </Text>
                <Text style={{ color: theme.dim, fontSize: 11 }}>{item.why}</Text>
              </View>
            </Pressable>
          );
        }}
      />
    </SafeAreaView>
  );
}
