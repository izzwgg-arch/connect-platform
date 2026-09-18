import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { useState } from "react";
import { Image, SafeAreaView, ScrollView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError, uploadMedia } from "../../api/client";
import { useAuth } from "../../auth/AuthProvider";
import { Button, Chip, Field, Icon, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { RootStackParamList } from "../../navigation/types";

type Props = NativeStackScreenProps<RootStackParamList, "Composer">;

const VISIBILITIES = [
  { key: "PUBLIC", label: "Anyone" },
  { key: "CONNECTIONS", label: "Connections" },
  { key: "ORGANIZATION", label: "My company" },
];

export function ComposerScreen({ navigation, route }: Props) {
  const { theme } = useTheme();
  const toast = useToast();
  const { me, reload } = useAuth();
  const [body, setBody] = useState("");
  const [media, setMedia] = useState<Array<{ id: string; uri: string }>>([]);
  const [visibility, setVisibility] = useState("PUBLIC");
  const [postAsOrgId, setPostAsOrgId] = useState<string | null>(route.params?.replyToOrgId ?? null);
  const [pollOpen, setPollOpen] = useState(false);
  const [pollQuestion, setPollQuestion] = useState("");
  const [pollOptions, setPollOptions] = useState(["", ""]);
  const [uploading, setUploading] = useState(false);
  const [posting, setPosting] = useState(false);

  const orgMemberships = me?.memberships.filter((m) => m.permissions.includes("org.post") || m.role === "OWNER" || m.role === "ADMIN") ?? [];

  async function pickPhotos() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      toast("Photo library access is off. Enable it in Settings to attach photos.", { kind: "err" });
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, allowsMultipleSelection: true, quality: 0.85 });
    if (result.canceled) return;
    setUploading(true);
    try {
      for (const asset of result.assets) {
        const uploaded = await uploadMedia(asset.uri, asset.fileName ?? `photo-${Date.now()}.jpg`, asset.mimeType ?? "image/jpeg");
        setMedia((prev) => [...prev, { id: uploaded.asset.id, uri: asset.uri }]);
      }
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setUploading(false);
    }
  }

  async function pickDocument() {
    const result = await DocumentPicker.getDocumentAsync({ multiple: false, type: "*/*" });
    if (result.canceled) return;
    const file = result.assets[0];
    setUploading(true);
    try {
      const uploaded = await uploadMedia(file.uri, file.name, file.mimeType ?? "application/octet-stream");
      setMedia((prev) => [...prev, { id: uploaded.asset.id, uri: file.uri }]);
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setUploading(false);
    }
  }

  async function submit() {
    if (!body.trim() && !media.length && !(pollOpen && pollQuestion.trim())) {
      toast("Write something, add media, or a poll first.", { kind: "err" });
      return;
    }
    setPosting(true);
    try {
      const poll =
        pollOpen && pollQuestion.trim() && pollOptions.filter((o) => o.trim()).length >= 2
          ? { question: pollQuestion.trim(), options: pollOptions.filter((o) => o.trim()) }
          : undefined;
      await api("/posts", {
        method: "POST",
        body: {
          body: body.trim() || undefined,
          mediaAssetIds: media.map((m) => m.id),
          visibility,
          organizationId: postAsOrgId ?? undefined,
          poll,
        },
      });
      toast("Posted.");
      navigation.goBack();
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setPosting(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 16 }}>
        <Button title="Cancel" kind="ghost" onPress={() => navigation.goBack()} testID="composer-cancel" />
        <Text style={{ color: theme.text, fontWeight: "800", fontSize: 16 }}>New post</Text>
        <Button title="Post" kind="primary" onPress={submit} loading={posting} testID="composer-post" />
      </View>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }}>
        {orgMemberships.length ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            <Chip label={me?.profile ? `${me.profile.firstName} ${me.profile.lastName}` : "Me"} active={!postAsOrgId} onPress={() => setPostAsOrgId(null)} />
            {orgMemberships.map((m) => (
              <Chip key={m.organization.id} label={m.organization.displayName} active={postAsOrgId === m.organization.id} onPress={() => setPostAsOrgId(m.organization.id)} />
            ))}
          </View>
        ) : null}

        <Field placeholder="What's happening in your business?" value={body} onChangeText={setBody} multiline testID="composer-body" />

        {media.length ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {media.map((m) => (
              <Image key={m.id} source={{ uri: m.uri }} style={{ width: 90, height: 90, borderRadius: 10 }} />
            ))}
          </View>
        ) : null}

        {pollOpen ? (
          <View style={{ gap: 8 }}>
            <Field placeholder="Ask a question" value={pollQuestion} onChangeText={setPollQuestion} testID="composer-poll-question" />
            {pollOptions.map((opt, i) => (
              <Field key={i} placeholder={`Option ${i + 1}`} value={opt} onChangeText={(v) => setPollOptions((prev) => prev.map((o, j) => (j === i ? v : o)))} />
            ))}
            {pollOptions.length < 6 ? <Button title="Add option" onPress={() => setPollOptions((p) => [...p, ""])} /> : null}
          </View>
        ) : null}

        <View style={{ flexDirection: "row", gap: 16 }}>
          <Button title="Photo" icon="image" onPress={pickPhotos} loading={uploading} testID="composer-photo" />
          <Button title="File" icon="doc" onPress={pickDocument} loading={uploading} testID="composer-file" />
          <Button title="Poll" icon="poll" onPress={() => setPollOpen((v) => !v)} testID="composer-poll" />
        </View>

        <View style={{ gap: 6 }}>
          <Text style={{ color: theme.dim, fontSize: 13, fontWeight: "600" }}>Who can see this</Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {VISIBILITIES.map((v) => (
              <Chip key={v.key} label={v.label} active={visibility === v.key} onPress={() => setVisibility(v.key)} />
            ))}
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
