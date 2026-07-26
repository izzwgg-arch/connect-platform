"use client";

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import "./onboarding.css";

/**
 * Public onboarding shell. Renders its own themed surface (dark by default to
 * match the Connect platform, light when the viewer's OS or the in-wizard toggle
 * asks for it). We only manage scroll + the saved theme preference here; the
 * palette itself lives in onboarding.css, driven by data-ob-theme on .ob-shell.
 */
export default function OnboardingLayout({ children }: { children: ReactNode }) {
  const shellRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    const prevRootOverflow = root.style.overflow;
    const prevRootHeight = root.style.height;
    const prevBodyOverflow = body.style.overflow;
    const prevBodyHeight = body.style.height;
    root.style.overflow = "auto";
    root.style.height = "auto";
    body.style.overflow = "auto";
    body.style.height = "auto";

    // Apply a saved theme preference if the visitor has toggled before.
    try {
      const saved = window.localStorage.getItem("ob-theme");
      if ((saved === "light" || saved === "dark") && shellRef.current) {
        shellRef.current.setAttribute("data-ob-theme", saved);
      }
    } catch {
      /* ignore storage errors */
    }

    return () => {
      root.style.overflow = prevRootOverflow;
      root.style.height = prevRootHeight;
      body.style.overflow = prevBodyOverflow;
      body.style.height = prevBodyHeight;
    };
  }, []);

  return (
    <div className="ob-shell" ref={shellRef}>
      {children}
    </div>
  );
}
