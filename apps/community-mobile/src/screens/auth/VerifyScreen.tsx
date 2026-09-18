import { useState } from "react";
import { SafeAreaView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthProvider";
import { Button, Field, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { AuthStackParamList } from "../../navigation/types";

type Props = NativeStackScreenProps<AuthStackParamList, "Verify">;

export function VerifyScreen({ route }: Props) {
  const { purpose, target } = route.params;
  const { theme } = useTheme();
  const toast = useToast();
  const { reload } = useAuth();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await api("/auth/verify/confirm", { body: { purpose, target, code } });
      toast(purpose === "email" ? "Email verified." : "Phone verified.");
      await reload();
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    try {
      await api("/auth/verify/send", { body: { purpose } });
      toast("Code sent again.");
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={{ padding: 24, gap: 14 }}>
        <Text style={{ color: theme.text, fontSize: 20, fontWeight: "800", textAlign: "center" }}>Verify your {purpose}</Text>
        <Text style={{ color: theme.dim, textAlign: "center" }}>We sent a 6-digit code to {target}.</Text>
        <Field label="Code" value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={6} testID="verify-code" />
        {error ? (
          <Text accessibilityRole="alert" style={{ color: theme.danger }}>
            {error}
          </Text>
        ) : null}
        <Button title="Verify" kind="primary" wide onPress={confirm} loading={busy} disabled={code.length < 4} testID="verify-submit" />
        <Button title="Resend code" kind="ghost" wide onPress={resend} testID="verify-resend" />
      </View>
    </SafeAreaView>
  );
}
