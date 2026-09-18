import { useCallback, useEffect, useState } from "react";
import { FlatList, Image, Pressable, SafeAreaView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError } from "../../api/client";
import { Button, Chip, Empty, Field, Icon, Skeleton, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { HomeStackParamList } from "../../navigation/types";

type Category = { id: string; slug: string; name: string; count: number; children?: Category[] };

type ListingRow = {
  listing: { id: string; type: string; title: string; priceMin: string | null; priceMax: string | null; priceUnit: string | null; availability: string };
  seller: { organization: { id: string; displayName: string } | null; person: { id: string; name: string } | null };
  media: Array<{ id: string; url: string }>;
  verified: boolean;
  saved: boolean;
};

const CATEGORY_CHIPS_LIMIT = 12;

type Props = NativeStackScreenProps<HomeStackParamList, "MarketplaceList">;

export function MarketplaceListScreen({ navigation }: Props) {
  const { theme } = useTheme();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<string | undefined>(undefined);
  const [categories, setCategories] = useState<Category[]>([]);
  const [items, setItems] = useState<ListingRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ categories: Category[] }>("/marketplace/categories").then((r) => setCategories(r.categories)).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (q.trim()) qs.set("q", q.trim());
      if (category) qs.set("category", category);
      const res = await api<{ items: ListingRow[] }>(`/listings?${qs.toString()}`);
      setItems(res.items);
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setLoading(false);
    }
  }, [q, category]);

  useEffect(() => {
    load();
  }, [load]);

  async function toggleSave(row: ListingRow) {
    try {
      if (row.saved) await api(`/listings/${row.listing.id}/save`, { method: "DELETE" });
      else await api(`/listings/${row.listing.id}/save`, { method: "POST" });
      setItems((prev) => prev.map((r) => (r.listing.id === row.listing.id ? { ...r, saved: !r.saved } : r)));
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  function priceLine(l: ListingRow["listing"]): string {
    if (!l.priceMin && !l.priceMax) return "Price on request";
    const unit = l.priceUnit ? ` /${l.priceUnit}` : "";
    if (l.priceMin && l.priceMax && l.priceMin !== l.priceMax) return `$${Number(l.priceMin).toLocaleString()}–$${Number(l.priceMax).toLocaleString()}${unit}`;
    return `$${Number(l.priceMin ?? l.priceMax).toLocaleString()}${unit}`;
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={{ padding: 12, gap: 10 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text style={{ color: theme.text, fontSize: 20, fontWeight: "800" }}>Marketplace</Text>
          <Button title="Post" icon="plus" kind="primary" onPress={() => navigation.navigate("PostListing")} testID="marketplace-post" />
        </View>
        <Field placeholder="Search products & services" value={q} onChangeText={setQ} onSubmitEditing={load} testID="marketplace-search" />
        <FlatList
          horizontal
          showsHorizontalScrollIndicator={false}
          data={[{ id: "all", slug: undefined as any, name: "All", count: 0 }, ...categories.slice(0, CATEGORY_CHIPS_LIMIT)]}
          keyExtractor={(c) => c.id}
          contentContainerStyle={{ gap: 8 }}
          renderItem={({ item }) => <Chip label={item.slug ? item.name : "All"} active={category === item.slug} onPress={() => setCategory(item.slug)} />}
        />
      </View>
      {loading ? (
        <View style={{ padding: 12 }}>
          <Skeleton height={120} radius={14} />
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(r) => r.listing.id}
          numColumns={2}
          columnWrapperStyle={{ gap: 10 }}
          contentContainerStyle={{ padding: 12, gap: 10 }}
          ListEmptyComponent={<Empty icon="wallet" title="No listings match" />}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => navigation.navigate("ListingDetail", { id: item.listing.id })}
              accessibilityRole="button"
              style={{ flex: 1, backgroundColor: theme.panel, borderRadius: 14, borderWidth: 1, borderColor: theme.border, overflow: "hidden" }}
            >
              {item.media[0] ? (
                <Image source={{ uri: item.media[0].url }} style={{ width: "100%", height: 100 }} />
              ) : (
                <View style={{ width: "100%", height: 100, backgroundColor: theme.panel2, alignItems: "center", justifyContent: "center" }}>
                  <Icon name="wallet" size={24} color={theme.dim} />
                </View>
              )}
              <View style={{ padding: 10, gap: 4 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 6 }}>
                  <Text numberOfLines={2} style={{ color: theme.text, fontWeight: "700", fontSize: 13, flex: 1 }}>
                    {item.listing.title}
                  </Text>
                  <Pressable accessibilityRole="button" accessibilityLabel={item.saved ? "Unsave" : "Save"} onPress={() => toggleSave(item)} hitSlop={6}>
                    <Icon name="save" size={16} color={item.saved ? theme.accent : theme.dim} />
                  </Pressable>
                </View>
                <Text style={{ color: theme.text, fontWeight: "800", fontSize: 12 }}>{priceLine(item.listing)}</Text>
                <Text numberOfLines={1} style={{ color: theme.dim, fontSize: 11 }}>
                  {item.seller.organization?.displayName ?? item.seller.person?.name ?? "Seller"}
                  {item.verified ? " ✓" : ""}
                </Text>
              </View>
            </Pressable>
          )}
        />
      )}
    </SafeAreaView>
  );
}
