import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { ApiError, createApiClient, serializeRefresh, type ApiRequestOptions } from "./apiCore";

export { ApiError };

function defaultApiUrl(): string {
  if (Platform.OS === "android") return "http://10.0.2.2:3101";
  return "http://localhost:3101";
}

export const API_URL = (
  (Constants.expoConfig?.extra?.apiUrl as string | undefined) || defaultApiUrl()
).replace(/\/$/, "");

// Storage rule (tested in src/auth/policy.test.ts): the ACCESS token never
// touches disk — it lives only in this module's memory and is re-derived via
// POST /auth/refresh on cold start. Only the REFRESH token is persisted, and
// only in expo-secure-store (Keychain/Keystore-backed), never AsyncStorage.
const KEY_REFRESH = "lc.refresh";

let accessToken: string | null = null;
let refreshToken: string | null = null;
let hydrated = false;

export function getAccessToken(): string | null {
  return accessToken;
}
export function getRefreshToken(): string | null {
  return refreshToken;
}
export function isSignedIn(): boolean {
  return !!refreshToken;
}

type SignoutListener = () => void;
const signoutListeners = new Set<SignoutListener>();
export function onSignOut(cb: SignoutListener): () => void {
  signoutListeners.add(cb);
  return () => signoutListeners.delete(cb);
}

export async function setTokens(t: { accessToken: string; refreshToken: string } | null): Promise<void> {
  accessToken = t?.accessToken ?? null;
  refreshToken = t?.refreshToken ?? null;
  try {
    if (t) await SecureStore.setItemAsync(KEY_REFRESH, t.refreshToken);
    else await SecureStore.deleteItemAsync(KEY_REFRESH);
  } catch {
    /* secure store unavailable (e.g. simulator edge case) — tokens still work in-memory for this session */
  }
}

export async function signOutLocal(): Promise<void> {
  await setTokens(null);
  for (const cb of signoutListeners) cb();
}

async function doRefreshOnce(): Promise<boolean> {
  const rt = getRefreshToken();
  if (!rt) return false;
  try {
    const res = await fetch(`${API_URL}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: rt }),
    });
    if (!res.ok) {
      if (res.status === 401) await signOutLocal();
      return false;
    }
    const body = await res.json();
    await setTokens({ accessToken: body.accessToken, refreshToken: body.refreshToken });
    return true;
  } catch {
    return false;
  }
}
export const refreshTokens = serializeRefresh(doRefreshOnce);

/** Must be awaited once at app boot before any signed-in call is made. */
export async function hydrateTokens(): Promise<{ accessToken: string | null; refreshToken: string | null }> {
  if (hydrated) return { accessToken, refreshToken };
  try {
    refreshToken = await SecureStore.getItemAsync(KEY_REFRESH);
  } catch {
    refreshToken = null;
  }
  hydrated = true;
  if (refreshToken) await refreshTokens();
  return { accessToken, refreshToken };
}

const client = createApiClient({
  baseUrl: API_URL,
  fetchImpl: (...args) => fetch(...args),
  getAccessToken,
  getRefreshToken,
  doRefresh: refreshTokens,
  onUnauthorized: signOutLocal,
});

export async function api<T = any>(path: string, opts: ApiRequestOptions = {}): Promise<T> {
  return client.request<T>(path, opts);
}

export function newIdempotencyKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function mediaUrl(assetId: string | null | undefined, variant: "thumb" | "medium" | "original" = "medium"): string | null {
  if (!assetId) return null;
  return `${API_URL}/media/file/${assetId}/${variant}`;
}

/** Multipart upload helper for POST /media. */
export async function uploadMedia(uri: string, name: string, mimeType: string, extra?: Record<string, string>): Promise<any> {
  const form = new FormData();
  form.append("file", { uri, name, type: mimeType } as any);
  if (extra) for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return api("/media", { method: "POST", form: form as any, idempotencyKey: newIdempotencyKey() });
}

// ── analytics: batched, flushed every 3s (mirrors the web client) ─────────
const queue: Array<Record<string, unknown>> = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const APP_VERSION = (Constants.expoConfig?.version as string | undefined) || "dev";
const CLIENT = Platform.OS === "ios" ? "ios" : Platform.OS === "android" ? "android" : "mobile";

export function trackEvent(event: string, props: Record<string, unknown> = {}) {
  if (!isSignedIn()) return;
  queue.push({ event, client: CLIENT, appVersion: APP_VERSION, ...props });
  if (!flushTimer) flushTimer = setTimeout(flushEvents, 3000);
}

export async function flushEvents(): Promise<void> {
  flushTimer = null;
  if (!queue.length) return;
  const events = queue.splice(0, 100);
  try {
    await api("/analytics/events", { body: { events } });
  } catch {
    /* analytics never blocks the UI */
  }
}
