"use client";

import { useCallback, useEffect, useState } from "react";
import type { NavItem } from "../navigation/navConfig";

const STORAGE_KEY = "cc-nav-sections-v1";

type SectionMap = Partial<Record<NavItem["section"], boolean>>;

function readMap(): SectionMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as SectionMap;
  } catch {
    return {};
  }
}

/** `false` in storage = user collapsed that section; missing/`true` = expanded (default). */
export function useNavSectionExpansion() {
  const [map, setMap] = useState<SectionMap>({});

  useEffect(() => {
    setMap(readMap());
  }, []);

  const isExpanded = useCallback(
    (section: NavItem["section"]) => map[section] !== false,
    [map]
  );

  const toggle = useCallback((section: NavItem["section"]) => {
    setMap((prev) => {
      const next: SectionMap = { ...prev };
      const currentlyExpanded = next[section] !== false;
      if (currentlyExpanded) next[section] = false;
      else delete next[section];
      if (typeof window !== "undefined") {
        const keys = Object.keys(next).length;
        if (keys === 0) localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      }
      return next;
    });
  }, []);

  return { isExpanded, toggle };
}
