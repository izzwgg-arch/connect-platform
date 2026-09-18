import Constants from "expo-constants";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { api } from "../api/client";
import { applySession } from "./AuthProvider";

const PORTAL_URL = ((Constants.expoConfig?.extra?.loopcomPortalUrl as string | undefined) || "https://app.loopcom.net").replace(/\/$/, "");

/**
 * Opens the Loopcom portal's login page in an in-app auth session. The
 * portal redirects back to `loopcomcommunity://sso?token=<portal JWT>` on
 * success; we verify that token server-side via POST /auth/loopcom (never
 * trusted client-side) exactly like the web's /sso/loopcom page.
 */
export async function signInWithLoopcom(): Promise<{ created: boolean } | null> {
  const redirectUrl = Linking.createURL("sso");
  const authUrl = `${PORTAL_URL}/login?community=1&redirect=${encodeURIComponent(redirectUrl)}`;
  const result = await WebBrowser.openAuthSessionAsync(authUrl, redirectUrl);
  if (result.type !== "success" || !result.url) return null;
  const { queryParams } = Linking.parse(result.url);
  const token = queryParams?.token;
  if (!token || typeof token !== "string") return null;
  const body = await api<{ accessToken: string; refreshToken: string; created: boolean }>("/auth/loopcom", {
    body: { token, client: "mobile" },
    auth: false,
  });
  await applySession(body);
  return { created: body.created };
}
