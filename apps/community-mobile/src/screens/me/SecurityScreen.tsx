import { useState } from "react";
import { Linking, SafeAreaView, ScrollView, Text, View } from "react-native";
import { api, ApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthProvider";
import { Button, Field, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";

export function SecurityScreen() {
  const { theme } = useTheme();
  const toast = useToast();
  const { me, reload } = useAuth();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busyPw, setBusyPw] = useState(false);
  const [otpauth, setOtpauth] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState("");
  const [busyMfa, setBusyMfa] = useState(false);

  async function changePassword() {
    setBusyPw(true);
    try {
      await api("/auth/password/change", { method: "POST", body: { currentPassword: currentPassword || undefined, newPassword } });
      toast("Password changed.");
      setCurrentPassword("");
      setNewPassword("");
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setBusyPw(false);
    }
  }

  async function startMfaSetup() {
    try {
      const res = await api<{ secret: string; otpauthUrl: string }>("/auth/mfa/totp/setup", { method: "POST" });
      setOtpauth(res.otpauthUrl);
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  async function enableMfa() {
    setBusyMfa(true);
    try {
      await api("/auth/mfa/totp/enable", { method: "POST", body: { code: totpCode } });
      await reload();
      setOtpauth(null);
      setTotpCode("");
      toast("Two-step verification is on.");
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setBusyMfa(false);
    }
  }

  async function disableMfa() {
    setBusyMfa(true);
    try {
      await api("/auth/mfa/totp/disable", { method: "POST", body: { code: totpCode } });
      await reload();
      setTotpCode("");
      toast("Two-step verification is off.");
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setBusyMfa(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 20 }}>
        <View style={{ gap: 10 }}>
          <Text style={{ color: theme.text, fontWeight: "800", fontSize: 16 }}>Change password</Text>
          <Field label="Current password" value={currentPassword} onChangeText={setCurrentPassword} secureTextEntry />
          <Field label="New password" value={newPassword} onChangeText={setNewPassword} secureTextEntry />
          <Button title="Change password" kind="primary" onPress={changePassword} loading={busyPw} disabled={!newPassword} testID="security-change-password" />
        </View>

        <View style={{ gap: 10 }}>
          <Text style={{ color: theme.text, fontWeight: "800", fontSize: 16 }}>Two-step verification</Text>
          {me?.person.mfaEnabled ? (
            <>
              <Text style={{ color: theme.dim }}>Two-step verification is on.</Text>
              <Field label="Authenticator code (to turn off)" value={totpCode} onChangeText={setTotpCode} keyboardType="number-pad" />
              <Button title="Turn off" kind="danger" onPress={disableMfa} loading={busyMfa} disabled={totpCode.length < 6} testID="security-mfa-disable" />
            </>
          ) : otpauth ? (
            <>
              <Text style={{ color: theme.dim }}>Add this account to your authenticator app, then enter the 6-digit code.</Text>
              <Text selectable style={{ color: theme.accent, fontSize: 12 }} onPress={() => Linking.openURL(otpauth)}>
                {otpauth}
              </Text>
              <Field label="Authenticator code" value={totpCode} onChangeText={setTotpCode} keyboardType="number-pad" testID="security-mfa-code" />
              <Button title="Turn on" kind="primary" onPress={enableMfa} loading={busyMfa} disabled={totpCode.length < 6} testID="security-mfa-enable" />
            </>
          ) : (
            <Button title="Set up two-step verification" onPress={startMfaSetup} testID="security-mfa-setup" />
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
