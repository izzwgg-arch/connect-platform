import { useState } from "react";
import { SafeAreaView, ScrollView, Text } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError } from "../../api/client";
import { Button, Field, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { HomeStackParamList } from "../../navigation/types";

type Props = NativeStackScreenProps<HomeStackParamList, "RfqNew">;

export function RfqNewScreen({ route, navigation }: Props) {
  const { toOrganizationId, toOrganizationName } = route.params ?? {};
  const { theme } = useTheme();
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [quantity, setQuantity] = useState("");
  const [location, setLocation] = useState("");
  const [budgetMax, setBudgetMax] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (title.trim().length < 3 || description.trim().length < 3) {
      toast("A title and description are needed.", { kind: "err" });
      return;
    }
    setSubmitting(true);
    try {
      const res = await api<{ rfq: { id: string }; invitedCount: number }>("/rfq", {
        method: "POST",
        body: {
          title: title.trim(),
          description: description.trim(),
          quantity: quantity.trim() || undefined,
          location: location.trim() || undefined,
          budgetMax: budgetMax.trim() ? Number(budgetMax.trim()) : undefined,
          inviteOrganizationIds: toOrganizationId ? [toOrganizationId] : undefined,
        },
      });
      toast(res.invitedCount ? `Sent to ${res.invitedCount} vendor${res.invitedCount === 1 ? "" : "s"}.` : "Request posted.");
      navigation.replace("RfqDetail", { id: res.rfq.id });
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }}>
        {toOrganizationName ? <Text style={{ color: theme.dim }}>Requesting a quote from {toOrganizationName}.</Text> : null}
        <Field label="What do you need?" placeholder="e.g. 500 custom signs" value={title} onChangeText={setTitle} testID="rfq-title" />
        <Field label="Description" value={description} onChangeText={setDescription} multiline testID="rfq-description" />
        <Field label="Quantity (optional)" placeholder="e.g. 500 units" value={quantity} onChangeText={setQuantity} testID="rfq-quantity" />
        <Field label="Location (optional)" value={location} onChangeText={setLocation} testID="rfq-location" />
        <Field label="Budget max (optional)" keyboardType="decimal-pad" value={budgetMax} onChangeText={setBudgetMax} testID="rfq-budget" />
        <Button title="Post request" kind="primary" wide onPress={submit} loading={submitting} testID="rfq-submit" />
      </ScrollView>
    </SafeAreaView>
  );
}
