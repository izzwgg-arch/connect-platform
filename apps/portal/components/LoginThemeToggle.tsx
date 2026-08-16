"use client";

import { useAppContext } from "../hooks/useAppContext";

/**
 * Light/dark switch for the sign-in screen.
 *
 * Presentation only. The theme itself has exactly one authority — `useAppContext`,
 * which writes `<html data-theme>` and persists the choice to `cc-theme` — and this
 * reads and writes that same state. Do not add a second storage key or a local
 * theme state here; a person's pick on this screen must still be their theme after
 * they sign in.
 *
 * The default lives in `useAppContext` (`useState<ThemeMode>("light")`, overridden
 * only when a stored `cc-theme` says otherwise), so a first-time visitor lands on
 * light and a returning one keeps what they chose. This component must never
 * pre-set a theme of its own — that would take the choice away from them.
 *
 * `components/ThemeToggle.tsx` is the plain-button version used inside the app,
 * where there is a toolbar to sit in. This is the same behaviour in a segmented
 * control, because the sign-in screen has no toolbar.
 */
export function LoginThemeToggle() {
  const { theme, setTheme } = useAppContext();

  return (
    <div className="lc-login-theme" role="group" aria-label="Colour theme">
      <button
        type="button"
        aria-pressed={theme === "light"}
        onClick={() => setTheme("light")}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4.2" />
          <path d="M12 2.6v2.2M12 19.2v2.2M4.3 4.3l1.6 1.6M18.1 18.1l1.6 1.6M2.6 12h2.2M19.2 12h2.2M4.3 19.7l1.6-1.6M18.1 5.9l1.6-1.6" />
        </svg>
        Light
      </button>
      <button
        type="button"
        aria-pressed={theme === "dark"}
        onClick={() => setTheme("dark")}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20.5 14.6A8.6 8.6 0 1 1 9.4 3.5a6.9 6.9 0 0 0 11.1 11.1Z" />
        </svg>
        Dark
      </button>
    </div>
  );
}
