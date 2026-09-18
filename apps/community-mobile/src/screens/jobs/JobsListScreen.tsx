import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, SafeAreaView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError } from "../../api/client";
import { Avatar, Button, Chip, Empty, Field, Icon, Skeleton, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { HomeStackParamList } from "../../navigation/types";

type JobRow = {
  job: {
    id: string;
    title: string;
    location: string | null;
    employmentType: string;
    workMode: string;
    salaryMin: string | null;
    salaryMax: string | null;
    salaryPeriod: string;
    createdAt: string;
  };
  organization: { id: string; displayName: string; logoAssetId: string | null; verified: string[] } | null;
  saved: boolean;
  applied: boolean;
  earlyApplicant: boolean;
  peopleYouKnowHere: { count: number };
};

const WORK_MODES = [
  { key: undefined, label: "Any" },
  { key: "ONSITE", label: "On-site" },
  { key: "REMOTE", label: "Remote" },
  { key: "HYBRID", label: "Hybrid" },
] as const;

type Props = NativeStackScreenProps<HomeStackParamList, "JobsList">;

export function JobsListScreen({ navigation }: Props) {
  const { theme } = useTheme();
  const toast = useToast();
  const [q, setQ] = useState("");
  const [workMode, setWorkMode] = useState<string | undefined>(undefined);
  const [items, setItems] = useState<JobRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [savedOnly, setSavedOnly] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (savedOnly) {
        const res = await api<{ items: JobRow[] }>("/me/saved-jobs");
        setItems(res.items);
        return;
      }
      const qs = new URLSearchParams();
      if (q.trim()) qs.set("q", q.trim());
      if (workMode) qs.set("workMode", workMode);
      const res = await api<{ items: JobRow[] }>(`/jobs?${qs.toString()}`);
      setItems(res.items);
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setLoading(false);
    }
  }, [q, workMode, savedOnly]);

  useEffect(() => {
    load();
  }, [load]);

  async function toggleSave(row: JobRow) {
    try {
      if (row.saved) await api(`/jobs/${row.job.id}/save`, { method: "DELETE" });
      else await api(`/jobs/${row.job.id}/save`, { method: "POST" });
      setItems((prev) => prev.map((r) => (r.job.id === row.job.id ? { ...r, saved: !r.saved } : r)));
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  function salaryLine(j: JobRow["job"]): string | null {
    if (!j.salaryMin && !j.salaryMax) return null;
    const period = j.salaryPeriod === "YEAR" ? "/yr" : j.salaryPeriod === "HOUR" ? "/hr" : "";
    if (j.salaryMin && j.salaryMax) return `$${Number(j.salaryMin).toLocaleString()}–$${Number(j.salaryMax).toLocaleString()}${period}`;
    return `$${Number(j.salaryMin ?? j.salaryMax).toLocaleString()}${period}`;
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={{ padding: 12, gap: 10 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text style={{ color: theme.text, fontSize: 20, fontWeight: "800" }}>Jobs</Text>
          <Pressable accessibilityRole="button" onPress={() => navigation.navigate("MyApplications")} testID="jobs-my-applications">
            <Text style={{ color: theme.accent, fontWeight: "700" }}>My applications</Text>
          </Pressable>
        </View>
        <Field placeholder="Search jobs" value={q} onChangeText={setQ} onSubmitEditing={load} testID="jobs-search" />
        <FlatList
          horizontal
          showsHorizontalScrollIndicator={false}
          data={[{ key: "saved", label: "Saved" }, ...WORK_MODES]}
          keyExtractor={(f) => f.label}
          contentContainerStyle={{ gap: 8 }}
          renderItem={({ item }) =>
            "key" in item && item.key === "saved" ? (
              <Chip label="Saved" active={savedOnly} onPress={() => setSavedOnly((v) => !v)} testID="jobs-filter-saved" />
            ) : (
              <Chip label={item.label} active={!savedOnly && workMode === item.key} onPress={() => { setSavedOnly(false); setWorkMode(item.key); }} />
            )
          }
        />
      </View>
      {loading ? (
        <View style={{ padding: 12, gap: 10 }}>
          <Skeleton height={90} radius={14} />
          <Skeleton height={90} radius={14} />
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(r) => r.job.id}
          contentContainerStyle={{ padding: 12, gap: 10 }}
          ListEmptyComponent={<Empty icon="brief" title="No jobs match" hint="Try a different search or filter." />}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => navigation.navigate("JobDetail", { id: item.job.id })}
              accessibilityRole="button"
              style={{ backgroundColor: theme.panel, borderRadius: 14, borderWidth: 1, borderColor: theme.border, padding: 12, gap: 6 }}
            >
              <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
                <Avatar assetId={item.organization?.logoAssetId} name={item.organization?.displayName} size={40} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: theme.text, fontWeight: "800" }}>{item.job.title}</Text>
                  <Text style={{ color: theme.dim, fontSize: 12 }}>{item.organization?.displayName ?? "Company"}</Text>
                </View>
                <Pressable accessibilityRole="button" accessibilityLabel={item.saved ? "Unsave job" : "Save job"} onPress={() => toggleSave(item)} hitSlop={8}>
                  <Icon name="save" size={18} color={item.saved ? theme.accent : theme.dim} />
                </Pressable>
              </View>
              <Text style={{ color: theme.dim, fontSize: 12 }}>
                {item.job.location ?? "Location not listed"} · {item.job.employmentType.replace("_", " ").toLowerCase()} · {item.job.workMode.toLowerCase()}
              </Text>
              {salaryLine(item.job) ? <Text style={{ color: theme.text, fontSize: 12, fontWeight: "700" }}>{salaryLine(item.job)}</Text> : null}
              <View style={{ flexDirection: "row", gap: 8 }}>
                {item.earlyApplicant ? <Chip label="Early applicant" /> : null}
                {item.applied ? <Chip label="Applied" /> : null}
                {item.peopleYouKnowHere.count ? <Chip label={`${item.peopleYouKnowHere.count} you know here`} /> : null}
              </View>
            </Pressable>
          )}
        />
      )}
    </SafeAreaView>
  );
}
