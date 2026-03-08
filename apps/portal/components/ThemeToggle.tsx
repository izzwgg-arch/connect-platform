"use client";

import { useAppContext } from "../hooks/useAppContext";

export function ThemeToggle() {
  const { theme, setTheme } = useAppContext();
  return (
    <button className="btn ghost" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
      {theme === "dark" ? "Light mode" : "Dark mode"}
    </button>
  );
}
