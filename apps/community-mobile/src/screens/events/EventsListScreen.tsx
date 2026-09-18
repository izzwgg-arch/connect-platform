import { useCallback, useEffect, useState } from "react";
import { FlatList, Image, Pressable, SafeAreaView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError, mediaUrl } from "../../api/client";
import { Chip, Empty, Skeleton, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { HomeStackParamList } from "../../navigation/types";

type EventRow = {
  id: string;
  slug: string;
  title: string;
  mode: string;
  startsAt: string;
  venue: string | null;
  onlineUrl: string | null;
  coverAssetId: string | null;
  rsvpCount: number;
  relation?: "HOST" | "GOING" | "INTERESTED" | "WAITLIST";
};

const TABS: Array<{ key: "upcoming" | "past" | "mine"; label: string }> = [
  { key: "upcoming", label: "Upcoming" },
  { key: "past", label: "Past" },
  { key: "mine", label: "Mine" },
];

type Props = NativeStackScreenProps<HomeStackParamList, "EventsList">;

export function EventsListScreen({ navigation }: Props) {
  const { theme } = useTheme();
  const toast = useToast();
  const [tab, setTab] = useState<"upcoming" | "past" | "mine">("upcoming");
  const [items, setItems] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (tab === "mine") {
        const res = await api<{ items: EventRow[] }>("/me/events");
        setItems(res.items);
      } else {
        const res = await api<{ items: EventRow[] }>(`/events?when=${tab}`);
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
        <Text style={{ color: theme.text, fontSize: 20, fontWeight: "800" }}>Events</Text>
        <View style={{ flexDirection: "row", gap: 8 }}>
          {TABS.map((t) => (
            <Chip key={t.key} label={t.label} active={tab === t.key} onPress={() => setTab(t.key)} />
          ))}
        </View>
      </View>
      {loading ? (
        <View style={{ padding: 12, gap: 10 }}>
          <Skeleton height={140} radius={14} />
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(e) => e.id}
          contentContainerStyle={{ padding: 12, gap: 10 }}
          ListEmptyComponent={<Empty icon="cal" title="No events here" />}
          renderItem={({ item }) => {
            const cover = mediaUrl(item.coverAssetId, "medium");
            return (
              <Pressable
                onPress={() => navigation.navigate("EventDetail", { id: item.id, slug: item.slug })}
                accessibilityRole="button"
                style={{ backgroundColor: theme.panel, borderRadius: 14, borderWidth: 1, borderColor: theme.border, overflow: "hidden" }}
              >
                {cover ? <Image source={{ uri: cover }} style={{ width: "100%", height: 110 }} /> : null}
                <View style={{ padding: 12, gap: 4 }}>
                  <Text style={{ color: theme.text, fontWeight: "800" }}>{item.title}</Text>
                  <Text style={{ color: theme.dim, fontSize: 12 }}>
                    {new Date(item.startsAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
                  </Text>
                  <Text style={{ color: theme.dim, fontSize: 12 }}>{item.mode === "ONLINE" ? "Online" : item.venue ?? "In person"}</Text>
                  <View style={{ flexDirection: "row", gap: 6 }}>
                    {item.relation ? <Chip label={item.relation === "HOST" ? "Hosting" : item.relation.toLowerCase()} /> : null}
                    <Chip label={`${item.rsvpCount} going`} />
                  </View>
                </View>
              </Pressable>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}
