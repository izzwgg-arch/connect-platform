import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, SafeAreaView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError } from "../../api/client";
import { Avatar, Button, Chip, Empty, Field, Sheet, Skeleton, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { HomeStackParamList } from "../../navigation/types";

type Contact = { person: { id: string; name: string; username: string; avatarAssetId: string | null; headline: string | null }; lastContactAt: string | null };
type Note = { id: string; body: string; tags: string[]; dealValue: string | null; nextAction: string | null; createdAt: string };
type Reminder = { id: string; title: string; dueAt: string; doneAt: string | null; targetPerson: { id: string; name: string } | null };

type Props = NativeStackScreenProps<HomeStackParamList, "Crm">;

export function CrmScreen({ navigation }: Props) {
  const { theme } = useTheme();
  const toast = useToast();
  const [tab, setTab] = useState<"contacts" | "reminders">("contacts");
  const [q, setQ] = useState("");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);
  const [openContact, setOpenContact] = useState<Contact | null>(null);
  const [reminderSheetOpen, setReminderSheetOpen] = useState(false);
  // Loaded once, independent of the active tab or its search box — the
  // reminder sheet's person picker needs a list even while "Reminders" is
  // the active tab (every reminder needs exactly one target person; see
  // reminderWriteSchema's refine in apps/community-api/src/crm/routes.ts).
  const [pickerPeople, setPickerPeople] = useState<Contact[]>([]);
  useEffect(() => {
    api<{ items: Contact[] }>("/crm/contacts")
      .then((r) => setPickerPeople(r.items))
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (tab === "contacts") {
        const qs = new URLSearchParams();
        if (q.trim()) qs.set("q", q.trim());
        const res = await api<{ items: Contact[] }>(`/crm/contacts?${qs.toString()}`);
        setContacts(res.items);
      } else {
        const res = await api<{ items: Reminder[] }>("/crm/reminders?due=all");
        setReminders(res.items);
      }
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setLoading(false);
    }
  }, [tab, q]);

  useEffect(() => {
    load();
  }, [load]);

  async function toggleDone(r: Reminder) {
    try {
      await api(`/crm/reminders/${r.id}`, { method: "PATCH", body: { done: !r.doneAt } });
      load();
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  async function deleteReminder(r: Reminder) {
    try {
      await api(`/crm/reminders/${r.id}`, { method: "DELETE" });
      setReminders((prev) => prev.filter((x) => x.id !== r.id));
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={{ padding: 12, gap: 10 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text style={{ color: theme.text, fontSize: 20, fontWeight: "800" }}>CRM</Text>
          {tab === "reminders" ? <Button title="New reminder" icon="plus" kind="primary" onPress={() => setReminderSheetOpen(true)} testID="crm-new-reminder" /> : null}
        </View>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Chip label="Contacts" active={tab === "contacts"} onPress={() => setTab("contacts")} />
          <Chip label="Reminders" active={tab === "reminders"} onPress={() => setTab("reminders")} />
        </View>
        {tab === "contacts" ? <Field placeholder="Search your contacts" value={q} onChangeText={setQ} onSubmitEditing={load} testID="crm-search" /> : null}
      </View>

      {loading ? (
        <View style={{ padding: 12 }}>
          <Skeleton height={80} radius={14} />
        </View>
      ) : tab === "contacts" ? (
        <FlatList
          data={contacts}
          keyExtractor={(c) => c.person.id}
          contentContainerStyle={{ padding: 12, gap: 10 }}
          ListEmptyComponent={<Empty icon="people" title="No contacts yet" hint="People you connect with, note, or set a reminder for show up here." />}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => setOpenContact(item)}
              accessibilityRole="button"
              style={{ flexDirection: "row", gap: 10, alignItems: "center", backgroundColor: theme.panel, borderRadius: 14, borderWidth: 1, borderColor: theme.border, padding: 12 }}
            >
              <Avatar assetId={item.person.avatarAssetId} name={item.person.name} />
              <View style={{ flex: 1 }}>
                <Text style={{ color: theme.text, fontWeight: "700" }}>{item.person.name}</Text>
                <Text style={{ color: theme.dim, fontSize: 12 }} numberOfLines={1}>
                  {item.person.headline ?? `@${item.person.username}`}
                </Text>
              </View>
              {item.lastContactAt ? <Text style={{ color: theme.dim, fontSize: 11 }}>{new Date(item.lastContactAt).toLocaleDateString()}</Text> : null}
            </Pressable>
          )}
        />
      ) : (
        <FlatList
          data={reminders}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ padding: 12, gap: 10 }}
          ListEmptyComponent={<Empty icon="clock" title="No reminders" />}
          renderItem={({ item }) => (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: theme.panel, borderRadius: 14, borderWidth: 1, borderColor: theme.border, padding: 12 }}>
              <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: !!item.doneAt }} onPress={() => toggleDone(item)} hitSlop={8}>
                <View style={{ width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: theme.accent, backgroundColor: item.doneAt ? theme.accent : "transparent" }} />
              </Pressable>
              <View style={{ flex: 1 }}>
                <Text style={{ color: theme.text, fontWeight: "700", textDecorationLine: item.doneAt ? "line-through" : "none" }}>{item.title}</Text>
                <Text style={{ color: theme.dim, fontSize: 12 }}>
                  {item.targetPerson?.name ?? "General"} · {new Date(item.dueAt).toLocaleDateString()}
                </Text>
              </View>
              <Pressable accessibilityRole="button" accessibilityLabel="Delete reminder" onPress={() => deleteReminder(item)}>
                <Text style={{ color: theme.danger }}>Delete</Text>
              </Pressable>
            </View>
          )}
        />
      )}

      <ContactSheet
        contact={openContact}
        onClose={() => setOpenContact(null)}
        onOpenProfile={(username) => {
          setOpenContact(null);
          navigation.navigate("PersonProfile", { username });
        }}
        onReminderCreated={tab === "reminders" ? load : undefined}
      />
      <NewReminderSheet
        visible={reminderSheetOpen}
        onClose={() => setReminderSheetOpen(false)}
        people={pickerPeople}
        onCreated={() => {
          setReminderSheetOpen(false);
          load();
        }}
      />
    </SafeAreaView>
  );
}

function ContactSheet({
  contact,
  onClose,
  onOpenProfile,
  onReminderCreated,
}: {
  contact: Contact | null;
  onClose: () => void;
  onOpenProfile: (username: string) => void;
  onReminderCreated?: () => void;
}) {
  const { theme } = useTheme();
  const toast = useToast();
  const [notes, setNotes] = useState<Note[]>([]);
  const [newNote, setNewNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [reminderOpen, setReminderOpen] = useState(false);

  useEffect(() => {
    if (!contact) return;
    api<{ items: Note[] }>(`/crm/notes?personId=${contact.person.id}`)
      .then((r) => setNotes(r.items))
      .catch(() => setNotes([]));
  }, [contact?.person.id]);

  async function addNote() {
    if (!contact || !newNote.trim()) return;
    setSaving(true);
    try {
      await api("/crm/notes", { method: "POST", body: { targetPersonId: contact.person.id, body: newNote.trim() } });
      setNewNote("");
      const r = await api<{ items: Note[] }>(`/crm/notes?personId=${contact.person.id}`);
      setNotes(r.items);
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Sheet visible={!!contact} onClose={onClose} title={contact?.person.name}>
      {contact ? (
        <View style={{ gap: 10 }}>
          <View style={{ flexDirection: "row", gap: 10 }}>
            <Button title="View profile" onPress={() => onOpenProfile(contact.person.username)} />
            <Button title="Set reminder" icon="clock" onPress={() => setReminderOpen(true)} testID="crm-contact-remind" />
          </View>
          <Field placeholder="Add a note" value={newNote} onChangeText={setNewNote} multiline testID="crm-note-input" />
          <Button title="Save note" kind="primary" onPress={addNote} loading={saving} testID="crm-note-save" />
          {notes.map((n) => (
            <View key={n.id} style={{ backgroundColor: theme.panel2, borderRadius: 10, padding: 10, gap: 4 }}>
              <Text style={{ color: theme.text }}>{n.body}</Text>
              <Text style={{ color: theme.dim, fontSize: 11 }}>{new Date(n.createdAt).toLocaleString()}</Text>
            </View>
          ))}
        </View>
      ) : null}
      <NewReminderSheet
        visible={reminderOpen}
        onClose={() => setReminderOpen(false)}
        people={contact ? [contact] : []}
        presetPersonId={contact?.person.id}
        onCreated={() => {
          setReminderOpen(false);
          onReminderCreated?.();
        }}
      />
    </Sheet>
  );
}

function NewReminderSheet({
  visible,
  onClose,
  onCreated,
  people,
  presetPersonId,
}: {
  visible: boolean;
  onClose: () => void;
  onCreated: () => void;
  people: Contact[];
  presetPersonId?: string;
}) {
  const { theme } = useTheme();
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [targetPersonId, setTargetPersonId] = useState<string | undefined>(presetPersonId);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (visible) setTargetPersonId(presetPersonId);
  }, [visible, presetPersonId]);

  async function submit() {
    // Every reminder needs exactly one target — a person or a business (the
    // api refuses otherwise). This screen only ever targets a person.
    if (!title.trim() || !dueDate.trim() || !targetPersonId) {
      toast("A title, a due date, and who it's about are all needed.", { kind: "err" });
      return;
    }
    const due = new Date(dueDate.trim());
    if (Number.isNaN(due.getTime())) {
      toast("Enter a valid date, e.g. 2026-12-01.", { kind: "err" });
      return;
    }
    setBusy(true);
    try {
      await api("/crm/reminders", { method: "POST", body: { title: title.trim(), dueAt: due.toISOString(), targetPersonId } });
      setTitle("");
      setDueDate("");
      onCreated();
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet visible={visible} onClose={onClose} title="New reminder">
      <View style={{ gap: 10 }}>
        <Field label="Title" value={title} onChangeText={setTitle} testID="crm-reminder-title" />
        <Field label="Due date (YYYY-MM-DD)" value={dueDate} onChangeText={setDueDate} testID="crm-reminder-due" />
        {!presetPersonId ? (
          <View style={{ gap: 6 }}>
            <Text style={{ color: theme.dim, fontSize: 13, fontWeight: "600" }}>About</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {people.map((c) => (
                <Chip key={c.person.id} label={c.person.name} active={targetPersonId === c.person.id} onPress={() => setTargetPersonId(c.person.id)} />
              ))}
              {people.length === 0 ? <Text style={{ color: theme.dim, fontSize: 12 }}>No contacts yet to remind yourself about.</Text> : null}
            </View>
          </View>
        ) : null}
        <Button title="Create" kind="primary" wide onPress={submit} loading={busy} testID="crm-reminder-create" />
      </View>
    </Sheet>
  );
}
