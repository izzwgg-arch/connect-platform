import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import { useCallback, useEffect, useRef, useState } from "react";
import { FlatList, RefreshControl, SafeAreaView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError } from "../../api/client";
import type { FeedItem, PostDTO } from "../../api/types";
import { Chip, Empty, Icon, Skeleton, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { HomeStackParamList } from "../../navigation/types";
import { PostCard } from "./PostCard";

const MODES: Array<{ key: string; label: string }> = [
  { key: "for_you", label: "For you" },
  { key: "following", label: "Following" },
  { key: "latest", label: "Latest" },
  { key: "industry", label: "Industry" },
  { key: "local", label: "Local" },
  { key: "opportunities", label: "Opportunities" },
  { key: "jobs", label: "Jobs" },
];

const CACHE_KEY = "lc.feedCache";

type Props = NativeStackScreenProps<HomeStackParamList, "Feed">;

export function FeedScreen({ navigation }: Props) {
  const { theme } = useTheme();
  const toast = useToast();
  const [mode, setMode] = useState("for_you");
  const [items, setItems] = useState<FeedItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [offline, setOffline] = useState(false);
  const seenImpressions = useRef(new Set<string>());

  const load = useCallback(
    async (opts: { fresh?: boolean } = {}) => {
      try {
        const net = await NetInfo.fetch();
        if (!net.isConnected) {
          setOffline(true);
          if (opts.fresh) {
            const cached = await AsyncStorage.getItem(CACHE_KEY);
            if (cached) setItems(JSON.parse(cached));
          }
          return;
        }
        setOffline(false);
        const qs = new URLSearchParams({ mode, ...(opts.fresh ? {} : cursor ? { cursor } : {}) });
        const res = await api<{ items: FeedItem[]; nextCursor: string | null }>(`/feed?${qs.toString()}`);
        setItems((prev) => (opts.fresh ? res.items : [...prev, ...res.items]));
        setCursor(res.nextCursor);
        if (opts.fresh) AsyncStorage.setItem(CACHE_KEY, JSON.stringify(res.items.slice(0, 20))).catch(() => {});
      } catch (err) {
        toast((err as ApiError).message, { kind: "err" });
      }
    },
    [mode, cursor],
  );

  useEffect(() => {
    setLoading(true);
    setCursor(null);
    load({ fresh: true }).finally(() => setLoading(false));
  }, [mode]);

  async function onRefresh() {
    setRefreshing(true);
    await load({ fresh: true });
    setRefreshing(false);
  }

  function updatePost(id: string, next: PostDTO) {
    setItems((prev) => prev.map((f) => (f.post.id === id ? { ...f, post: next } : f)));
  }

  const onViewableItemsChanged = useRef(({ viewableItems }: any) => {
    for (const v of viewableItems) {
      const item: FeedItem = v.item;
      if (!item?.post?.id || seenImpressions.current.has(item.post.id)) continue;
      seenImpressions.current.add(item.post.id);
      api(`/posts/${item.post.id}/impression`, { method: "POST", body: { surface: "feed", recommendationId: item.recommendationId } }).catch(() => {});
    }
  }).current;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={{ paddingHorizontal: 12, paddingTop: 8 }}>
        <FlatList
          horizontal
          data={MODES}
          keyExtractor={(m) => m.key}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8, paddingBottom: 8 }}
          renderItem={({ item }) => <Chip label={item.label} active={mode === item.key} onPress={() => setMode(item.key)} testID={`feed-mode-${item.key}`} />}
        />
      </View>
      {offline ? (
        <View style={{ backgroundColor: theme.warning, padding: 8 }}>
          <Text style={{ textAlign: "center", color: "#1a1200", fontSize: 12 }}>You're offline — showing what we had.</Text>
        </View>
      ) : null}
      {loading ? (
        <View style={{ padding: 16, gap: 12 }}>
          <Skeleton height={140} radius={16} />
          <Skeleton height={140} radius={16} />
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(f) => f.post.id}
          contentContainerStyle={{ padding: 12, gap: 12 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accent} />}
          onEndReachedThreshold={0.4}
          onEndReached={() => cursor && load()}
          onViewableItemsChanged={onViewableItemsChanged}
          viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
          ListEmptyComponent={<Empty icon="brief" title="Nothing here yet" hint="Follow people and companies to fill your feed." />}
          renderItem={({ item }) => (
            <PostCard
              item={item.post}
              onChange={(next) => updatePost(item.post.id, next)}
              onOpenProfile={(username) => navigation.navigate("PersonProfile", { username })}
              onOpenOrg={(slug) => navigation.navigate("Company", { slug })}
            />
          )}
        />
      )}
    </SafeAreaView>
  );
}
