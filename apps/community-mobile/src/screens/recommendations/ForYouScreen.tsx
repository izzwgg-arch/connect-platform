import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, SafeAreaView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError } from "../../api/client";
import { Avatar, Empty, Icon, Skeleton, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { HomeStackParamList } from "../../navigation/types";

type OrgRec = { id: string; slug: string; displayName: string; logoAssetId: string | null; reason: string; recommendationId: string };
type CustomerRec = { type: "person" | "organization"; person?: any; organization?: any; reason: string; recommendationId: string };
type JobRec = { job: { id: string; title: string }; organization: { displayName: string } | null; reason: string; recommendationId: string };
type GroupRec = { id: string; slug: string; name: string; reason: string; recommendationId: string };
type EventRec = { id: string; slug: string; title: string; reason: string; recommendationId: string };

type Rail = { title: string; icon: any; kind: "organizations" | "customers" | "jobs" | "groups" | "events"; items: any[] };

type Props = NativeStackScreenProps<HomeStackParamList, "ForYou">;

export function ForYouScreen({ navigation }: Props) {
  const { theme } = useTheme();
  const toast = useToast();
  const [rails, setRails] = useState<Rail[]>([]);
  const [loading, setLoading] = useState(true);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [orgs, customers, jobs, groups, events] = await Promise.all([
        api<{ organizations: OrgRec[] }>("/recommendations/organizations").catch(() => ({ organizations: [] })),
        api<{ customers: CustomerRec[] }>("/recommendations/customers").catch(() => ({ customers: [] })),
        api<{ jobs: JobRec[] }>("/recommendations/jobs").catch(() => ({ jobs: [] })),
        api<{ groups: GroupRec[] }>("/recommendations/groups").catch(() => ({ groups: [] })),
        api<{ events: EventRec[] }>("/recommendations/events").catch(() => ({ events: [] })),
      ]);
      setRails(
        [
          { title: "Businesses you may need", icon: "bldg", kind: "organizations" as const, items: orgs.organizations },
          { title: "Customers you may want", icon: "people", kind: "customers" as const, items: customers.customers },
          { title: "Jobs you may like", icon: "brief", kind: "jobs" as const, items: jobs.jobs },
          { title: "Groups for you", icon: "group", kind: "groups" as const, items: groups.groups },
          { title: "Events near you", icon: "cal", kind: "events" as const, items: events.events },
        ].filter((r) => r.items.length),
      );
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function dismiss(recommendationId: string) {
    setDismissed((prev) => new Set(prev).add(recommendationId));
    try {
      await api(`/recommendations/${recommendationId}/dismiss`, { method: "POST" });
    } catch {
      /* it stays dismissed locally regardless */
    }
  }

  function openItem(kind: Rail["kind"], item: any) {
    if (kind === "organizations") navigation.navigate("Company", { slug: item.slug });
    else if (kind === "customers") {
      if (item.type === "person" && item.person) navigation.navigate("PersonProfile", { username: item.person.username });
      else if (item.organization) navigation.navigate("Company", { slug: item.organization.slug });
    } else if (kind === "jobs") navigation.navigate("JobDetail", { id: item.job.id });
    else if (kind === "groups") navigation.navigate("GroupDetail", { slug: item.slug });
    else if (kind === "events") navigation.navigate("EventDetail", { id: item.id, slug: item.slug });
  }

  function itemName(kind: Rail["kind"], item: any): string {
    if (kind === "organizations") return item.displayName;
    if (kind === "customers") return item.type === "person" ? item.person?.name : item.organization?.displayName;
    if (kind === "jobs") return item.job.title;
    if (kind === "groups") return item.name;
    if (kind === "events") return item.title;
    return "";
  }

  function itemAvatarId(kind: Rail["kind"], item: any): string | null {
    if (kind === "organizations") return item.logoAssetId;
    if (kind === "customers") return item.type === "person" ? item.person?.avatarAssetId : item.organization?.logoAssetId;
    return null;
  }

  if (loading) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg, padding: 16, gap: 10 }}>
        <Skeleton height={100} radius={14} />
        <Skeleton height={100} radius={14} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <FlatList
        data={rails}
        keyExtractor={(r) => r.title}
        contentContainerStyle={{ padding: 16, gap: 20 }}
        ListEmptyComponent={<Empty icon="star" title="Nothing to recommend yet" hint="As you use Loopcom Community more, we'll surface people, businesses and opportunities for you here." />}
        renderItem={({ item: rail }) => (
          <View style={{ gap: 10 }}>
            <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
              <Icon name={rail.icon} size={18} />
              <Text style={{ color: theme.text, fontWeight: "800", fontSize: 16 }}>{rail.title}</Text>
            </View>
            <FlatList
              horizontal
              showsHorizontalScrollIndicator={false}
              data={rail.items.filter((it) => !dismissed.has(it.recommendationId))}
              keyExtractor={(it) => it.recommendationId}
              contentContainerStyle={{ gap: 10 }}
              renderItem={({ item }) => (
                <View style={{ width: 160, backgroundColor: theme.panel, borderRadius: 14, borderWidth: 1, borderColor: theme.border, padding: 10, gap: 6 }}>
                  <Pressable onPress={() => openItem(rail.kind, item)} accessibilityRole="button" style={{ alignItems: "center", gap: 6 }}>
                    <Avatar assetId={itemAvatarId(rail.kind, item)} name={itemName(rail.kind, item)} size={44} />
                    <Text numberOfLines={2} style={{ color: theme.text, fontWeight: "700", fontSize: 12, textAlign: "center" }}>
                      {itemName(rail.kind, item)}
                    </Text>
                  </Pressable>
                  <Text numberOfLines={2} style={{ color: theme.dim, fontSize: 10, textAlign: "center" }}>
                    {item.reason}
                  </Text>
                  <Pressable accessibilityRole="button" accessibilityLabel="Not interested" onPress={() => dismiss(item.recommendationId)} style={{ alignItems: "center" }}>
                    <Text style={{ color: theme.dim, fontSize: 10 }}>Dismiss</Text>
                  </Pressable>
                </View>
              )}
            />
          </View>
        )}
      />
    </SafeAreaView>
  );
}
