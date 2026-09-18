import { useEffect, useState } from "react";
import { SafeAreaView, ScrollView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError } from "../../api/client";
import { coerceFields, initialFieldValues, validateFields, type OpportunityField } from "../../domain/dynamicFields";
import { Button, Chip, Field, Skeleton, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { HomeStackParamList } from "../../navigation/types";

type OppType = { id: string; slug: string; name: string; description: string; fieldSchema: OpportunityField[]; count: number };

type Props = NativeStackScreenProps<HomeStackParamList, "PostOpportunity">;

export function PostOpportunityScreen({ route, navigation }: Props) {
  const { theme } = useTheme();
  const toast = useToast();
  const [types, setTypes] = useState<OppType[]>([]);
  const [typeSlug, setTypeSlug] = useState<string | undefined>(route.params?.typeSlug);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [location, setLocation] = useState("");
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api<{ types: OppType[] }>("/opportunities/types")
      .then((r) => {
        setTypes(r.types);
        if (!typeSlug && r.types[0]) setTypeSlug(r.types[0].slug);
      })
      .catch(() => {});
  }, []);

  const type = types.find((t) => t.slug === typeSlug);

  useEffect(() => {
    if (type) setValues(initialFieldValues(type.fieldSchema));
  }, [type?.id]);

  async function submit() {
    if (!type) return;
    if (title.trim().length < 3 || description.trim().length < 1) {
      toast("A title and description are needed.", { kind: "err" });
      return;
    }
    const coerced = coerceFields(type.fieldSchema, values);
    const errors = validateFields(type.fieldSchema, coerced);
    if (errors.length) {
      toast(errors.join(" "), { kind: "err" });
      return;
    }
    setSubmitting(true);
    try {
      const res = await api<{ opportunity: { id: string } }>("/opportunities", {
        method: "POST",
        body: { typeSlug: type.slug, title: title.trim(), description: description.trim(), fields: coerced, location: location.trim() || undefined },
      });
      toast("Posted.");
      navigation.replace("OpportunityDetail", { id: res.opportunity.id });
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setSubmitting(false);
    }
  }

  if (!types.length) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg, padding: 16 }}>
        <Skeleton height={120} radius={16} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }}>
        <Text style={{ color: theme.text, fontWeight: "800", fontSize: 18 }}>Post an opportunity</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {types.map((t) => (
            <Chip key={t.slug} label={t.name} active={typeSlug === t.slug} onPress={() => setTypeSlug(t.slug)} />
          ))}
        </View>
        {type?.description ? <Text style={{ color: theme.dim, fontSize: 12 }}>{type.description}</Text> : null}

        <Field label="Title" value={title} onChangeText={setTitle} testID="opp-title" />
        <Field label="Description" value={description} onChangeText={setDescription} multiline testID="opp-description" />
        <Field label="Location (optional)" value={location} onChangeText={setLocation} testID="opp-location" />

        {type?.fieldSchema.map((f) => (
          <DynamicField key={f.key} field={f} value={values[f.key]} onChange={(v) => setValues((prev) => ({ ...prev, [f.key]: v }))} />
        ))}

        <Button title="Post" kind="primary" wide onPress={submit} loading={submitting} testID="opp-submit" />
      </ScrollView>
    </SafeAreaView>
  );
}

function DynamicField({ field, value, onChange }: { field: OpportunityField; value: unknown; onChange: (v: unknown) => void }) {
  if (field.type === "select") {
    return (
      <View style={{ gap: 6 }}>
        <FieldLabel field={field} />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {(field.options ?? []).map((opt) => (
            <Chip key={opt} label={opt} active={value === opt} onPress={() => onChange(opt)} />
          ))}
        </View>
      </View>
    );
  }
  if (field.type === "multiselect") {
    const arr = Array.isArray(value) ? (value as string[]) : [];
    return (
      <View style={{ gap: 6 }}>
        <FieldLabel field={field} />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {(field.options ?? []).map((opt) => (
            <Chip key={opt} label={opt} active={arr.includes(opt)} onPress={() => onChange(arr.includes(opt) ? arr.filter((x) => x !== opt) : [...arr, opt])} />
          ))}
        </View>
      </View>
    );
  }
  if (field.type === "boolean") {
    return <Chip label={field.label} active={!!value} onPress={() => onChange(!value)} />;
  }
  return (
    <Field
      label={`${field.label}${field.required ? "" : " (optional)"}`}
      value={String(value ?? "")}
      onChangeText={onChange}
      keyboardType={field.type === "number" || field.type === "money" ? "decimal-pad" : "default"}
      testID={`opp-field-${field.key}`}
    />
  );
}

function FieldLabel({ field }: { field: OpportunityField }) {
  const { theme } = useTheme();
  return <Text style={{ color: theme.dim, fontWeight: "600", fontSize: 13 }}>{field.label}</Text>;
}
