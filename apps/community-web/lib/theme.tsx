"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

/**
 * The app's own light/dark switch, stamped on <html data-theme>. Dark is the
 * default (bare :root); the OS setting is deliberately ignored, like the
 * Loopcom portal. A Loopcom customer's preference is copied over on SSO.
 */
export type Theme = "dark" | "light";
const KEY = "lc.theme";

type ThemeCtx = { theme: Theme; setTheme: (t: Theme) => void; toggle: () => void };
const Ctx = createContext<ThemeCtx>({ theme: "dark", setTheme: () => {}, toggle: () => {} });

export function readStoredTheme(): Theme {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("dark");
  useEffect(() => {
    const t = readStoredTheme();
    setThemeState(t);
    document.documentElement.dataset.theme = t;
  }, []);
  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    document.documentElement.dataset.theme = t;
    try {
      window.localStorage.setItem(KEY, t);
    } catch {
      /* storage blocked */
    }
  }, []);
  const toggle = useCallback(() => setTheme(theme === "dark" ? "light" : "dark"), [theme, setTheme]);
  const value = useMemo(() => ({ theme, setTheme, toggle }), [theme, setTheme, toggle]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useTheme = () => useContext(Ctx);

/** Inline script for <head>: stamps the stored theme before first paint (no flash). */
export const THEME_BOOT_SCRIPT = `(function(){try{var t=localStorage.getItem("${KEY}");document.documentElement.dataset.theme=t==="light"?"light":"dark";}catch(e){document.documentElement.dataset.theme="dark";}})();`;
