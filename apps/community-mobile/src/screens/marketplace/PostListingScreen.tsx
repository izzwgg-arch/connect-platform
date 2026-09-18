import * as ImagePicker from "expo-image-picker";
import { useEffect, useState } from "react";
import { Image, SafeAreaView, ScrollView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError, uploadMedia } from "../../api/client";
import { Button, Chip, Field, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { HomeStackParamList } from "../../navigation/types";

type Category = { id: string; slug: string; name: string; children?: Category[] };

const TYPES = [
  { key: "PRODUCT", label: "Product" },
  { key: "SERVICE", label: "Service" },
  { key: "EQUIPMENT", label: "Equipment" },
] as const;

type Props = NativeStackScreenProps<HomeStackParamList, "PostListing">;

export function PostListingScreen({ navigation }: Props) {
  const { theme } = useTheme();
  const toast = useToast();
  const [type, setType] = useState<(typeof TYPES)[number]["key"]>("PRODUCT");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priceMin, setPriceMin] = useState("");
  const [priceUnit, setPriceUnit] = useState("");
  const [categories, setCategories] = useState<Category[]>([]);
  const [categorySlug, setCategorySlug] = useState<string | undefined>(undefined);
  const [photos, setPhotos] = useState<Array<{ uri: string; name: string; mimeType: string }>>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api<{ categories: Category[] }>("/marketplace/categories").then((r) => setCategories(r.categories)).catch(() => {});
  }, []);

  async function pickPhotos() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      toast("Photo library access is off.", { kind: "err" });
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, allowsMultipleSelection: true, selectionLimit: 10, quality: 0.85 });
    if (result.canceled) return;
    setPhotos((prev) => [...prev, ...result.assets.map((a) => ({ uri: a.uri, name: a.fileName ?? "photo.jpg", mimeType: a.mimeType ?? "image/jpeg" }))].slice(0, 10));
  }

  async function submit() {
    if (title.trim().length < 3 || description.trim().length < 1) {
      toast("A title and description are needed.", { kind: "err" });
      return;
    }
    setSubmitting(true);
    try {
      const mediaAssetIds: string[] = [];
      for (const p of photos) {
        const uploaded = await uploadMedia(p.uri, p.name, p.mimeType);
        mediaAssetIds.push(uploaded.asset.id);
      }
      const res = await api<{ listing: { id: string } }>("/listings", {
        method: "POST",
        body: {
          type,
          title: title.trim(),
          description: description.trim(),
          categorySlug,
          priceMin: priceMin.trim() ? Number(priceMin.trim()) : undefined,
          priceUnit: priceUnit.trim() || undefined,
          mediaAssetIds,
        },
      });
      toast("Listing posted.");
      navigation.replace("ListingDetail", { id: res.listing.id });
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }}>
        <Text style={{ color: theme.text, fontWeight: "800", fontSize: 18 }}>Post a listing</Text>
        <View style={{ flexDirection: "row", gap: 8 }}>
          {TYPES.map((t) => (
            <Chip key={t.key} label={t.label} active={type === t.key} onPress={() => setType(t.key)} />
          ))}
        </View>
        <Field label="Title" value={title} onChangeText={setTitle} testID="listing-title" />
        <Field label="Description" value={description} onChangeText={setDescription} multiline testID="listing-description" />
        <Field label="Price (optional)" keyboardType="decimal-pad" value={priceMin} onChangeText={setPriceMin} testID="listing-price" />
        <Field label="Price unit (optional, e.g. 'sq ft')" value={priceUnit} onChangeText={setPriceUnit} testID="listing-price-unit" />

        {categories.length ? (
          <View style={{ gap: 6 }}>
            <Text style={{ color: theme.dim, fontSize: 13, fontWeight: "600" }}>Category</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {categories.map((c) => (
                <Chip key={c.id} label={c.name} active={categorySlug === c.slug} onPress={() => setCategorySlug(c.slug)} />
              ))}
            </View>
          </View>
        ) : null}

        <View style={{ gap: 8 }}>
          <Button title="Add photos" icon="cam" onPress={pickPhotos} testID="listing-add-photos" />
          {photos.length ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {photos.map((p, i) => (
                <Image key={i} source={{ uri: p.uri }} style={{ width: 64, height: 64, borderRadius: 8 }} />
              ))}
            </View>
          ) : null}
        </View>

        <Button title="Post listing" kind="primary" wide onPress={submit} loading={submitting} testID="listing-submit" />
      </ScrollView>
    </SafeAreaView>
  );
}
