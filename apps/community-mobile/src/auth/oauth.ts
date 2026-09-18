import Constants from "expo-constants";
import * as AppleAuthentication from "expo-apple-authentication";
import * as Google from "expo-auth-session/providers/google";
import { Platform } from "react-native";
import { api } from "../api/client";
import { applySession } from "./AuthProvider";

export function googleClientIdsConfigured(): boolean {
  const extra = Constants.expoConfig?.extra ?? {};
  return Platform.OS === "ios" ? !!extra.googleClientIdIos : Platform.OS === "android" ? !!extra.googleClientIdAndroid : false;
}

/**
 * Hook-shaped: components call this and get back { request, promptAsync } —
 * only meaningful when googleClientIdsConfigured() is true, so screens should
 * not render the button otherwise (per the brief: "otherwise the buttons are
 * not rendered").
 */
export function useGoogleSignIn() {
  const extra = Constants.expoConfig?.extra ?? {};
  const [request, response, promptAsync] = Google.useAuthRequest({
    iosClientId: extra.googleClientIdIos ?? undefined,
    androidClientId: extra.googleClientIdAndroid ?? undefined,
  });
  return { request, response, promptAsync };
}

export async function completeGoogleSignIn(idToken: string): Promise<{ created: boolean }> {
  const body = await api<{ accessToken: string; refreshToken: string; created: boolean }>("/auth/oauth/google", {
    body: { idToken, client: "mobile" },
    auth: false,
  });
  await applySession(body);
  return { created: body.created };
}

export async function appleSignInAvailable(): Promise<boolean> {
  if (Platform.OS !== "ios") return false;
  try {
    return await AppleAuthentication.isAvailableAsync();
  } catch {
    return false;
  }
}

export async function signInWithApple(): Promise<{ created: boolean } | null> {
  try {
    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [AppleAuthentication.AppleAuthenticationScope.FULL_NAME, AppleAuthentication.AppleAuthenticationScope.EMAIL],
    });
    if (!credential.identityToken) return null;
    const body = await api<{ accessToken: string; refreshToken: string; created: boolean }>("/auth/oauth/apple", {
      body: {
        idToken: credential.identityToken,
        firstName: credential.fullName?.givenName ?? undefined,
        lastName: credential.fullName?.familyName ?? undefined,
        client: "mobile",
      },
      auth: false,
    });
    await applySession(body);
    return { created: body.created };
  } catch (err: any) {
    if (err?.code === "ERR_REQUEST_CANCELED") return null;
    throw err;
  }
}
