import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import * as SecureStore from "expo-secure-store";
import { login as apiLogin, unregisterMobileDevice } from "../api/client";

const TOKEN_KEY = "cc_mobile_token";
const EXPO_PUSH_TOKEN_KEY = "cc_mobile_expo_push_token";

type AuthState = {
  token: string | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Store a token that was obtained via QR-code exchange (no email/password required). */
  setTokenFromQr: (token: string) => Promise<void>;
};

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const saved = await SecureStore.getItemAsync(TOKEN_KEY);
      if (saved) setToken(saved);
      setIsLoading(false);
    })();
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      token,
      isLoading,
      login: async (email, password) => {
        const out = await apiLogin(email, password);
        setToken(out.token);
        await SecureStore.setItemAsync(TOKEN_KEY, out.token);
      },
      logout: async () => {
        // Deactivate THIS device's push registration server-side before the
        // token is gone, so the user who is logging out stops receiving any
        // notifications on this phone (prevents leakage to the next person who
        // signs in here). Best-effort — never block logout on it.
        try {
          if (token) {
            const pushTok = await SecureStore.getItemAsync(EXPO_PUSH_TOKEN_KEY).catch(() => null);
            await unregisterMobileDevice(token, pushTok || undefined);
          }
        } catch {
          // ignore — logout must always proceed
        }
        setToken(null);
        await SecureStore.deleteItemAsync(TOKEN_KEY);
        await SecureStore.deleteItemAsync("cc_mobile_provision");
      },
      setTokenFromQr: async (qrToken: string) => {
        setToken(qrToken);
        await SecureStore.setItemAsync(TOKEN_KEY, qrToken);
      },
    }),
    [token, isLoading]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
