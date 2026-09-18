import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, SafeAreaView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError } from "../../api/client";
import { Avatar, Chip, Empty, Skeleton, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { HomeStackParamList } from "../../navigation/types";

const STAGES = ["APPLIED", "REVIEWED", "INTERVIEW", "OFFER", "HIRED"] as const;

type ApplicationRow = {
  id: string;
  jobId: string;
  stage: string;
  createdAt: string;
  job: { id: string; title: string };
  organization: { id: string; displayName: string; logoAssetId: string | null } | null;
};

type Props = NativeStackScreenProps<HomeStackParamList, "MyApplications">;

export function MyApplicationsScreen({ navigation }: Props) {
  const { theme } = useTheme();
  const toast = useToast();
  const [items, setItems] = useState<ApplicationRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    api<{ items: ApplicationRow[] }>("/me/applications")
      .then((r) => setItems(r.items))
      .catch((err) => toast((err as ApiError).message, { kind: "err" }))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  if (loading) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg, padding: 16, gap: 10 }}>
        <Skeleton height={80} radius={14} />
        <Skeleton height={80} radius={14} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <FlatList
        data={items}
        keyExtractor={(r) => r.id}
        contentContainerStyle={{ padding: 16, gap: 12 }}
        ListEmptyComponent={<Empty icon="brief" title="No applications yet" hint="Applications you send will show up here with their status." />}
        renderItem={({ item }) => {
          const closed = item.stage === "CLOSED";
          const stageIndex = STAGES.indexOf(item.stage as any);
          return (
            <Pressable onPress={() => navigation.navigate("JobDetail", { id: item.jobId })} accessibilityRole="button" style={{ backgroundColor: theme.panel, borderRadius: 14, borderWidth: 1, borderColor: theme.border, padding: 12, gap: 8 }}>
              <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
                <Avatar assetId={item.organization?.logoAssetId} name={item.organization?.displayName} size={36} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: theme.text, fontWeight: "700" }}>{item.job.title}</Text>
                  <Text style={{ color: theme.dim, fontSize: 12 }}>{item.organization?.displayName ?? "Company"}</Text>
                </View>
                {closed ? <Chip label="Closed" /> : null}
              </View>
              {!closed ? (
                <View style={{ flexDirection: "row", alignItems: "center" }}>
                  {STAGES.map((s, i) => (
                    <View key={s} style={{ flex: 1, alignItems: "center" }}>
                      <View
                        style={{
                          width: 10,
                          height: 10,
                          borderRadius: 5,
                          backgroundColor: i <= stageIndex ? theme.accent : theme.border,
                          marginBottom: 4,
                        }}
                      />
                      <Text style={{ color: i <= stageIndex ? theme.text : theme.dim, fontSize: 9, textAlign: "center" }}>{s.charAt(0) + s.slice(1).toLowerCase()}</Text>
                      {i < STAGES.length - 1 ? <View style={{ position: "absolute", top: 4, left: "50%", right: "-50%", height: 2, backgroundColor: i < stageIndex ? theme.accent : theme.border }} /> : null}
                    </View>
                  ))}
                </View>
              ) : null}
            </Pressable>
          );
        }}
      />
    </SafeAreaView>
  );
}
