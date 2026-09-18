import * as DocumentPicker from "expo-document-picker";
import { useCallback, useEffect, useState } from "react";
import { Image, Linking, Pressable, SafeAreaView, ScrollView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError, mediaUrl, uploadMedia } from "../../api/client";
import type { PostDTO } from "../../api/types";
import { Avatar, Button, Chip, Empty, Icon, Skeleton, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { HomeStackParamList } from "../../navigation/types";
import { PostCard } from "../home/PostCard";

type GroupPublic = {
  group: { id: string; slug: string; name: string; description: string | null; isPrivate: boolean; coverAssetId?: string | null; logoAssetId?: string | null; memberCount: number };
  preview: boolean;
  rules?: string | null;
  admins?: Array<{ id: string; name: string }>;
  counts?: { members: number; posts: number; files: number; events: number };
  myMembership: { role: string; state: string } | null;
};

type Member = { person: { id: string; name: string; username: string; avatarAssetId: string | null } | null; role: string; state: string };
type GroupFile = { id: string; assetId: string; title: string; uploader: { id: string; name: string } | null; createdAt: string };

const TABS = ["Feed", "Members", "Files"] as const;

type Props = NativeStackScreenProps<HomeStackParamList, "GroupDetail">;

export function GroupDetailScreen({ route, navigation }: Props) {
  const { slug } = route.params;
  const { theme } = useTheme();
  const toast = useToast();
  const [data, setData] = useState<GroupPublic | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]>("Feed");
  const [posts, setPosts] = useState<PostDTO[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [files, setFiles] = useState<GroupFile[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<GroupPublic>(`/public/groups/${slug}`)
      .then(setData)
      .catch((err) => toast((err as ApiError).message, { kind: "err" }));
  }, [slug]);

  useEffect(load, [load]);

  useEffect(() => {
    if (!data || data.preview) return;
    if (tab === "Feed") {
      api<{ items: PostDTO[] }>(`/groups/${data.group.id}/posts`).then((r) => setPosts(r.items)).catch(() => setPosts([]));
    } else if (tab === "Members") {
      api<{ items: Member[] }>(`/groups/${data.group.id}/members`).then((r) => setMembers(r.items)).catch(() => setMembers([]));
    } else if (tab === "Files") {
      api<{ items: GroupFile[] }>(`/groups/${data.group.id}/files`).then((r) => setFiles(r.items)).catch(() => setFiles([]));
    }
  }, [tab, data?.group.id, data?.preview]);

  async function join() {
    if (!data) return;
    setBusy(true);
    try {
      await api(`/groups/${data.group.id}/join`, { method: "POST" });
      toast(data.group.isPrivate ? "Requested to join." : "Joined.");
      load();
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  async function leave() {
    if (!data) return;
    setBusy(true);
    try {
      await api(`/groups/${data.group.id}/leave`, { method: "POST" });
      load();
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  async function openChat() {
    if (!data) return;
    try {
      const res = await api<{ threadId: string }>(`/groups/${data.group.id}/chat`, { method: "GET" });
      (navigation.getParent() as any)?.navigate("MessagesTab", { screen: "Conversation", params: { threadId: res.threadId, title: data.group.name } });
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  async function uploadFile() {
    if (!data) return;
    const result = await DocumentPicker.getDocumentAsync({ multiple: false });
    if (result.canceled) return;
    const file = result.assets[0];
    try {
      const form = new FormData();
      form.append("file", { uri: file.uri, name: file.name, type: file.mimeType ?? "application/octet-stream" } as any);
      form.append("title", file.name);
      await api(`/groups/${data.group.id}/files`, { method: "POST", form: form as any });
      const r = await api<{ items: GroupFile[] }>(`/groups/${data.group.id}/files`);
      setFiles(r.items);
      toast("File shared.");
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  if (!data) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg, padding: 16 }}>
        <Skeleton height={120} radius={16} />
      </SafeAreaView>
    );
  }

  const g = data.group;
  const isMember = data.myMembership?.state === "ACTIVE";
  const isPending = data.myMembership?.state === "PENDING";

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }}>
        <View style={{ alignItems: "center", gap: 8 }}>
          {g.logoAssetId ? (
            <Image source={{ uri: mediaUrl(g.logoAssetId, "medium") ?? undefined }} style={{ width: 72, height: 72, borderRadius: 16 }} />
          ) : (
            <View style={{ width: 72, height: 72, borderRadius: 16, backgroundColor: theme.panel2, alignItems: "center", justifyContent: "center" }}>
              <Icon name="group" size={30} />
            </View>
          )}
          <Text style={{ color: theme.text, fontWeight: "800", fontSize: 20 }}>{g.name}</Text>
          <Text style={{ color: theme.dim, fontSize: 12 }}>{g.memberCount} members{g.isPrivate ? " · Private" : ""}</Text>
        </View>

        {data.preview ? (
          <View style={{ alignItems: "center", gap: 10 }}>
            <Text style={{ color: theme.dim, textAlign: "center" }}>{g.description}</Text>
            <Button title={isPending ? "Requested" : "Request to join"} kind="primary" onPress={join} disabled={isPending} loading={busy} testID="group-join" />
          </View>
        ) : (
          <>
            <View style={{ flexDirection: "row", gap: 10, justifyContent: "center" }}>
              {isMember ? (
                <>
                  <Button title="Group chat" icon="chat" onPress={openChat} testID="group-chat" />
                  <Button title="Leave" kind="danger" onPress={leave} loading={busy} testID="group-leave" />
                </>
              ) : (
                <Button title={isPending ? "Requested" : "Join"} kind="primary" onPress={join} disabled={isPending} loading={busy} testID="group-join" />
              )}
            </View>

            <View style={{ flexDirection: "row", gap: 8, justifyContent: "center" }}>
              {TABS.map((t) => (
                <Chip key={t} label={t} active={tab === t} onPress={() => setTab(t)} />
              ))}
            </View>

            {tab === "Feed" ? (
              <View style={{ gap: 12 }}>
                {posts.length === 0 ? <Empty icon="brief" title="No posts yet" /> : null}
                {posts.map((p) => (
                  <PostCard key={p.id} item={p} onOpenProfile={(u) => navigation.navigate("PersonProfile", { username: u })} onOpenOrg={(s) => navigation.navigate("Company", { slug: s })} onChange={() => {}} />
                ))}
              </View>
            ) : null}

            {tab === "Members" ? (
              <View style={{ gap: 10 }}>
                {members.map((m, i) => (
                  <Pressable key={m.person?.id ?? i} onPress={() => m.person?.username && navigation.navigate("PersonProfile", { username: m.person.username })} accessibilityRole="button" style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
                    <Avatar assetId={m.person?.avatarAssetId} name={m.person?.name} size={36} />
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: theme.text, fontWeight: "700" }}>{m.person?.name ?? "Member"}</Text>
                    </View>
                    <Chip label={m.role.toLowerCase()} />
                  </Pressable>
                ))}
              </View>
            ) : null}

            {tab === "Files" ? (
              <View style={{ gap: 10 }}>
                {isMember ? <Button title="Share a file" icon="doc" onPress={uploadFile} testID="group-upload-file" /> : null}
                {files.length === 0 ? <Empty icon="doc" title="No files shared yet" /> : null}
                {files.map((f) => (
                  <Pressable
                    key={f.id}
                    onPress={() => Linking.openURL(mediaUrl(f.assetId, "original") ?? "")}
                    accessibilityRole="button"
                    style={{ flexDirection: "row", gap: 10, alignItems: "center", backgroundColor: theme.panel, padding: 10, borderRadius: 10 }}
                  >
                    <Icon name="doc" />
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: theme.text, fontWeight: "700" }}>{f.title}</Text>
                      <Text style={{ color: theme.dim, fontSize: 11 }}>{f.uploader?.name ?? "Someone"}</Text>
                    </View>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
