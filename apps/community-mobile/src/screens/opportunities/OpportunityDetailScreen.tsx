import { useCallback, useEffect, useState } from "react";
import { SafeAreaView, ScrollView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError } from "../../api/client";
import type { OpportunityField } from "../../domain/dynamicFields";
import { Avatar, Button, Chip, Field, Sheet, Skeleton, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { HomeStackParamList } from "../../navigation/types";

type OppDetail = {
  opportunity: { id: string; title: string; description: string; fields: Record<string, unknown>; location: string | null; interestCount: number; expiresAt: string | null; createdAt: string };
  type: { id: string; slug: string; name: string; fieldSchema: OpportunityField[] } | null;
  poster: { id: string; name: string; username: string; avatarAssetId: string | null } | null;
  organization: { id: string; displayName: string; logoAssetId: string | null; slug?: string } | null;
  myInterest: boolean;
};

function fieldDisplay(field: OpportunityField, value: unknown): string {
  if (value == null || value === "") return "—";
  if (field.type === "money") return `$${Number(value).toLocaleString()}`;
  if (field.type === "date") return new Date(String(value)).toLocaleDateString();
  if (field.type === "multiselect" && Array.isArray(value)) return value.join(", ");
  if (field.type === "boolean") return value ? "Yes" : "No";
  return String(value);
}

type Props = NativeStackScreenProps<HomeStackParamList, "OpportunityDetail">;

export function OpportunityDetailScreen({ route, navigation }: Props) {
  const { id } = route.params;
  const { theme } = useTheme();
  const toast = useToast();
  const [data, setData] = useState<OppDetail | null>(null);
  const [askOpen, setAskOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<OppDetail>(`/public/opportunities/${id}`)
      .then(setData)
      .catch((err) => toast((err as ApiError).message, { kind: "err" }));
  }, [id]);

  useEffect(load, [load]);

  async function toggleInterest() {
    if (!data) return;
    setBusy(true);
    try {
      if (data.myInterest) {
        await api(`/opportunities/${id}/interest`, { method: "DELETE" });
        load();
      } else {
        const res = await api<{ threadId: string }>(`/opportunities/${id}/interest`, { method: "POST" });
        toast("They've been notified.");
        load();
        (navigation.getParent() as any)?.navigate("MessagesTab", { screen: "Conversation", params: { threadId: res.threadId, title: data.opportunity.title } });
      }
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg, padding: 16 }}>
        <Skeleton height={140} radius={16} />
      </SafeAreaView>
    );
  }

  const o = data.opportunity;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }}>
        <View style={{ flexDirection: "row", gap: 10, alignItems: "center" }}>
          <Avatar assetId={data.organization?.logoAssetId ?? data.poster?.avatarAssetId} name={data.organization?.displayName ?? data.poster?.name} size={44} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: theme.text, fontSize: 18, fontWeight: "800" }}>{o.title}</Text>
            <Text style={{ color: theme.dim, fontSize: 12 }}>{data.organization?.displayName ?? data.poster?.name ?? "Someone"}</Text>
          </View>
          {data.type ? <Chip label={data.type.name} /> : null}
        </View>

        <Text style={{ color: theme.text, lineHeight: 20 }}>{o.description}</Text>

        {data.type?.fieldSchema?.length ? (
          <View style={{ backgroundColor: theme.panel, borderRadius: 14, borderWidth: 1, borderColor: theme.border, padding: 12, gap: 6 }}>
            {data.type.fieldSchema.map((f) => (
              <View key={f.key} style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <Text style={{ color: theme.dim, fontSize: 13 }}>{f.label}</Text>
                <Text style={{ color: theme.text, fontSize: 13, fontWeight: "700" }}>{fieldDisplay(f, o.fields[f.key])}</Text>
              </View>
            ))}
          </View>
        ) : null}

        <Text style={{ color: theme.dim, fontSize: 12 }}>
          {o.location ?? "Anywhere"} · {o.interestCount} interested{o.expiresAt ? ` · expires ${new Date(o.expiresAt).toLocaleDateString()}` : ""}
        </Text>

        <View style={{ flexDirection: "row", gap: 10 }}>
          <Button title={data.myInterest ? "Interested ✓" : "I'm interested"} kind={data.myInterest ? "secondary" : "primary"} onPress={toggleInterest} loading={busy} testID="opportunity-interest" />
          <Button title="Ask a question" onPress={() => setAskOpen(true)} testID="opportunity-ask" />
        </View>
      </ScrollView>

      <AskQuestionSheet
        visible={askOpen}
        onClose={() => setAskOpen(false)}
        opportunityId={id}
        onSent={() => setAskOpen(false)}
      />
    </SafeAreaView>
  );
}

function AskQuestionSheet({ visible, onClose, opportunityId, onSent }: { visible: boolean; onClose: () => void; opportunityId: string; onSent: () => void }) {
  const toast = useToast();
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (question.trim().length < 1) return;
    setBusy(true);
    try {
      await api(`/opportunities/${opportunityId}/question`, { method: "POST", body: { question: question.trim() } });
      setQuestion("");
      toast("Sent.");
      onSent();
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet visible={visible} onClose={onClose} title="Ask a question">
      <Field label="Question" value={question} onChangeText={setQuestion} multiline testID="opportunity-question" />
      <View style={{ height: 10 }} />
      <Button title="Send" kind="primary" wide onPress={submit} loading={busy} testID="opportunity-question-send" />
    </Sheet>
  );
}
