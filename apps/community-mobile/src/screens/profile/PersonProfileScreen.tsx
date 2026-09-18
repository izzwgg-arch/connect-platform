import { useCallback, useEffect, useState } from "react";
import { Linking, Pressable, SafeAreaView, ScrollView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError, newIdempotencyKey } from "../../api/client";
import { useAuth } from "../../auth/AuthProvider";
import { Avatar, Button, Chip, Skeleton, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { HomeStackParamList } from "../../navigation/types";

type PublicProfile = {
  person: { id: string; username: string; name: string };
  profile: Record<string, any>;
  verifications: string[];
  primaryOrg: { id: string; slug: string; displayName: string } | null;
  relationship: {
    degree: number;
    mutualCount: number;
    connectionStatus: string;
    following: boolean;
    canMessage: boolean;
    canCall: boolean;
  };
};

type Props = NativeStackScreenProps<HomeStackParamList, "PersonProfile">;

export function PersonProfileScreen({ route, navigation }: Props) {
  const { username } = route.params;
  const { theme } = useTheme();
  const toast = useToast();
  const { me } = useAuth();
  const [data, setData] = useState<PublicProfile | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<PublicProfile>(`/public/people/${username}`)
      .then(setData)
      .catch((err) => toast((err as ApiError).message, { kind: "err" }));
  }, [username]);

  useEffect(load, [load]);

  const isMe = me?.person.username === username;

  async function connect() {
    if (!data) return;
    setBusy(true);
    try {
      await api("/connections/request", { method: "POST", body: { personId: data.person.id }, idempotencyKey: newIdempotencyKey() });
      toast("Request sent.");
      load();
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  async function toggleFollow() {
    if (!data) return;
    setBusy(true);
    try {
      if (data.relationship.following) await api(`/people/${data.person.id}/follow`, { method: "DELETE" });
      else await api(`/people/${data.person.id}/follow`, { method: "POST" });
      load();
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  async function message() {
    if (!data) return;
    try {
      const thread = await api<{ id: string }>("/threads", { method: "POST", body: { personIds: [data.person.id] } });
      (navigation.getParent() as any)?.navigate("MessagesTab", { screen: "Conversation", params: { threadId: thread.id, title: data.person.name } });
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

  const p = data.profile;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }}>
        <View style={{ alignItems: "center", gap: 8 }}>
          <Avatar assetId={p.avatarAssetId} name={data.person.name} size={84} />
          <Text style={{ color: theme.text, fontWeight: "800", fontSize: 20 }}>{data.person.name}</Text>
          {p.headline ? <Text style={{ color: theme.dim }}>{p.headline}</Text> : null}
          {p.location ? <Text style={{ color: theme.dim, fontSize: 12 }}>{p.location}</Text> : null}
          {data.primaryOrg ? (
            <Pressable onPress={() => navigation.navigate("Company", { slug: data.primaryOrg!.slug })} accessibilityRole="button">
              <Text style={{ color: theme.accent }}>{data.primaryOrg.displayName}</Text>
            </Pressable>
          ) : null}
          {data.relationship.mutualCount ? <Text style={{ color: theme.dim, fontSize: 12 }}>{data.relationship.mutualCount} mutual connections</Text> : null}
        </View>

        {!isMe ? (
          <View style={{ flexDirection: "row", gap: 10, justifyContent: "center" }}>
            {data.relationship.connectionStatus === "none" ? (
              <Button title="Connect" kind="primary" onPress={connect} loading={busy} testID="profile-connect" />
            ) : data.relationship.connectionStatus === "pending" ? (
              <Button title="Pending" disabled />
            ) : (
              <Button title="Connected" disabled />
            )}
            <Button title={data.relationship.following ? "Following" : "Follow"} onPress={toggleFollow} loading={busy} testID="profile-follow" />
            {data.relationship.canMessage ? <Button title="Message" icon="msg" onPress={message} testID="profile-message" /> : null}
            {data.relationship.canCall ? (
              <Button title="Call" icon="phone" onPress={() => Linking.openURL(`tel:${p.phone ?? ""}`)} disabled={!p.phone} />
            ) : null}
          </View>
        ) : null}

        {data.verifications.length ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, justifyContent: "center" }}>
            {data.verifications.map((v) => (
              <Chip key={v} label={v} icon="shield" />
            ))}
          </View>
        ) : null}

        {p.about ? (
          <Section title="About">
            <Text style={{ color: theme.text }}>{p.about}</Text>
          </Section>
        ) : null}

        {p.skills?.length ? (
          <Section title="Skills">
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {p.skills.map((s: any) => (
                <Chip key={s.skill} label={`${s.skill} (${s.count})`} />
              ))}
            </View>
          </Section>
        ) : null}

        {p.experiences?.length ? (
          <Section title="Experience">
            {p.experiences.map((e: any) => (
              <View key={e.id} style={{ marginBottom: 8 }}>
                <Text style={{ color: theme.text, fontWeight: "700" }}>{e.title}</Text>
                <Text style={{ color: theme.dim, fontSize: 12 }}>{e.company}</Text>
              </View>
            ))}
          </Section>
        ) : null}

        {p.services?.length ? (
          <Section title="Services">
            {p.services.map((s: any) => (
              <Text key={s.id} style={{ color: theme.text }}>
                {"•"} {s.title}
              </Text>
            ))}
          </Section>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const { theme } = useTheme();
  return (
    <View style={{ backgroundColor: theme.panel, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: theme.border, gap: 6 }}>
      <Text style={{ color: theme.text, fontWeight: "800" }}>{title}</Text>
      {children}
    </View>
  );
}
