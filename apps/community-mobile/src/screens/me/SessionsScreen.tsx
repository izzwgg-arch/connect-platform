import { useCallback, useEffect, useState } from "react";
import { FlatList, SafeAreaView, Text, View } from "react-native";
import { api, ApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthProvider";
import { Button, Empty, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";

type Session = { id: string; deviceLabel: string | null; client: string; ip: string | null; lastUsedAt: string; createdAt: string; current: boolean };

export function SessionsScreen() {
  const { theme } = useTheme();
  const toast = useToast();
  const { signOut } = useAuth();
  const [sessions, setSessions] = useState<Session[]>([]);

  const load = useCallback(() => {
    api<{ sessions: Session[] }>("/auth/sessions")
      .then((r) => setSessions(r.sessions))
      .catch((err) => toast((err as ApiError).message, { kind: "err" }));
  }, []);

  useEffect(load, [load]);

  async function revoke(id: string) {
    try {
      await api(`/auth/sessions/${id}`, { method: "DELETE" });
      setSessions((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  async function revokeAll() {
    try {
      await api("/auth/logout-all", { method: "POST" });
      await signOut();
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={{ padding: 16 }}>
        <Button title="Sign out everywhere" kind="danger" onPress={revokeAll} testID="sessions-revoke-all" />
      </View>
      <FlatList
        data={sessions}
        keyExtractor={(s) => s.id}
        contentContainerStyle={{ padding: 16, gap: 10 }}
        ListEmptyComponent={<Empty icon="lock" title="No active sessions" />}
        renderItem={({ item }) => (
          <View style={{ backgroundColor: theme.panel, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: theme.border, gap: 4 }}>
            <Text style={{ color: theme.text, fontWeight: "700" }}>
              {item.deviceLabel ?? item.client} {item.current ? "(this device)" : ""}
            </Text>
            <Text style={{ color: theme.dim, fontSize: 12 }}>Last used {new Date(item.lastUsedAt).toLocaleString()}</Text>
            {!item.current ? <Button title="Sign out" onPress={() => revoke(item.id)} /> : null}
          </View>
        )}
      />
    </SafeAreaView>
  );
}
