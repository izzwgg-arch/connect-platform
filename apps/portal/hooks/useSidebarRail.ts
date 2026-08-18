"use client";

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "cc-sidebar-rail";

/** Icon-only rail when true; full sidebar when false. Default: full (open). */
export function useSidebarRail() {
  const [railMode, setRailModeState] = useState(false);
  // The stored choice can only be read after mount, so the first paint is
  // always the expanded sidebar. Without this flag someone who works in the
  // collapsed rail watched it animate shut on every single page load — which
  // reads as the app stuttering, not as a preference being applied. `settled`
  // stays false across the frame that applies the stored width, and the
  // sidebar suppresses its transitions until it flips.
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    const v = typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    setRailModeState(v === "1");
    // Two frames: one for React to paint the stored width, one to re-arm the
    // animation. Arming it in the same frame lets the browser animate from the
    // old width after all.
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => setSettled(true));
    });
    return () => {
      cancelAnimationFrame(outer);
      if (inner) cancelAnimationFrame(inner);
    };
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

  return { railMode, setRailMode, toggleRail, settled };
}
