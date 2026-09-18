import { useCallback, useEffect, useState } from "react";
import { FlatList, Image, Pressable, SafeAreaView, ScrollView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError } from "../../api/client";
import { Button, Chip, Field, Sheet, Skeleton, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { HomeStackParamList } from "../../navigation/types";
import { Lightbox } from "../../ui/Lightbox";

type ListingDetail = {
  listing: {
    id: string;
    type: string;
    title: string;
    description: string;
    priceMin: string | null;
    priceMax: string | null;
    priceUnit: string | null;
    minimumOrder: string | null;
    turnaround: string | null;
    delivery: string | null;
    availability: string;
    serviceArea: string[];
    viewCount: number;
  };
  seller: { organization: { id: string; displayName: string; slug?: string } | null; person: { id: string; name: string } | null };
  media: Array<{ id: string; url: string }>;
  verified: boolean;
  saved: boolean;
};

type Props = NativeStackScreenProps<HomeStackParamList, "ListingDetail">;

export function ListingDetailScreen({ route, navigation }: Props) {
  const { id } = route.params;
  const { theme } = useTheme();
  const toast = useToast();
  const [data, setData] = useState<ListingDetail | null>(null);
  const [messageOpen, setMessageOpen] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);

  const load = useCallback(() => {
    api<ListingDetail>(`/public/listings/${id}`)
      .then(setData)
      .catch((err) => toast((err as ApiError).message, { kind: "err" }));
  }, [id]);

  useEffect(load, [load]);

  async function toggleSave() {
    if (!data) return;
    try {
      if (data.saved) await api(`/listings/${id}/save`, { method: "DELETE" });
      else await api(`/listings/${id}/save`, { method: "POST" });
      load();
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  if (!data) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg, padding: 16 }}>
        <Skeleton height={160} radius={16} />
      </SafeAreaView>
    );
  }

  const l = data.listing;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScrollView contentContainerStyle={{ paddingBottom: 24, gap: 14 }}>
        {data.media.length ? (
          <FlatList
            horizontal
            data={data.media}
            keyExtractor={(m) => m.id}
            pagingEnabled
            renderItem={({ item }) => (
              <Pressable onPress={() => setLightbox(item.url)} accessibilityRole="imagebutton" accessibilityLabel="Open photo">
                <Image source={{ uri: item.url }} style={{ width: 375, height: 220 }} resizeMode="cover" />
              </Pressable>
            )}
          />
        ) : null}
        <View style={{ paddingHorizontal: 16, gap: 10 }}>
          <Text style={{ color: theme.text, fontSize: 20, fontWeight: "800" }}>{l.title}</Text>
          <Text
            style={{ color: theme.accent }}
            onPress={() => data.seller.organization?.slug && navigation.navigate("Company", { slug: data.seller.organization.slug })}
          >
            {data.seller.organization?.displayName ?? data.seller.person?.name ?? "Seller"}
            {data.verified ? " · Verified" : ""}
          </Text>

          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Chip label={l.type.toLowerCase()} />
            <Chip label={l.availability.toLowerCase().replace("_", " ")} />
            {l.minimumOrder ? <Chip label={`Min order: ${l.minimumOrder}`} /> : null}
            {l.turnaround ? <Chip label={`Turnaround: ${l.turnaround}`} /> : null}
          </View>

          <Text style={{ color: theme.text, fontSize: 18, fontWeight: "800" }}>
            {l.priceMin || l.priceMax
              ? `$${Number(l.priceMin ?? l.priceMax).toLocaleString()}${l.priceMax && l.priceMin && l.priceMax !== l.priceMin ? `–$${Number(l.priceMax).toLocaleString()}` : ""}${l.priceUnit ? ` /${l.priceUnit}` : ""}`
              : "Price on request"}
          </Text>

          <Text style={{ color: theme.text, lineHeight: 20 }}>{l.description}</Text>

          {l.serviceArea.length ? <Text style={{ color: theme.dim, fontSize: 12 }}>Service area: {l.serviceArea.join(", ")}</Text> : null}

          <View style={{ flexDirection: "row", gap: 10 }}>
            <Button title="Message seller" icon="msg" kind="primary" onPress={() => setMessageOpen(true)} testID="listing-message" />
            <Button title={data.saved ? "Saved" : "Save"} icon="save" onPress={toggleSave} testID="listing-save" />
          </View>
        </View>
      </ScrollView>

      <MessageSellerSheet visible={messageOpen} onClose={() => setMessageOpen(false)} listingId={id} navigation={navigation} title={l.title} />
      <Lightbox uri={lightbox} onClose={() => setLightbox(null)} />
    </SafeAreaView>
  );
}

function MessageSellerSheet({
  visible,
  onClose,
  listingId,
  navigation,
  title,
}: {
  visible: boolean;
  onClose: () => void;
  listingId: string;
  navigation: Props["navigation"];
  title: string;
}) {
  const toast = useToast();
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!body.trim()) return;
    setBusy(true);
    try {
      const res = await api<{ threadId: string }>(`/listings/${listingId}/message`, { method: "POST", body: { body: body.trim() } });
      onClose();
      (navigation.getParent() as any)?.navigate("MessagesTab", { screen: "Conversation", params: { threadId: res.threadId, title } });
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet visible={visible} onClose={onClose} title="Message seller">
      <Field label="Message" value={body} onChangeText={setBody} multiline placeholder={`Hi, I'm interested in ${title}...`} testID="listing-message-body" />
      <View style={{ height: 10 }} />
      <Button title="Send" kind="primary" wide onPress={submit} loading={busy} testID="listing-message-send" />
    </Sheet>
  );
}
