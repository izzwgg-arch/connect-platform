// The new SDK 54 expo-file-system API (File/Directory/Paths) has no simple
// download-with-auth-header helper; the legacy module still does and apps/mobile
// uses the same import for the same reason.
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { useEffect, useState } from "react";
import { Alert, SafeAreaView, ScrollView, Switch, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { API_URL, api, ApiError, getAccessToken } from "../../api/client";
import { useAuth } from "../../auth/AuthProvider";
import { Button, Field, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { MeStackParamList } from "../../navigation/types";

type Prefs = Record<string, boolean>;

const PRIVACY_KEYS: Array<{ key: string; label: string }> = [
  { key: "searchEngineVisible", label: "Show my profile in search engines" },
  { key: "findableByPhone", label: "Let people find me by phone number" },
  { key: "readReceipts", label: "Send read receipts" },
  { key: "showOnline", label: "Show when I'm online" },
  { key: "messageRequests", label: "Allow message requests from strangers" },
  { key: "analytics", label: "Share usage analytics to improve Community" },
];

type Props = NativeStackScreenProps<MeStackParamList, "Settings">;

export function SettingsScreen({ navigation }: Props) {
  const { theme } = useTheme();
  const toast = useToast();
  const { me, signOut, biometricEnabled, setBiometricEnabled } = useAuth();
  const [prefs, setPrefs] = useState<Prefs>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ prefs: Prefs }>("/me/profile/preferences")
      .then((r) => setPrefs(r.prefs))
      .catch(() => {});
  }, []);

  async function togglePref(key: string) {
    const next = { ...prefs, [key]: !prefs[key] };
    setPrefs(next);
    try {
      await api("/me/profile/preferences", { method: "PUT", body: { prefs: { [key]: next[key] } } });
    } catch (err) {
      setPrefs(prefs);
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  async function verify(purpose: "email" | "phone") {
    try {
      await api("/auth/verify/send", { method: "POST", body: { purpose } });
      toast(`Verification code sent.`);
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  async function exportData() {
    setBusy(true);
    try {
      const token = getAccessToken();
      const path = `${FileSystem.cacheDirectory}loopcom-community-export.json`;
      const res = await FileSystem.downloadAsync(`${API_URL}/auth/export`, path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(res.uri);
      else toast(`Saved to ${res.uri}`);
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  function deactivate() {
    Alert.alert("Deactivate account", "Your profile will be hidden until you sign in again. Continue?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Deactivate",
        style: "destructive",
        onPress: async () => {
          try {
            await api("/auth/deactivate", { method: "POST" });
            await signOut();
          } catch (err) {
            toast((err as ApiError).message, { kind: "err" });
          }
        },
      },
    ]);
  }

  function deleteAccount() {
    Alert.alert("Delete account", "Your account will be permanently deleted in 14 days. This cannot be undone after that. Continue?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await api("/auth/delete", { method: "POST", body: { confirm: "DELETE" } });
            await signOut();
          } catch (err) {
            toast((err as ApiError).message, { kind: "err" });
          }
        },
      },
    ]);
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 20 }}>
        <Section title="Account">
          {!me?.person.emailVerified && me?.person.email ? <Button title={`Verify email (${me.person.email})`} onPress={() => verify("email")} /> : null}
          {!me?.person.phoneVerified && me?.person.phone ? <Button title={`Verify phone (${me.person.phone})`} onPress={() => verify("phone")} /> : null}
          <Text style={{ color: theme.dim, fontSize: 12 }}>{me?.person.loopcomLinked ? "Linked to your Loopcom account." : "Not linked to a Loopcom account."}</Text>
        </Section>

        <Section title="Security">
          <Button title="Sessions" onPress={() => navigation.navigate("Sessions")} testID="settings-sessions" />
          <Button title="Password & two-step verification" onPress={() => navigation.navigate("Security")} testID="settings-security" />
          <Row label="Unlock with Face ID / fingerprint">
            <Switch value={biometricEnabled} onValueChange={setBiometricEnabled} accessibilityLabel="Unlock with biometrics" />
          </Row>
        </Section>

        <Section title="Privacy">
          {PRIVACY_KEYS.map((p) => (
            <Row key={p.key} label={p.label}>
              <Switch value={!!prefs[p.key]} onValueChange={() => togglePref(p.key)} accessibilityLabel={p.label} />
            </Row>
          ))}
          <Button title="Blocked & muted" onPress={() => navigation.navigate("Blocked")} testID="settings-blocked" />
        </Section>

        <Section title="Your data">
          <Button title="Download my data" onPress={exportData} loading={busy} testID="settings-export" />
        </Section>

        <Section title="Danger zone">
          <Button title="Deactivate account" onPress={deactivate} testID="settings-deactivate" />
          <Button title="Delete account" kind="danger" onPress={deleteAccount} testID="settings-delete" />
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const { theme } = useTheme();
  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: theme.dim, fontWeight: "800", fontSize: 13, textTransform: "uppercase" }}>{title}</Text>
      {children}
    </View>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  const { theme } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingVertical: 6 }}>
      <Text style={{ color: theme.text, flex: 1 }}>{label}</Text>
      {children}
    </View>
  );
}
