"use client";

/**
 * The one api client. Access token in memory + localStorage, refresh token in
 * localStorage, refresh serialised through a single in-flight promise and
 * broadcast to other tabs so they never race each other.
 */
export const API_URL = (process.env.NEXT_PUBLIC_COMMUNITY_API_URL || "http://localhost:3101").replace(/\/$/, "");

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const KEY_ACCESS = "lc.access";
const KEY_REFRESH = "lc.refresh";

function read(k: string): string | null {
  try {
    return window.localStorage.getItem(k);
  } catch {
    return null;
  }
}
function write(k: string, v: string | null) {
  try {
    if (v == null) window.localStorage.removeItem(k);
    else window.localStorage.setItem(k, v);
  } catch {
    /* storage blocked */
  }
}

let accessToken: string | null = null;
export function getAccessToken(): string | null {
  if (accessToken) return accessToken;
  if (typeof window === "undefined") return null;
  accessToken = read(KEY_ACCESS);
  return accessToken;
}
export function getRefreshToken(): string | null {
  return typeof window === "undefined" ? null : read(KEY_REFRESH);
}
export function setTokens(t: { accessToken: string; refreshToken: string } | null) {
  accessToken = t?.accessToken ?? null;
  write(KEY_ACCESS, t?.accessToken ?? null);
  write(KEY_REFRESH, t?.refreshToken ?? null);
  try {
    channel?.postMessage({ type: "tokens", at: Date.now() });
  } catch {
    /* no channel */
  }
}
export function isSignedIn(): boolean {
  return !!getRefreshToken();
}

const channel = typeof window !== "undefined" && "BroadcastChannel" in window ? new BroadcastChannel("lc-auth") : null;
channel?.addEventListener("message", (ev) => {
  if (ev.data?.type === "tokens") accessToken = read(KEY_ACCESS);
  if (ev.data?.type === "signout") {
    accessToken = null;
    window.dispatchEvent(new CustomEvent("lc:signout"));
  }
});

let refreshing: Promise<boolean> | null = null;
export async function refreshTokens(): Promise<boolean> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const rt = getRefreshToken();
    if (!rt) return false;
    try {
      const res = await fetch(`${API_URL}/auth/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken: rt }) });
      if (!res.ok) {
        if (res.status === 401) signOutLocal();
        return false;
      }
      const body = await res.json();
      setTokens({ accessToken: body.accessToken, refreshToken: body.refreshToken });
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => (refreshing = null), 0);
    }
  })();
  return refreshing;
}

export function signOutLocal() {
  setTokens(null);
  try {
    channel?.postMessage({ type: "signout" });
  } catch {
    /* no channel */
  }
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("lc:signout"));
}

export type ApiOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  form?: FormData;
  idempotencyKey?: string;
  signal?: AbortSignal;
  auth?: boolean;
};

export async function api<T = any>(path: string, opts: ApiOptions = {}, _retried = false): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getAccessToken();
  if (token && opts.auth !== false) headers.authorization = `Bearer ${token}`;
  if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(`${API_URL}${path}`, { method: opts.method ?? (body ? "POST" : "GET"), headers, body, signal: opts.signal });
  if (res.status === 401 && !_retried && getRefreshToken() && !path.startsWith("/auth/refresh")) {
    const ok = await refreshTokens();
    if (ok) return api<T>(path, opts, true);
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    if (res.status === 401 && opts.auth !== false) signOutLocal();
    throw new ApiError(res.status, data?.error ?? "error", data?.message ?? `Request failed (${res.status})`, data?.details);
  }
  return data as T;
}

export function newIdempotencyKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Client-side analytics: batched, flushed every 3s or on unload. Never carries message bodies. */
const queue: Array<Record<string, unknown>> = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
export function trackEvent(event: string, props: Record<string, unknown> = {}) {
  if (typeof window === "undefined") return;
  queue.push({ event, client: "web", appVersion: process.env.NEXT_PUBLIC_APP_VERSION || "dev", ...props });
  if (!flushTimer) flushTimer = setTimeout(flushEvents, 3000);
}
export async function flushEvents() {
  flushTimer = null;
  if (!queue.length) return;
  const events = queue.splice(0, 100);
  try {
    await api("/analytics/events", { body: { events } });
  } catch {
    /* analytics never blocks the UI */
  }
}
if (typeof window !== "undefined") {
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flushEvents();
  });
}

export function mediaUrl(assetId: string | null | undefined, variant: "thumb" | "medium" | "original" = "medium"): string | null {
  if (!assetId) return null;
  return `${API_URL}/media/file/${assetId}/${variant}`;
}
