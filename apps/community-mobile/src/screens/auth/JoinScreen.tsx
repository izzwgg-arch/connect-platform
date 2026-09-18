import { useState } from "react";
import { KeyboardAvoidingView, Platform, SafeAreaView, ScrollView, Text } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError } from "../../api/client";
import { applySession, useAuth } from "../../auth/AuthProvider";
import { Button, Field, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { AuthStackParamList } from "../../navigation/types";

type Props = NativeStackScreenProps<AuthStackParamList, "Join">;

function passwordStrength(pw: string): { label: string; ok: boolean } {
  if (pw.length < 8) return { label: "Too short (8+ characters)", ok: false };
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((r) => r.test(pw)).length;
  if (classes < 2) return { label: "Weak — mix letters, numbers or symbols", ok: false };
  return { label: classes >= 3 ? "Strong" : "Good", ok: true };
}

export function JoinScreen({ navigation }: Props) {
  const { theme } = useTheme();
  const toast = useToast();
  const { reload } = useAuth();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const strength = password ? passwordStrength(password) : null;

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      const body = await api<{ accessToken: string; refreshToken: string }>("/auth/register", {
        body: { firstName, lastName, email: email || undefined, phone: phone || undefined, password, client: "mobile" },
        auth: false,
      });
      await applySession(body);
      await reload();
      navigation.navigate("Verify", { purpose: email ? "email" : "phone", target: email || phone });
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: 24, gap: 14 }}>
          <Text style={{ color: theme.text, fontSize: 20, fontWeight: "800", textAlign: "center" }}>Create your Loopcom ID</Text>
          <Field label="First name" value={firstName} onChangeText={setFirstName} testID="join-first" />
          <Field label="Last name" value={lastName} onChangeText={setLastName} testID="join-last" />
          <Field label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" testID="join-email" />
          <Field label="Mobile number (or use email)" value={phone} onChangeText={setPhone} keyboardType="phone-pad" testID="join-phone" />
          <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry testID="join-password" />
          {strength ? <Text style={{ color: strength.ok ? theme.success : theme.warning, fontSize: 12 }}>{strength.label}</Text> : null}
          {error ? (
            <Text accessibilityRole="alert" style={{ color: theme.danger }}>
              {error}
            </Text>
          ) : null}
          <Button
            title="Create account"
            kind="primary"
            wide
            onPress={submit}
            loading={busy}
            disabled={!firstName || !lastName || !password || (!email && !phone)}
            testID="join-submit"
          />
          <Button title="Already have an account? Sign in" kind="ghost" wide onPress={() => navigation.navigate("SignIn")} testID="join-signin" />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
