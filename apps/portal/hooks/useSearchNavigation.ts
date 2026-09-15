"use client";
import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

export const SEARCH_NAVIGATION_EVENT = "loopcom:search-navigation";
/** Apply search deep links on mount, browser Back, and same-page search selections. */
export function useSearchNavigation(apply: (url: URL) => void) {
  const callback = useRef(apply);
  callback.current = apply;
  const pathname = usePathname();
  useEffect(() => {
    const sync = (event?: Event) => {
      const href = event instanceof CustomEvent ? event.detail?.href : window.location.href;
      const url = new URL(typeof href === "string" ? href : window.location.href, window.location.origin);
      if (url.origin === window.location.origin && url.pathname === pathname) callback.current(url);
    };
    sync();
    window.addEventListener("popstate", sync);
    window.addEventListener(SEARCH_NAVIGATION_EVENT, sync);
    return () => { window.removeEventListener("popstate", sync); window.removeEventListener(SEARCH_NAVIGATION_EVENT, sync); };
  }, [pathname]);
}
