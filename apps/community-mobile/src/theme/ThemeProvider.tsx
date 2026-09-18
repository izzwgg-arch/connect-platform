import AsyncStorage from "@react-native-async-storage/async-storage";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { darkTheme, lightTheme, type ThemeName, type ThemeTokens } from "./tokens";

const STORAGE_KEY = "lc.theme";

type ThemeCtx = {
  theme: ThemeTokens;
  themeName: ThemeName;
  setThemeName: (n: ThemeName) => void;
  toggle: () => void;
  ready: boolean;
};

const Ctx = createContext<ThemeCtx | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Default dark, like the web — deliberately NOT tied to the OS setting
  // (see the task brief: "the in-app choice ... default dark, like the web,
  // NOT the OS setting").
  const [themeName, setThemeNameState] = useState<ThemeName>("dark");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const saved = await AsyncStorage.getItem(STORAGE_KEY);
        if (saved === "light" || saved === "dark") setThemeNameState(saved);
      } catch {
        /* default stands */
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const setThemeName = (n: ThemeName) => {
    setThemeNameState(n);
    AsyncStorage.setItem(STORAGE_KEY, n).catch(() => {});
  };
  const toggle = () => setThemeName(themeName === "dark" ? "light" : "dark");

  const value = useMemo<ThemeCtx>(
    () => ({ theme: themeName === "dark" ? darkTheme : lightTheme, themeName, setThemeName, toggle, ready }),
    [themeName, ready],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useTheme outside ThemeProvider");
  return v;
}
