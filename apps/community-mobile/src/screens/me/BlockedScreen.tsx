import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, SafeAreaView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError } from "../../api/client";
import { Avatar, Button, Chip, Empty, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { MeStackParamList } from "../../navigation/types";

type PersonCard = { id: string; name: string; username: string; avatarAssetId: string | null };
type PersonRow = { person: PersonCard | null; createdAt: string };
type OrgRow = { id: string; displayName: string; logoAssetId: string | null };

type Props = NativeStackScreenProps<MeStackParamList, "Blocked">;

export function BlockedScreen({ navigation }: Props) {
  const { theme } = useTheme();
  const toast = useToast();
  const [tab, setTab] = useState<"blocked" | "muted">("blocked");
  const [blocked, setBlocked] = useState<PersonRow[]>([]);
  const [mutedPeople, setMutedPeople] = useState<PersonCard[]>([]);
  const [mutedOrgs, setMutedOrgs] = useState<OrgRow[]>([]);

  const load = useCallback(() => {
    api<{ items: PersonRow[] }>("/me/blocked")
      .then((r) => setBlocked(r.items))
      .catch((err) => toast((err as ApiError).message, { kind: "err" }));
    api<{ people: PersonCard[]; organizations: OrgRow[] }>("/me/muted")
      .then((r) => {
        setMutedPeople(r.people ?? []);
        setMutedOrgs(r.organizations ?? []);
      })
      .catch(() => {});
  }, []);

  useEffect(load, [load]);

  async function unblock(personId: string) {
    try {
      await api(`/people/${personId}/block`, { method: "DELETE" });
      setBlocked((prev) => prev.filter((r) => r.person?.id !== personId));
      toast("Unblocked.");
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  async function unmutePerson(personId: string) {
    try {
      await api(`/people/${personId}/mute`, { method: "DELETE" });
      setMutedPeople((prev) => prev.filter((p) => p.id !== personId));
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  async function unmuteOrg(orgId: string) {
    try {
      await api(`/organizations/${orgId}/mute`, { method: "DELETE" });
      setMutedOrgs((prev) => prev.filter((o) => o.id !== orgId));
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={{ padding: 12, gap: 10 }}>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Chip label="Blocked" active={tab === "blocked"} onPress={() => setTab("blocked")} />
          <Chip label="Muted" active={tab === "muted"} onPress={() => setTab("muted")} />
        </View>
      </View>
      {tab === "blocked" ? (
        <FlatList
          data={blocked}
          keyExtractor={(r, i) => r.person?.id ?? String(i)}
          contentContainerStyle={{ padding: 12, gap: 10 }}
          ListEmptyComponent={<Empty icon="shield" title="Nobody is blocked" />}
          renderItem={({ item }) => (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: theme.panel, borderRadius: 14, borderWidth: 1, borderColor: theme.border, padding: 12 }}>
              <Avatar assetId={item.person?.avatarAssetId} name={item.person?.name} />
              <Text style={{ color: theme.text, flex: 1, fontWeight: "700" }}>{item.person?.name ?? "Someone"}</Text>
              <Button title="Unblock" onPress={() => item.person && unblock(item.person.id)} />
            </View>
          )}
        />
      ) : (
        <FlatList
          data={[...mutedPeople.map((r) => ({ kind: "person" as const, row: r })), ...mutedOrgs.map((o) => ({ kind: "org" as const, row: o }))]}
          keyExtractor={(r) => `${r.kind}-${r.row.id}`}
          contentContainerStyle={{ padding: 12, gap: 10 }}
          ListEmptyComponent={<Empty icon="bell" title="Nobody is muted" />}
          renderItem={({ item }) =>
            item.kind === "person" ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: theme.panel, borderRadius: 14, borderWidth: 1, borderColor: theme.border, padding: 12 }}>
                <Avatar assetId={item.row.avatarAssetId} name={item.row.name} />
                <Text style={{ color: theme.text, flex: 1, fontWeight: "700" }}>{item.row.name}</Text>
                <Button title="Unmute" onPress={() => unmutePerson(item.row.id)} />
              </View>
            ) : (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: theme.panel, borderRadius: 14, borderWidth: 1, borderColor: theme.border, padding: 12 }}>
                <Avatar assetId={item.row.logoAssetId} name={item.row.displayName} />
                <Text style={{ color: theme.text, flex: 1, fontWeight: "700" }}>{item.row.displayName}</Text>
                <Button title="Unmute" onPress={() => unmuteOrg(item.row.id)} />
              </View>
            )
          }
        />
      )}
    </SafeAreaView>
  );
}
