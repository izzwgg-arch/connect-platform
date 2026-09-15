"use client";

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import "./phone-setup.css";

/**
 * Public desk-phone scan shell — the page a CUSTOMER opens from the link we send.
 *
 * ⛔ No sidebar, no sign-in, no tenant switcher: the token in the URL is the whole
 * credential and the api validates it per request. This layout only re-enables
 * scrolling (the platform CSS pins html/body) and applies a saved theme choice —
 * the palette itself lives in phone-setup.css, driven by data-ps-theme on .ps-shell,
 * with dark as the default and light following the viewer's OS until they toggle.
 */
export default function PhoneSetupLayout({ children }: { children: ReactNode }) {
  const shellRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    const prev = {
      rootOverflow: root.style.overflow, rootHeight: root.style.height,
      bodyOverflow: body.style.overflow, bodyHeight: body.style.height,
    };
    root.style.overflow = "auto"; root.style.height = "auto";
    body.style.overflow = "auto"; body.style.height = "auto";

    try {
      const saved = window.localStorage.getItem("ps-theme");
      if ((saved === "light" || saved === "dark") && shellRef.current) {
        shellRef.current.setAttribute("data-ps-theme", saved);
      }
    } catch {
      /* Private mode / blocked storage: the OS preference still decides. */
    }

    return () => {
      root.style.overflow = prev.rootOverflow; root.style.height = prev.rootHeight;
      body.style.overflow = prev.bodyOverflow; body.style.height = prev.bodyHeight;
    };
  }, []);

  return <div className="ps-shell" ref={shellRef}>{children}</div>;
}
