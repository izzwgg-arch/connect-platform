import { useState } from "react";
import { KeyboardAvoidingView, Platform, SafeAreaView, ScrollView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError } from "../../api/client";
import { applySession, useAuth } from "../../auth/AuthProvider";
import { Button, Field, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { AuthStackParamList } from "../../navigation/types";

type Props = NativeStackScreenProps<AuthStackParamList, "SignIn">;

export function SignInScreen({ navigation }: Props) {
  const { theme } = useTheme();
  const toast = useToast();
  const { reload } = useAuth();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [needTotp, setNeedTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const body = await api<{ accessToken: string; refreshToken: string }>("/auth/login", {
        body: { identifier, password, totp: needTotp ? totp : undefined, client: "mobile" },
        auth: false,
      });
      await applySession(body);
      await reload();
    } catch (err) {
      const e = err as ApiError;
      if (e.code === "mfa_required") setNeedTotp(true);
      else setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: 24, gap: 14, flexGrow: 1, justifyContent: "center" }}>
          <Text style={{ color: theme.text, fontSize: 20, fontWeight: "800", textAlign: "center" }}>Sign in</Text>
          <Field label="Email, phone or username" value={identifier} onChangeText={setIdentifier} autoCapitalize="none" testID="signin-identifier" />
          <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry testID="signin-password" />
          {needTotp ? (
            <Field label="Authenticator code" value={totp} onChangeText={setTotp} keyboardType="number-pad" testID="signin-totp" />
          ) : null}
          {error ? (
            <Text accessibilityRole="alert" style={{ color: theme.danger }}>
              {error}
            </Text>
          ) : null}
          <Button title="Sign in" kind="primary" wide onPress={submit} loading={busy} disabled={!identifier || !password} testID="signin-submit" />
          <Button title="Forgot password?" kind="ghost" wide onPress={() => navigation.navigate("ForgotPassword")} testID="signin-forgot" />
          <Button title="Create a Loopcom ID instead" kind="ghost" wide onPress={() => navigation.navigate("Join")} testID="signin-join" />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
