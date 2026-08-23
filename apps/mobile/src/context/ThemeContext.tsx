import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { NativeModules, Platform } from 'react-native';
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

/**
 * Android only: the HOME-SCREEN ICON follows the in-app theme (Izzy
 * 2026-08-22) — light mode shows the Blue 2B icon, dark mode the Navy 2A one.
 * Implemented natively by LauncherIconModule flipping two activity-aliases;
 * best-effort on purpose: an icon that failed to swap must never break the
 * theme change itself. iOS keeps its manual "App icon" row in Settings
 * (expo-alternate-app-icons) because iOS shows a system popup on every
 * programmatic icon change — auto-switching there would nag on each toggle.
 */
function syncLauncherIcon(mode: ThemeMode) {
  if (Platform.OS !== 'android') return;
  try {
    NativeModules.LauncherIcon?.set(mode === 'dark' ? 'navy' : 'blue')?.catch?.(() => undefined);
  } catch {
    // best-effort
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // ⛔ Default is LIGHT (Izzy, 2026-08-21). A saved cc_theme_mode still wins,
  // so anyone who has already chosen dark keeps dark on next launch.
  const [mode, setModeState] = useState<ThemeMode>('light');

  useEffect(() => {
    (async () => {
      let resolved: ThemeMode = 'light';
      try {
        const saved = await SecureStore.getItemAsync(THEME_KEY);
        // Legacy 'system' preference (removed — dark/light only now) falls
        // back to the default mode instead of crashing.
        if (saved === 'dark' || saved === 'light') {
          resolved = saved as ThemeMode;
          setModeState(resolved);
        }
      } catch {
        // use default
      }
      // Boot reconcile: a user who chose dark BEFORE the icon-follows-theme
      // update should get the navy icon on first launch after updating, not
      // only after their next toggle. No-op when it already matches (the
      // native side skips the write, so launchers don't redraw every boot).
      syncLauncherIcon(resolved);
    })();
  }, []);

  const isDark = useMemo(() => mode === 'dark', [mode]);

  const setMode = async (newMode: ThemeMode) => {
    setModeState(newMode);
    syncLauncherIcon(newMode);
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
