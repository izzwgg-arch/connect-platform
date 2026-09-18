import { useState } from "react";
import { Image, SafeAreaView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Button, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import { signInWithLoopcom } from "../../auth/loopcomSso";
import { appleSignInAvailable, signInWithApple } from "../../auth/oauth";
import { useAuth } from "../../auth/AuthProvider";
import type { AuthStackParamList } from "../../navigation/types";
import { useEffect } from "react";

type Props = NativeStackScreenProps<AuthStackParamList, "Welcome">;

export function WelcomeScreen({ navigation }: Props) {
  const { theme } = useTheme();
  const toast = useToast();
  const { reload } = useAuth();
  const [busy, setBusy] = useState(false);
  const [appleAvailable, setAppleAvailable] = useState(false);

  useEffect(() => {
    appleSignInAvailable().then(setAppleAvailable);
  }, []);

  async function withLoopcom() {
    setBusy(true);
    try {
      const result = await signInWithLoopcom();
      if (!result) {
        toast("Sign-in with Loopcom was cancelled.", { kind: "err" });
        return;
      }
      await reload();
    } catch (err: any) {
      toast(err?.message ?? "Couldn't sign in with Loopcom.", { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  async function withApple() {
    setBusy(true);
    try {
      const result = await signInWithApple();
      if (result) await reload();
    } catch (err: any) {
      toast(err?.message ?? "Sign in with Apple didn't complete.", { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={{ flex: 1, justifyContent: "center", padding: 24, gap: 16 }}>
        <Image
          source={require("../../../assets/wordmark.png")}
          resizeMode="contain"
          accessibilityLabel="Loopcom Community"
          style={{ width: "70%", height: 60, alignSelf: "center", marginBottom: 24 }}
        />
        <Text style={{ color: theme.text, fontSize: 22, fontWeight: "800", textAlign: "center" }}>
          The professional network for Loopcom customers
        </Text>
        <Text style={{ color: theme.dim, textAlign: "center", marginBottom: 12 }}>
          Connect, post, hire and get quotes from other Loopcom businesses.
        </Text>

        <Button title="Continue with Loopcom" kind="primary" wide icon="link" onPress={withLoopcom} loading={busy} testID="welcome-loopcom" />
        {appleAvailable ? (
          <Button title="Continue with Apple" wide onPress={withApple} loading={busy} testID="welcome-apple" />
        ) : null}
        <Button title="Sign in with email" wide onPress={() => navigation.navigate("SignIn")} testID="welcome-signin" />
        <Button title="Create a free Loopcom ID" kind="ghost" wide onPress={() => navigation.navigate("Join")} testID="welcome-join" />
      </View>
    </SafeAreaView>
  );
}
