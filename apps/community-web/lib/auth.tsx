"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { api, API_URL, getAccessToken, isSignedIn, refreshTokens, setTokens, signOutLocal, trackEvent } from "./api";

export type Me = {
  person: {
    id: string;
    username: string;
    email: string | null;
    phone: string | null;
    emailVerified: boolean;
    phoneVerified: boolean;
    verified: boolean;
    status: string;
    loopcomLinked: boolean;
    mfaEnabled: boolean;
    onboardingDone: boolean;
    createdAt: string;
  };
  profile: {
    firstName: string;
    lastName: string;
    headline: string | null;
    about: string | null;
    avatarAssetId: string | null;
    coverAssetId: string | null;
    location: string | null;
    serviceArea: string[];
    languages: string[];
    industry: string | null;
    objectives: string[];
    skills: string[];
  } | null;
  memberships: Array<{ id: string; role: string; permissions: string[]; affiliation: string; isPrimary: boolean; organization: { id: string; slug: string; displayName: string; logoAssetId: string | null; loopcomTenantId: string | null } }>;
  staffRole: string | null;
  counts: { notifications: number; messages: number; invitations: number };
};

type AuthCtx = {
  me: Me | null;
  loading: boolean;
  reload: () => Promise<Me | null>;
  signOut: () => Promise<void>;
  setCounts: (patch: Partial<Me["counts"]>) => void;
  /** Live server events (SSE). Subscribe by type; returns an unsubscribe. */
  on: (type: string, cb: (data: any) => void) => () => void;
};

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const listeners = useRef(new Map<string, Set<(d: any) => void>>());

  const reload = useCallback(async () => {
    if (!isSignedIn()) {
      setMe(null);
      setLoading(false);
      return null;
    }
    try {
      const m = await api<Me>("/auth/me");
      setMe(m);
      return m;
    } catch {
      setMe(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    const onSignout = () => setMe(null);
    window.addEventListener("lc:signout", onSignout);
    return () => window.removeEventListener("lc:signout", onSignout);
  }, [reload]);

  // Realtime stream: one EventSource while signed in; reconnects with a fresh access token.
  useEffect(() => {
    if (!me) return;
    let es: EventSource | null = null;
    let stopped = false;
    let backoff = 1000;
    const connect = async () => {
      if (stopped) return;
      let token = getAccessToken();
      if (!token) {
        await refreshTokens();
        token = getAccessToken();
      }
      if (!token) return;
      es = new EventSource(`${API_URL}/realtime/stream?access_token=${encodeURIComponent(token)}`);
      const dispatch = (type: string) => (ev: MessageEvent) => {
        let data: any = null;
        try {
          data = JSON.parse(ev.data);
        } catch {
          data = ev.data;
        }
        listeners.current.get(type)?.forEach((cb) => cb(data));
        listeners.current.get("*")?.forEach((cb) => cb({ type, data }));
        if (type === "notification") setMe((m) => (m ? { ...m, counts: { ...m.counts, notifications: m.counts.notifications + 1 } } : m));
        if (type === "message" && data?.unreadDelta) setMe((m) => (m ? { ...m, counts: { ...m.counts, messages: Math.max(0, m.counts.messages + data.unreadDelta) } } : m));
      };
      for (const t of ["notification", "message", "thread", "typing", "presence", "connection", "rfq", "quote", "hello"]) es.addEventListener(t, dispatch(t));
      es.onopen = () => (backoff = 1000);
      es.onerror = async () => {
        es?.close();
        es = null;
        if (stopped) return;
        await refreshTokens();
        setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 30_000);
      };
    };
    void connect();
    return () => {
      stopped = true;
      es?.close();
    };
  }, [me?.person.id]);

  const signOut = useCallback(async () => {
    try {
      await api("/auth/logout", { method: "POST" });
    } catch {
      /* already gone */
    }
    trackEvent("logout");
    signOutLocal();
    setMe(null);
  }, []);

  const setCounts = useCallback((patch: Partial<Me["counts"]>) => setMe((m) => (m ? { ...m, counts: { ...m.counts, ...patch } } : m)), []);

  const on = useCallback((type: string, cb: (d: any) => void) => {
    if (!listeners.current.has(type)) listeners.current.set(type, new Set());
    listeners.current.get(type)!.add(cb);
    return () => listeners.current.get(type)?.delete(cb);
  }, []);

  const value = useMemo(() => ({ me, loading, reload, signOut, setCounts, on }), [me, loading, reload, signOut, setCounts, on]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}

/** Wraps a page that needs a signed-in person; redirects to /login?next= otherwise. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (!loading && !me) {
      const next = typeof window !== "undefined" ? window.location.pathname + window.location.search : "/";
      router.replace(`/login?next=${encodeURIComponent(next)}`);
    }
  }, [loading, me, router]);
  if (loading) return <div className="content"><div className="skel" style={{ height: 120 }} /></div>;
  if (!me) return null;
  return <>{children}</>;
}

export function applySession(body: { accessToken: string; refreshToken: string }) {
  setTokens({ accessToken: body.accessToken, refreshToken: body.refreshToken });
}
