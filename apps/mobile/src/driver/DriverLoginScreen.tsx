// Loopcom Driver sign-in. Deliberately its own screen (not the phone app's
// LoginScreen): no QR pairing, no welcome branching — a driver types the
// email + password from their setup email and lands straight on today's runs.
import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "../context/AuthContext";
import { useTheme } from "../context/ThemeContext";
import { isDriverDemo } from "./appKind";
import { DEMO_LOGIN_EMAIL, DEMO_LOGIN_PASSWORD, DEMO_TOKEN } from "./demoBackend";

export function DriverLoginScreen() {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { login, setTokenFromQr } = useAuth();
  const [email, setEmail] = useState(isDriverDemo() ? DEMO_LOGIN_EMAIL : "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (!email.trim() || !password) {
      setError("Enter your email and password.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (isDriverDemo()) {
        // The demo validates locally — no server, no real account.
        if (email.trim().toLowerCase() === DEMO_LOGIN_EMAIL && password === DEMO_LOGIN_PASSWORD) {
          await setTokenFromQr(DEMO_TOKEN);
        } else {
          setError(`Demo login: ${DEMO_LOGIN_EMAIL} / ${DEMO_LOGIN_PASSWORD}`);
        }
        return;
      }
      await login(email.trim(), password);
    } catch {
      setError("That email and password didn't match. Check your setup email and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={[styles.fill, { backgroundColor: colors.bg }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={[styles.body, { paddingTop: insets.top + 48, paddingBottom: insets.bottom + 24 }]}>
        <Text style={[styles.brand, { color: colors.text }]}>
          Loopcom <Text style={{ color: colors.primary }}>Driver</Text>
        </Text>
        <Text style={[styles.sub, { color: colors.textSecondary }]}>
          {isDriverDemo() ? `Demo — sign in with ${DEMO_LOGIN_EMAIL} / ${DEMO_LOGIN_PASSWORD}` : "Sign in with the login from your setup email."}
        </Text>

        <View style={{ height: 28 }} />
        <TextInput
          style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
          placeholder="Email"
          placeholderTextColor={colors.textTertiary}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
        />
        <TextInput
          style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
          placeholder="Password"
          placeholderTextColor={colors.textTertiary}
          secureTextEntry
          value={password}
          onChangeText={setPassword}
          onSubmitEditing={submit}
        />
        {error ? <Text style={[styles.error, { color: colors.danger }]}>{error}</Text> : null}

        <TouchableOpacity
          style={[styles.btn, { backgroundColor: colors.primary }, busy && { opacity: 0.6 }]}
          disabled={busy}
          onPress={submit}
        >
          {busy ? <ActivityIndicator color={colors.white} /> : <Text style={[styles.btnText, { color: colors.white }]}>Sign in</Text>}
        </TouchableOpacity>

        <View style={{ flex: 1 }} />
        <Text style={[styles.foot, { color: colors.textTertiary }]}>
          Location is shared only while you're on a run, and your dispatcher can always see when it's off.
        </Text>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  body: { flex: 1, paddingHorizontal: 24 },
  brand: { fontSize: 30, fontWeight: "800", letterSpacing: -0.5 },
  sub: { fontSize: 14, marginTop: 6 },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 13, fontSize: 15, marginBottom: 12 },
  error: { fontSize: 13, marginBottom: 10 },
  btn: { borderRadius: 12, padding: 15, alignItems: "center", marginTop: 4 },
  btnText: { fontWeight: "700", fontSize: 15 },
  foot: { fontSize: 12, textAlign: "center", lineHeight: 18 },
});
