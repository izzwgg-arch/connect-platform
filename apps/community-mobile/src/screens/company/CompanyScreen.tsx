import { useCallback, useEffect, useState } from "react";
import { Linking, Pressable, SafeAreaView, ScrollView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError } from "../../api/client";
import type { FeedItem } from "../../api/types";
import { Avatar, Button, Chip, Skeleton, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { HomeStackParamList } from "../../navigation/types";
import { PostCard } from "../home/PostCard";

type CompanyPayload = {
  id: string;
  slug: string;
  displayName: string;
  logoAssetId: string | null;
  description: string | null;
  industry: string | null;
  followerCount: number;
  acceptsRfqs: boolean;
  verifications: Array<{ kind: string }>;
  people: Array<{ id: string; username: string; name: string; avatarAssetId: string | null; role: string; title: string | null }>;
  openJobs: Array<{ id: string; title: string; location: string | null; employmentType: string }>;
  openJobsCount: number;
  viewer: { isMember: boolean; following: boolean };
};

const TABS = ["About", "Posts", "Jobs", "People"] as const;

type Props = NativeStackScreenProps<HomeStackParamList, "Company">;

export function CompanyScreen({ route, navigation }: Props) {
  const { slug } = route.params;
  const { theme } = useTheme();
  const toast = useToast();
  const [data, setData] = useState<CompanyPayload | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]>("About");
  const [posts, setPosts] = useState<FeedItem["post"][]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<CompanyPayload>(`/public/companies/${slug}`)
      .then(setData)
      .catch((err) => toast((err as ApiError).message, { kind: "err" }));
  }, [slug]);

  useEffect(load, [load]);

  useEffect(() => {
    if (tab !== "Posts" || !data) return;
    api<{ items: FeedItem["post"][] }>(`/organizations/${data.id}/posts`)
      .then((r) => setPosts(r.items))
      .catch(() => setPosts([]));
  }, [tab, data?.id]);

  async function toggleFollow() {
    if (!data) return;
    setBusy(true);
    try {
      if (data.viewer.following) await api(`/organizations/${data.id}/follow`, { method: "DELETE" });
      else await api(`/organizations/${data.id}/follow`, { method: "POST" });
      load();
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  async function message() {
    if (!data?.people?.length) {
      toast("No one at this company can be messaged yet.", { kind: "err" });
      return;
    }
    try {
      const thread = await api<{ id: string }>("/threads", { method: "POST", body: { personIds: [data.people[0].id] } });
      (navigation.getParent() as any)?.navigate("MessagesTab", { screen: "Conversation", params: { threadId: thread.id, title: data.displayName } });
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  function requestQuote() {
    if (!data) return;
    navigation.navigate("RfqNew", { toOrganizationId: data.id, toOrganizationName: data.displayName });
  }

  if (!data) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg, padding: 16 }}>
        <Skeleton height={120} radius={16} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }}>
        <View style={{ alignItems: "center", gap: 8 }}>
          <Avatar assetId={data.logoAssetId} name={data.displayName} size={84} />
          <Text style={{ color: theme.text, fontWeight: "800", fontSize: 20 }}>{data.displayName}</Text>
          {data.industry ? <Text style={{ color: theme.dim }}>{data.industry}</Text> : null}
          <Text style={{ color: theme.dim, fontSize: 12 }}>{data.followerCount} followers</Text>
        </View>

        <View style={{ flexDirection: "row", gap: 10, justifyContent: "center" }}>
          <Button title={data.viewer.following ? "Following" : "Follow"} kind={data.viewer.following ? "secondary" : "primary"} onPress={toggleFollow} loading={busy} testID="company-follow" />
          <Button title="Message" icon="msg" onPress={message} testID="company-message" />
          {data.acceptsRfqs ? <Button title="Request quote" icon="quote" onPress={requestQuote} testID="company-rfq" /> : null}
        </View>

        <View style={{ flexDirection: "row", gap: 8, justifyContent: "center" }}>
          {TABS.map((t) => (
            <Chip key={t} label={t} active={tab === t} onPress={() => setTab(t)} />
          ))}
        </View>

        {tab === "About" ? (
          <View style={{ gap: 10 }}>
            {data.description ? <Text style={{ color: theme.text }}>{data.description}</Text> : null}
          </View>
        ) : null}

        {tab === "Posts" ? (
          <View style={{ gap: 12 }}>
            {posts.map((p) => (
              <PostCard key={p.id} item={p} onOpenProfile={(u) => navigation.navigate("PersonProfile", { username: u })} onOpenOrg={() => {}} onChange={() => {}} />
            ))}
          </View>
        ) : null}

        {tab === "Jobs" ? (
          <View style={{ gap: 10 }}>
            {data.openJobs.length === 0 ? <Text style={{ color: theme.dim }}>No open roles right now.</Text> : null}
            {data.openJobs.map((j) => (
              <Pressable key={j.id} onPress={() => navigation.navigate("JobDetail", { id: j.id })} accessibilityRole="button" style={{ backgroundColor: theme.panel, padding: 12, borderRadius: 12 }}>
                <Text style={{ color: theme.text, fontWeight: "700" }}>{j.title}</Text>
                <Text style={{ color: theme.dim, fontSize: 12 }}>
                  {j.location ?? ""} {j.employmentType}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {tab === "People" ? (
          <View style={{ gap: 10 }}>
            {data.people.map((p) => (
              <Pressable key={p.id} onPress={() => navigation.navigate("PersonProfile", { username: p.username })} accessibilityRole="button" style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
                <Avatar assetId={p.avatarAssetId} name={p.name} />
                <View>
                  <Text style={{ color: theme.text, fontWeight: "700" }}>{p.name}</Text>
                  <Text style={{ color: theme.dim, fontSize: 12 }}>{p.title ?? p.role}</Text>
                </View>
              </Pressable>
            ))}
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}
