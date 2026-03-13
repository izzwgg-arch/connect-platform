import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import * as SecureStore from "expo-secure-store";
import { login as apiLogin } from "../api/client";

const TOKEN_KEY = "cc_mobile_token";

type AuthState = {
  token: string | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Store a session token obtained via QR exchange (no password needed). */
  setTokenFromQr: (sessionToken: string) => Promise<void>;
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
        setToken(null);
        await SecureStore.deleteItemAsync(TOKEN_KEY);
        await SecureStore.deleteItemAsync("cc_mobile_provision");
      },
      setTokenFromQr: async (sessionToken: string) => {
        setToken(sessionToken);
        await SecureStore.setItemAsync(TOKEN_KEY, sessionToken);
      }
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
