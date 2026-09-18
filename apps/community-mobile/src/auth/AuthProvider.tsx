import AsyncStorage from "@react-native-async-storage/async-storage";
import * as LocalAuthentication from "expo-local-authentication";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AppState } from "react-native";
import {
  api,
  hydrateTokens,
  isSignedIn as tokenIsSignedIn,
  onSignOut,
  setTokens,
  trackEvent,
} from "../api/client";
import { realtime, type RealtimeCounts } from "../api/realtime";
import type { Me } from "../api/types";
import { needsBiometricGate, withinUnlockGrace } from "./policy";

const BIOMETRIC_SETTING_KEY = "lc.biometricLock";

type AuthCtx = {
  me: Me | null;
  loading: boolean;
  reload: () => Promise<Me | null>;
  signOut: () => Promise<void>;
  setCounts: (patch: Partial<Me["counts"]>) => void;
  biometricEnabled: boolean;
  setBiometricEnabled: (v: boolean) => void;
  locked: boolean;
  unlock: () => Promise<boolean>;
};

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [biometricEnabled, setBiometricEnabledState] = useState(false);
  const [locked, setLocked] = useState(false);
  const lastUnlockAt = useRef<number | null>(null);

  const reload = useCallback(async () => {
    if (!tokenIsSignedIn()) {
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
    (async () => {
      await hydrateTokens();
      const saved = await AsyncStorage.getItem(BIOMETRIC_SETTING_KEY);
      setBiometricEnabledState(saved === "1");
      await reload();
    })();
    const off = onSignOut(() => setMe(null));
    return off;
  }, [reload]);

  // Lock gate: evaluate whenever the app returns to the foreground.
  useEffect(() => {
    const evaluate = async () => {
      if (!me) return;
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const isEnrolled = await LocalAuthentication.isEnrolledAsync();
      const gate = needsBiometricGate({ settingEnabled: biometricEnabled, hasHardware, isEnrolled, isSignedIn: !!me });
      if (gate && !withinUnlockGrace(lastUnlockAt.current, Date.now())) setLocked(true);
    };
    void evaluate();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") void evaluate();
    });
    return () => sub.remove();
  }, [me, biometricEnabled]);

  // Realtime polling for badge counts while signed in.
  useEffect(() => {
    if (!me) return;
    realtime.start();
    const off = realtime.onCounts((c: RealtimeCounts) => {
      setMe((m) => (m ? { ...m, counts: { ...m.counts, notifications: c.notifications, messages: c.messages } } : m));
    });
    return () => {
      off();
      realtime.stop();
    };
  }, [me?.person.id]);

  const signOut = useCallback(async () => {
    try {
      await api("/auth/logout", { method: "POST" });
    } catch {
      /* already gone */
    }
    trackEvent("logout");
    await setTokens(null);
    setMe(null);
  }, []);

  const setCounts = useCallback(
    (patch: Partial<Me["counts"]>) => setMe((m) => (m ? { ...m, counts: { ...m.counts, ...patch } } : m)),
    [],
  );

  const setBiometricEnabled = useCallback((v: boolean) => {
    setBiometricEnabledState(v);
    AsyncStorage.setItem(BIOMETRIC_SETTING_KEY, v ? "1" : "0").catch(() => {});
  }, []);

  const unlock = useCallback(async (): Promise<boolean> => {
    try {
      const res = await LocalAuthentication.authenticateAsync({
        promptMessage: "Unlock Loopcom Community",
        fallbackLabel: "Use passcode",
      });
      if (res.success) {
        lastUnlockAt.current = Date.now();
        setLocked(false);
        return true;
      }
    } catch {
      /* fall through */
    }
    return false;
  }, []);

  const value = useMemo<AuthCtx>(
    () => ({ me, loading, reload, signOut, setCounts, biometricEnabled, setBiometricEnabled, locked, unlock }),
    [me, loading, reload, signOut, setCounts, biometricEnabled, setBiometricEnabled, locked, unlock],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}

export async function applySession(body: { accessToken: string; refreshToken: string }) {
  await setTokens({ accessToken: body.accessToken, refreshToken: body.refreshToken });
}
