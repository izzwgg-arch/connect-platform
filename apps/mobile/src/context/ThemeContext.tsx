import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import * as SecureStore from 'expo-secure-store';
import { darkColors, lightColors, AppColors } from '../theme/colors';

type ThemeMode = 'dark' | 'light';

type ThemeContextValue = {
  colors: AppColors;
  mode: ThemeMode;
  isDark: boolean;
  setMode: (mode: ThemeMode) => void;
};

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

const THEME_KEY = 'cc_theme_mode';

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>('dark');

  useEffect(() => {
    (async () => {
      try {
        const saved = await SecureStore.getItemAsync(THEME_KEY);
        // Legacy 'system' preference (removed — dark/light only now) falls
        // back to the default 'dark' mode instead of crashing.
        if (saved === 'dark' || saved === 'light') {
          setModeState(saved as ThemeMode);
        }
      } catch {
        // use default
      }
    })();
  }, []);

  const isDark = useMemo(() => mode === 'dark', [mode]);

  const setMode = async (newMode: ThemeMode) => {
    setModeState(newMode);
    try {
      await SecureStore.setItemAsync(THEME_KEY, newMode);
    } catch {
      // ignore
    }
  };

  const value = useMemo<ThemeContextValue>(
    () => ({
      colors: isDark ? darkColors : lightColors,
      mode,
      isDark,
      setMode,
    }),
    [isDark, mode]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider');
  return ctx;
}
