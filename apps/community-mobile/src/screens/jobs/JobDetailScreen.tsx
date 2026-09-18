import * as DocumentPicker from "expo-document-picker";
import { useCallback, useEffect, useState } from "react";
import { Alert, SafeAreaView, ScrollView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError, uploadMedia } from "../../api/client";
import { Avatar, Button, Chip, Empty, Field, Sheet, Skeleton, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { HomeStackParamList } from "../../navigation/types";

const SECTIONS: Array<{ key: string; label: string }> = [
  { key: "headline", label: "Headline" },
  { key: "about", label: "About" },
  { key: "experience", label: "Experience" },
  { key: "education", label: "Education" },
  { key: "skills", label: "Skills" },
  { key: "certifications", label: "Certifications" },
  { key: "services", label: "Services" },
];

type JobDetail = {
  job: {
    id: string;
    title: string;
    description: string;
    location: string | null;
    employmentType: string;
    workMode: string;
    salaryMin: string | null;
    salaryMax: string | null;
    salaryPeriod: string;
    requirements: string[];
    languages: string[];
    status: string;
  };
  organization: { id: string; displayName: string; logoAssetId: string | null } | null;
  peopleYouKnowHere: { count: number; people: Array<{ id: string; name: string }> };
  viewer: { signedIn: boolean; saved: boolean; applied: boolean; applicationStage: string | null };
};

type Props = NativeStackScreenProps<HomeStackParamList, "JobDetail">;

export function JobDetailScreen({ route, navigation }: Props) {
  const { id } = route.params;
  const { theme } = useTheme();
  const toast = useToast();
  const [data, setData] = useState<JobDetail | null>(null);
  const [applyOpen, setApplyOpen] = useState(false);

  const load = useCallback(() => {
    api<JobDetail>(`/public/jobs/${id}`)
      .then(setData)
      .catch((err) => toast((err as ApiError).message, { kind: "err" }));
  }, [id]);

  useEffect(load, [load]);

  async function toggleSave() {
    if (!data) return;
    try {
      if (data.viewer.saved) await api(`/jobs/${id}/save`, { method: "DELETE" });
      else await api(`/jobs/${id}/save`, { method: "POST" });
      load();
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  function askReferral() {
    Alert.alert("Ask for a referral", "Let people you know at this company know you're interested?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Ask",
        onPress: async () => {
          try {
            await api(`/jobs/${id}/ask-referral`, { method: "POST" });
            toast("Sent.");
          } catch (err) {
            toast((err as ApiError).message, { kind: "err" });
          }
        },
      },
    ]);
  }

  if (!data) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg, padding: 16 }}>
        <Skeleton height={140} radius={16} />
      </SafeAreaView>
    );
  }

  const j = data.job;
  const salary =
    j.salaryMin || j.salaryMax
      ? `$${Number(j.salaryMin ?? j.salaryMax).toLocaleString()}${j.salaryMin && j.salaryMax ? `–$${Number(j.salaryMax).toLocaleString()}` : ""} / ${j.salaryPeriod.toLowerCase()}`
      : null;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }}>
        <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
          <Avatar assetId={data.organization?.logoAssetId} name={data.organization?.displayName} size={52} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: theme.text, fontSize: 20, fontWeight: "800" }}>{j.title}</Text>
            <Text
              style={{ color: theme.accent }}
              onPress={() => data.organization && navigation.navigate("Company", { slug: (data.organization as any).slug ?? "" })}
            >
              {data.organization?.displayName ?? "Company"}
            </Text>
          </View>
        </View>

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Chip label={j.employmentType.replace("_", " ").toLowerCase()} />
          <Chip label={j.workMode.toLowerCase()} />
          {j.location ? <Chip label={j.location} /> : null}
        </View>
        {salary ? <Text style={{ color: theme.text, fontWeight: "700" }}>{salary}</Text> : null}
        {data.peopleYouKnowHere.count ? <Text style={{ color: theme.dim, fontSize: 12 }}>{data.peopleYouKnowHere.count} people you know work here</Text> : null}

        <View style={{ flexDirection: "row", gap: 10 }}>
          {data.viewer.applied ? (
            <Button title={`Applied${data.viewer.applicationStage ? ` — ${data.viewer.applicationStage.toLowerCase()}` : ""}`} disabled />
          ) : (
            <Button title="Apply" kind="primary" onPress={() => setApplyOpen(true)} testID="job-apply" />
          )}
          <Button title={data.viewer.saved ? "Saved" : "Save"} icon="save" onPress={toggleSave} testID="job-save" />
        </View>
        {data.peopleYouKnowHere.count ? <Button title="Ask for a referral" onPress={askReferral} testID="job-referral" /> : null}

        <Text style={{ color: theme.text, lineHeight: 21 }}>{j.description}</Text>

        {j.requirements.length ? (
          <View style={{ gap: 6 }}>
            <Text style={{ color: theme.text, fontWeight: "800" }}>Requirements</Text>
            {j.requirements.map((r, i) => (
              <Text key={i} style={{ color: theme.text }}>
                {"•"} {r}
              </Text>
            ))}
          </View>
        ) : null}
      </ScrollView>

      <ApplySheet
        visible={applyOpen}
        onClose={() => setApplyOpen(false)}
        jobId={id}
        onApplied={() => {
          setApplyOpen(false);
          load();
        }}
      />
    </SafeAreaView>
  );
}

function ApplySheet({ visible, onClose, jobId, onApplied }: { visible: boolean; onClose: () => void; jobId: string; onApplied: () => void }) {
  const { theme } = useTheme();
  const toast = useToast();
  const [sections, setSections] = useState<string[]>(SECTIONS.map((s) => s.key));
  const [coverNote, setCoverNote] = useState("");
  const [resume, setResume] = useState<{ uri: string; name: string; mimeType: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function pickResume() {
    const result = await DocumentPicker.getDocumentAsync({ multiple: false, type: ["application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"] });
    if (result.canceled) return;
    const file = result.assets[0];
    setResume({ uri: file.uri, name: file.name, mimeType: file.mimeType ?? "application/pdf" });
  }

  async function submit() {
    if (!sections.length) {
      toast("Choose at least one profile section to share.", { kind: "err" });
      return;
    }
    setSubmitting(true);
    try {
      let resumeAssetId: string | undefined;
      if (resume) {
        const uploaded = await uploadMedia(resume.uri, resume.name, resume.mimeType, { private: "1", kind: "document" });
        resumeAssetId = uploaded.asset.id;
      }
      await api(`/jobs/${jobId}/apply`, { method: "POST", body: { sections, resumeAssetId, coverNote: coverNote || undefined } });
      toast("Application sent.");
      onApplied();
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet visible={visible} onClose={onClose} title="Apply">
      <ScrollView contentContainerStyle={{ gap: 12 }}>
        <Text style={{ color: theme.dim, fontSize: 13 }}>Choose what from your profile to share with this employer.</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {SECTIONS.map((s) => (
            <Chip
              key={s.key}
              label={s.label}
              active={sections.includes(s.key)}
              onPress={() => setSections((prev) => (prev.includes(s.key) ? prev.filter((x) => x !== s.key) : [...prev, s.key]))}
            />
          ))}
        </View>
        <Button title={resume ? `Résumé: ${resume.name}` : "Attach résumé (optional)"} onPress={pickResume} testID="apply-resume" />
        <Field label="Cover note (optional)" value={coverNote} onChangeText={setCoverNote} multiline testID="apply-cover-note" />
        <Button title="Submit application" kind="primary" wide onPress={submit} loading={submitting} testID="apply-submit" />
      </ScrollView>
    </Sheet>
  );
}
