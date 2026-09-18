import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, SafeAreaView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError } from "../../api/client";
import type { PersonCard } from "../../api/types";
import { Avatar, Button, Chip, Empty, Field, Icon, Sheet, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { NetworkStackParamList } from "../../navigation/types";

type ConnRow = { connection: { id: string; acceptedAt: string | null }; person: PersonCard | null; relationship: string[]; loopcomLinked: boolean };

const RELATIONSHIP_KINDS = ["WORKED_WITH", "PURCHASED_FROM", "SOLD_TO", "REFERRED", "PARTNER", "CUSTOMER", "VENDOR", "MENTOR"];
const FILTERS = [
  { key: "all", label: "All" },
  { key: "customers", label: "Customers" },
  { key: "vendors", label: "Vendors" },
  { key: "worked_with", label: "Worked with" },
  { key: "referred", label: "Referred" },
  { key: "partners", label: "Partners" },
  { key: "loopcom", label: "Loopcom" },
];

type Props = NativeStackScreenProps<NetworkStackParamList, "Connections">;

export function ConnectionsScreen({ navigation, route }: Props) {
  const { theme } = useTheme();
  const toast = useToast();
  const [rows, setRows] = useState<ConnRow[]>([]);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState(route.params?.filter ?? "all");
  const [loading, setLoading] = useState(true);
  const [tagsFor, setTagsFor] = useState<ConnRow | null>(null);

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ filter, ...(q ? { q } : {}) });
      const res = await api<{ items: ConnRow[] }>(`/connections?${qs.toString()}`);
      setRows(res.items);
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setLoading(false);
    }
  }, [filter, q]);

  useEffect(() => {
    load();
  }, [load]);

  async function message(row: ConnRow) {
    if (!row.person) return;
    try {
      const thread = await api<{ id: string }>("/threads", { method: "POST", body: { personIds: [row.person.id] } });
      (navigation.getParent() as any)?.navigate("MessagesTab", { screen: "Conversation", params: { threadId: thread.id, title: row.person.name } });
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  async function remove(row: ConnRow) {
    try {
      await api(`/connections/${row.connection.id}`, { method: "DELETE" });
      setRows((prev) => prev.filter((r) => r.connection.id !== row.connection.id));
      toast("Connection removed.");
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={{ padding: 12, gap: 10 }}>
        <Field placeholder="Search your connections" value={q} onChangeText={setQ} onSubmitEditing={load} testID="connections-search" />
        <FlatList
          horizontal
          data={FILTERS}
          keyExtractor={(f) => f.key}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 8 }}
          renderItem={({ item }) => <Chip label={item.label} active={filter === item.key} onPress={() => setFilter(item.key)} />}
        />
      </View>
      <FlatList
        data={rows}
        keyExtractor={(r) => r.connection.id}
        contentContainerStyle={{ padding: 12, gap: 10 }}
        ListEmptyComponent={!loading ? <Empty icon="people" title="No connections match" /> : null}
        renderItem={({ item }) => (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: theme.panel, padding: 10, borderRadius: 12, borderWidth: 1, borderColor: theme.border }}>
            <Pressable
              onPress={() => item.person && navigation.navigate("PersonProfile", { username: item.person.username })}
              style={{ flexDirection: "row", alignItems: "center", gap: 10, flex: 1 }}
              accessibilityRole="button"
            >
              <Avatar assetId={item.person?.avatarAssetId} name={item.person?.name} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: theme.text, fontWeight: "700" }}>{item.person?.name ?? "Someone"}</Text>
                <Text style={{ color: theme.dim, fontSize: 12 }}>{item.person?.headline ?? item.relationship.join(", ")}</Text>
              </View>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Message" onPress={() => message(item)}>
              <Icon name="msg" size={20} />
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Relationship tags" onPress={() => setTagsFor(item)}>
              <Icon name="tag" size={20} />
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Remove connection" onPress={() => remove(item)}>
              <Icon name="trash" size={20} color={theme.danger} />
            </Pressable>
          </View>
        )}
      />
      <RelationshipSheet row={tagsFor} onClose={() => setTagsFor(null)} />
    </SafeAreaView>
  );
}

function RelationshipSheet({ row, onClose }: { row: ConnRow | null; onClose: () => void }) {
  const toast = useToast();
  const [kinds, setKinds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!row?.person) return;
    api<{ kinds: Array<{ kind: string }> }>(`/people/${row.person.id}/relationship`)
      .then((r) => setKinds(r.kinds.map((k) => k.kind)))
      .catch(() => setKinds([]));
  }, [row?.person?.id]);

  async function save() {
    if (!row?.person) return;
    setSaving(true);
    try {
      await api(`/people/${row.person.id}/relationship`, { method: "PUT", body: { kinds } });
      toast("Saved.");
      onClose();
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet visible={!!row} onClose={onClose} title={row?.person ? `Tag ${row.person.name}` : "Relationship"}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        {RELATIONSHIP_KINDS.map((k) => (
          <Chip
            key={k}
            label={k.replace("_", " ").toLowerCase()}
            active={kinds.includes(k)}
            onPress={() => setKinds((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]))}
          />
        ))}
      </View>
      <Button title="Save" kind="primary" wide onPress={save} loading={saving} testID="relationship-save" />
    </Sheet>
  );
}
