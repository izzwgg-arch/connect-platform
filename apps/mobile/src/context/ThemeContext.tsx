import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { AppState, NativeModules, Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { darkColors, lightColors, AppColors } from '../theme/colors';

type ThemeMode = 'dark' | 'light';

type ThemeContextValue = {
  colors: AppColors;
  mode: ThemeMode;
  isDark: boolean;
  setMode: (mode: ThemeMode) => void;
  /**
   * True once the saved theme has been read from SecureStore. Until then
   * `mode` is only the default — the splash gates on this so a dark-theme
   * user never sees a light first frame (the splash follows the theme now,
   * Izzy 2026-08-23).
   */
  ready: boolean;
};

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

const THEME_KEY = 'cc_theme_mode';

/**
 * Android only: the HOME-SCREEN ICON follows the in-app theme (Izzy
 * 2026-08-22) — light mode shows the Blue 2B icon, dark mode the Navy 2A one.
 * Implemented natively by LauncherIconModule flipping two activity-aliases.
 *
 * ⛔⛔ THE FLIP IS DEFERRED UNTIL THE APP IS IN THE BACKGROUND, AND THAT IS THE
 * WHOLE POINT (Izzy 2026-08-23: "the app closes... is it possible so it
 * doesn't close?"). Flipping the enabled launcher alias makes Android remove
 * the app's TASK — DONT_KILL_APP keeps the process, but the screen closes in
 * the user's face (proven live: the first build flipped immediately on toggle
 * and the app closed every time). So a theme change only RECORDS the wanted
 * icon here; the flip runs when AppState goes 'background' — the moment
 * nobody is looking. If the flip is missed entirely (crash, swipe-away), the
 * boot reconcile below catches the mismatch on the next launch and defers it
 * the same way. Never "simplify" this back to an immediate set().
 *
 * ⛔ Never flip while a call is up, even in the background — the in-call UI
 * rides the same task. `hasActiveSipSession()` guards it; the pending flip
 * just waits for the next background moment.
 *
 * iOS keeps its manual "App icon" row in Settings (expo-alternate-app-icons)
 * because iOS shows a system popup on every programmatic icon change.
 */
let pendingIconVariant: 'blue' | 'navy' | null = null;

function requestLauncherIcon(mode: ThemeMode) {
  if (Platform.OS !== 'android') return;
  pendingIconVariant = mode === 'dark' ? 'navy' : 'blue';
  // Already backgrounded (e.g. a headless-triggered change): apply now.
  if (AppState.currentState !== 'active') applyPendingLauncherIcon();
}

function applyPendingLauncherIcon() {
  if (Platform.OS !== 'android' || !pendingIconVariant) return;
  try {
    // Lazy require: keep the theme provider free of an import-time dependency
    // on the SIP stack (which pulls in the whole engine).
    const { hasActiveSipSession } = require('../sip/sipClientSingleton');
    if (hasActiveSipSession()) return; // keep pending; retry next background
  } catch {
    // if the guard itself is unavailable, still prefer applying
  }
  const variant = pendingIconVariant;
  pendingIconVariant = null;
  try {
    NativeModules.LauncherIcon?.set(variant)?.catch?.(() => {
      // Failed flip: re-arm so the next background moment retries.
      pendingIconVariant = variant;
    });
  } catch {
    pendingIconVariant = variant;
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // ⛔ Default is LIGHT (Izzy, 2026-08-21). A saved cc_theme_mode still wins,
  // so anyone who has already chosen dark keeps dark on next launch.
  const [mode, setModeState] = useState<ThemeMode>('light');
  const [ready, setReady] = useState(false);

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
      setReady(true);
      // Boot reconcile: a user who chose dark BEFORE the icon-follows-theme
      // update should get the navy icon — but only queue it when it actually
      // differs (an unconditional request would schedule a pointless flip and
      // launcher redraw on every single background). Applied at the next
      // background moment, never while the screen is up.
      if (Platform.OS === 'android') {
        try {
          const current = await NativeModules.LauncherIcon?.get();
          const wanted = resolved === 'dark' ? 'navy' : 'blue';
          if (current && current !== wanted) requestLauncherIcon(resolved);
        } catch {
          // best-effort
        }
      }
    })();

    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') applyPendingLauncherIcon();
    });
    return () => sub.remove();
  }, []);

  const isDark = useMemo(() => mode === 'dark', [mode]);

  const setMode = async (newMode: ThemeMode) => {
    setModeState(newMode);
    requestLauncherIcon(newMode);
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
      ready,
    }),
    [isDark, mode, ready]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider');
  return ctx;
}
