import { useState } from "react";
import { SafeAreaView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError } from "../../api/client";
import { Button, Field } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { AuthStackParamList } from "../../navigation/types";

type Props = NativeStackScreenProps<AuthStackParamList, "ForgotPassword">;

export function ForgotPasswordScreen({ navigation }: Props) {
  const { theme } = useTheme();
  const [identifier, setIdentifier] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ message: string }>("/auth/password/forgot", { body: { identifier }, auth: false });
      setSent(res.message);
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={{ padding: 24, gap: 14 }}>
        <Text style={{ color: theme.text, fontSize: 20, fontWeight: "800", textAlign: "center" }}>Reset your password</Text>
        {sent ? (
          <>
            <Text style={{ color: theme.text, textAlign: "center" }}>{sent}</Text>
            <Text style={{ color: theme.dim, textAlign: "center", fontSize: 13 }}>
              The reset link opens on the Loopcom Community website — follow it from your email or messages app.
            </Text>
            <Button title="Back to sign in" wide onPress={() => navigation.goBack()} testID="forgot-back" />
          </>
        ) : (
          <>
            <Field label="Email or mobile number" value={identifier} onChangeText={setIdentifier} autoCapitalize="none" testID="forgot-identifier" />
            {error ? (
              <Text accessibilityRole="alert" style={{ color: theme.danger }}>
                {error}
              </Text>
            ) : null}
            <Button title="Send reset link" kind="primary" wide onPress={submit} loading={busy} disabled={!identifier} testID="forgot-submit" />
          </>
        )}
      </View>
    </SafeAreaView>
  );
}
