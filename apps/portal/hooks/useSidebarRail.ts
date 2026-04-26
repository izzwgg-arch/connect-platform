"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "cc-sidebar-rail";

/** Icon-only rail when true; full sidebar when false. Default: full (open). */
export function useSidebarRail() {
  const [railMode, setRailModeState] = useState(false);

  useEffect(() => {
    const v = typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    setRailModeState(v === "1");
  }, []);

  const setRailMode = useCallback((rail: boolean) => {
    setRailModeState(rail);
    if (typeof window !== "undefined") {
      if (rail) localStorage.setItem(STORAGE_KEY, "1");
      else localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  const toggleRail = useCallback(() => {
    setRailModeState((prev) => {
      const next = !prev;
      if (typeof window !== "undefined") {
        if (next) localStorage.setItem(STORAGE_KEY, "1");
        else localStorage.removeItem(STORAGE_KEY);
      }
      return next;
    });
  }, []);

  return { railMode, setRailMode, toggleRail };
}
