import { useCallback, useEffect, useState } from "react";
import { Alert, SafeAreaView, ScrollView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError } from "../../api/client";
import { formatMoney, suggestPerUnit } from "../../domain/quoteMath";
import { Button, Card, Chip, Empty, Field, Sheet, Skeleton, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { HomeStackParamList } from "../../navigation/types";

type Quote = {
  id: string;
  organization: { id: string; displayName: string } | null;
  authorId: string;
  total: string;
  perUnit: string | null;
  deliveryDate: string | null;
  notes: string | null;
  status: string;
  version: number;
};

type Question = {
  id: string;
  organization: { id: string; displayName: string } | null;
  askedBy: { id: string; name: string } | null;
  question: string;
  answer: string | null;
  isPublic: boolean;
};

type RfqDetail = {
  id: string;
  number: string;
  title: string;
  description: string;
  status: string;
  quantity: string | null;
  budgetMin: string | null;
  budgetMax: string | null;
  location: string | null;
  deadline: string | null;
  requirements: string[];
  closesAt: string | null;
  buyer: { id: string; name: string } | null;
  organization: { id: string; displayName: string } | null;
  stats: { invited: number; viewed: number; quoted: number; declined: number };
  quotes: Quote[];
  questions: Question[];
  myRole: "buyer" | "vendor" | "visitor";
  myOrgOptions: Array<{ id: string; slug: string; displayName: string }>;
  canEdit: boolean;
};

type Props = NativeStackScreenProps<HomeStackParamList, "RfqDetail">;

export function RfqDetailScreen({ route, navigation }: Props) {
  const { id } = route.params;
  const { theme } = useTheme();
  const toast = useToast();
  const [data, setData] = useState<RfqDetail | null>(null);
  const [quoteSheetOpen, setQuoteSheetOpen] = useState(false);
  const [questionOpen, setQuestionOpen] = useState(false);

  const load = useCallback(() => {
    api<RfqDetail>(`/rfq/${id}`)
      .then(setData)
      .catch((err) => toast((err as ApiError).message, { kind: "err" }));
  }, [id]);

  useEffect(load, [load]);

  async function accept(quoteId: string) {
    Alert.alert("Accept this quote?", "The other quotes will be declined.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Accept",
        onPress: async () => {
          try {
            await api(`/rfq/${id}/quotes/${quoteId}/accept`, { method: "POST" });
            toast("Quote accepted.");
            load();
          } catch (err) {
            toast((err as ApiError).message, { kind: "err" });
          }
        },
      },
    ]);
  }

  async function shortlist(quoteId: string) {
    try {
      await api(`/rfq/${id}/quotes/${quoteId}/shortlist`, { method: "POST" });
      load();
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  async function decline(quoteId: string) {
    try {
      await api(`/rfq/${id}/quotes/${quoteId}/decline`, { method: "POST" });
      load();
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  async function messageAbout(quoteId: string, orgName: string | undefined) {
    try {
      const res = await api<{ threadId: string }>(`/rfq/${id}/quotes/${quoteId}/thread`, { method: "POST" });
      (navigation.getParent() as any)?.navigate("MessagesTab", { screen: "Conversation", params: { threadId: res.threadId, title: orgName ? `${orgName} — ${data?.title ?? "Quote"}` : "Quote" } });
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  async function closeRfq() {
    Alert.alert("Close this request?", "Vendors won't be able to submit new quotes.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Close",
        style: "destructive",
        onPress: async () => {
          try {
            await api(`/rfq/${id}/close`, { method: "POST" });
            load();
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

  const myQuote = data.myRole === "vendor" ? data.quotes.find((q) => data.myOrgOptions.some((o) => o.id === q.organization?.id)) : undefined;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }}>
        <View>
          <Text style={{ color: theme.dim, fontSize: 12 }}>{data.number}</Text>
          <Text style={{ color: theme.text, fontSize: 20, fontWeight: "800" }}>{data.title}</Text>
          <Text style={{ color: theme.dim, fontSize: 12 }}>by {data.buyer?.name ?? data.organization?.displayName ?? "Someone"}</Text>
        </View>

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Chip label={data.status.toLowerCase()} />
          {data.quantity ? <Chip label={data.quantity} /> : null}
          {data.location ? <Chip label={data.location} /> : null}
          {data.deadline ? <Chip label={`Due ${new Date(data.deadline).toLocaleDateString()}`} /> : null}
        </View>
        {data.budgetMin || data.budgetMax ? (
          <Text style={{ color: theme.text, fontWeight: "700" }}>
            Budget: {data.budgetMin ? formatMoney(data.budgetMin) : "any"} – {data.budgetMax ? formatMoney(data.budgetMax) : "any"}
          </Text>
        ) : null}

        <Text style={{ color: theme.text, lineHeight: 20 }}>{data.description}</Text>

        {data.requirements.length ? (
          <View style={{ gap: 4 }}>
            <Text style={{ color: theme.text, fontWeight: "800" }}>Requirements</Text>
            {data.requirements.map((r, i) => (
              <Text key={i} style={{ color: theme.text }}>
                {"•"} {r}
              </Text>
            ))}
          </View>
        ) : null}

        {data.myRole === "buyer" ? (
          <Card style={{ gap: 4 }}>
            <Text style={{ color: theme.text, fontWeight: "800" }}>Activity</Text>
            <Text style={{ color: theme.dim, fontSize: 12 }}>
              {data.stats.invited} invited · {data.stats.viewed} viewed · {data.stats.quoted} quoted · {data.stats.declined} declined
            </Text>
            {data.canEdit ? <Button title="Close request" kind="danger" onPress={closeRfq} testID="rfq-close" /> : null}
          </Card>
        ) : null}

        {data.myRole === "vendor" && data.status === "OPEN" ? (
          <Button title={myQuote ? "Update my quote" : "Submit a quote"} kind="primary" onPress={() => setQuoteSheetOpen(true)} testID="rfq-submit-quote" />
        ) : null}

        {data.quotes.length ? (
          <View style={{ gap: 10 }}>
            <Text style={{ color: theme.text, fontWeight: "800" }}>Quotes ({data.quotes.length})</Text>
            {data.quotes.map((q) => (
              <Card key={q.id} style={{ gap: 6 }}>
                <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                  <Text style={{ color: theme.text, fontWeight: "700" }}>{q.organization?.displayName ?? "Vendor"}</Text>
                  <Chip label={q.status.toLowerCase()} />
                </View>
                <Text style={{ color: theme.text, fontSize: 16, fontWeight: "800" }}>{formatMoney(q.total)}</Text>
                {q.perUnit ? <Text style={{ color: theme.dim, fontSize: 12 }}>{formatMoney(q.perUnit)} per unit</Text> : null}
                {q.deliveryDate ? <Text style={{ color: theme.dim, fontSize: 12 }}>Delivery by {new Date(q.deliveryDate).toLocaleDateString()}</Text> : null}
                {q.notes ? <Text style={{ color: theme.text, fontSize: 13 }}>{q.notes}</Text> : null}
                <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
                  {data.myRole === "buyer" && ["SUBMITTED", "SHORTLISTED"].includes(q.status) ? (
                    <>
                      <Button title="Accept" kind="primary" onPress={() => accept(q.id)} testID={`rfq-quote-accept-${q.id}`} />
                      {q.status !== "SHORTLISTED" ? <Button title="Shortlist" onPress={() => shortlist(q.id)} /> : null}
                      <Button title="Decline" kind="danger" onPress={() => decline(q.id)} />
                    </>
                  ) : null}
                  <Button title="Message" icon="msg" onPress={() => messageAbout(q.id, q.organization?.displayName)} />
                </View>
              </Card>
            ))}
          </View>
        ) : (
          <Empty icon="quote" title="No quotes yet" />
        )}

        <View style={{ gap: 10 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
            <Text style={{ color: theme.text, fontWeight: "800" }}>Questions</Text>
            {data.myRole === "vendor" ? <Button title="Ask" onPress={() => setQuestionOpen(true)} /> : null}
          </View>
          {data.questions.length === 0 ? <Text style={{ color: theme.dim, fontSize: 13 }}>No questions yet.</Text> : null}
          {data.questions.map((q) => (
            <Card key={q.id} tight style={{ gap: 4 }}>
              <Text style={{ color: theme.text, fontSize: 13 }}>
                <Text style={{ fontWeight: "700" }}>{q.askedBy?.name ?? q.organization?.displayName ?? "Someone"}: </Text>
                {q.question}
              </Text>
              {q.answer ? (
                <Text style={{ color: theme.dim, fontSize: 13 }}>
                  <Text style={{ fontWeight: "700" }}>Answer: </Text>
                  {q.answer}
                </Text>
              ) : data.myRole === "buyer" ? (
                <AnswerRow rfqId={id} questionId={q.id} onAnswered={load} />
              ) : (
                <Text style={{ color: theme.dim, fontSize: 12, fontStyle: "italic" }}>Not answered yet.</Text>
              )}
            </Card>
          ))}
        </View>
      </ScrollView>

      <SubmitQuoteSheet
        visible={quoteSheetOpen}
        onClose={() => setQuoteSheetOpen(false)}
        rfqId={id}
        quantity={data.quantity}
        orgOptions={data.myOrgOptions}
        existing={myQuote}
        onSubmitted={() => {
          setQuoteSheetOpen(false);
          load();
        }}
      />
      <AskQuestionSheet
        visible={questionOpen}
        onClose={() => setQuestionOpen(false)}
        rfqId={id}
        orgOptions={data.myOrgOptions}
        onAsked={() => {
          setQuestionOpen(false);
          load();
        }}
      />
    </SafeAreaView>
  );
}

function AnswerRow({ rfqId, questionId, onAnswered }: { rfqId: string; questionId: string; onAnswered: () => void }) {
  const { theme } = useTheme();
  const toast = useToast();
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!answer.trim()) return;
    setBusy(true);
    try {
      await api(`/rfq/${rfqId}/questions/${questionId}/answer`, { method: "POST", body: { answer: answer.trim() } });
      onAnswered();
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
      <View style={{ flex: 1 }}>
        <Field placeholder="Write an answer" value={answer} onChangeText={setAnswer} />
      </View>
      <Button title="Send" onPress={submit} loading={busy} />
    </View>
  );
}

function SubmitQuoteSheet({
  visible,
  onClose,
  rfqId,
  quantity,
  orgOptions,
  existing,
  onSubmitted,
}: {
  visible: boolean;
  onClose: () => void;
  rfqId: string;
  quantity: string | null;
  orgOptions: Array<{ id: string; displayName: string }>;
  existing?: Quote;
  onSubmitted: () => void;
}) {
  const { theme } = useTheme();
  const toast = useToast();
  const [organizationId, setOrganizationId] = useState(existing?.organization?.id ?? orgOptions[0]?.id ?? "");
  const [total, setTotal] = useState(existing?.total ?? "");
  const [perUnit, setPerUnit] = useState(existing?.perUnit ?? "");
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [submitting, setSubmitting] = useState(false);

  const suggestion = suggestPerUnit(Number(total) || null, quantity);

  async function submit() {
    if (!organizationId) {
      toast("Choose which of your companies is quoting.", { kind: "err" });
      return;
    }
    const totalNum = Number(total);
    if (!total || !Number.isFinite(totalNum) || totalNum <= 0) {
      toast("Enter a total price.", { kind: "err" });
      return;
    }
    setSubmitting(true);
    try {
      await api(`/rfq/${rfqId}/quotes`, {
        method: "POST",
        body: { organizationId, total: totalNum, perUnit: perUnit ? Number(perUnit) : undefined, notes: notes || undefined },
      });
      toast("Quote sent.");
      onSubmitted();
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Sheet visible={visible} onClose={onClose} title="Submit a quote">
      <ScrollView contentContainerStyle={{ gap: 12 }}>
        {orgOptions.length > 1 ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {orgOptions.map((o) => (
              <Chip key={o.id} label={o.displayName} active={organizationId === o.id} onPress={() => setOrganizationId(o.id)} />
            ))}
          </View>
        ) : null}
        <Field label="Total price" keyboardType="decimal-pad" value={total} onChangeText={setTotal} testID="quote-total" />
        <Field
          label={`Per unit (optional)${suggestion != null ? ` — suggested ${suggestion}` : ""}`}
          keyboardType="decimal-pad"
          value={perUnit}
          onChangeText={setPerUnit}
          testID="quote-per-unit"
        />
        <Field label="Notes (optional)" value={notes} onChangeText={setNotes} multiline testID="quote-notes" />
        <Button title={existing ? "Update quote" : "Submit quote"} kind="primary" wide onPress={submit} loading={submitting} testID="quote-submit" />
      </ScrollView>
    </Sheet>
  );
}

function AskQuestionSheet({
  visible,
  onClose,
  rfqId,
  orgOptions,
  onAsked,
}: {
  visible: boolean;
  onClose: () => void;
  rfqId: string;
  orgOptions: Array<{ id: string; displayName: string }>;
  onAsked: () => void;
}) {
  const toast = useToast();
  const [organizationId, setOrganizationId] = useState(orgOptions[0]?.id ?? "");
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!organizationId || question.trim().length < 3) {
      toast("Write a question first.", { kind: "err" });
      return;
    }
    setBusy(true);
    try {
      await api(`/rfq/${rfqId}/questions`, { method: "POST", body: { organizationId, question: question.trim() } });
      setQuestion("");
      onAsked();
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet visible={visible} onClose={onClose} title="Ask a question">
      {orgOptions.length > 1 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
          {orgOptions.map((o) => (
            <Chip key={o.id} label={o.displayName} active={organizationId === o.id} onPress={() => setOrganizationId(o.id)} />
          ))}
        </View>
      ) : null}
      <Field label="Question" value={question} onChangeText={setQuestion} multiline testID="rfq-question" />
      <View style={{ height: 10 }} />
      <Button title="Send" kind="primary" wide onPress={submit} loading={busy} testID="rfq-question-submit" />
    </Sheet>
  );
}
