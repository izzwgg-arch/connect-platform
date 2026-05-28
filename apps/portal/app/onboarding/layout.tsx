"use client";

import { useEffect } from "react";
import type { ReactNode } from "react";
import "./onboarding.css";

export default function OnboardingLayout({ children }: { children: ReactNode }) {
  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    const prev = root.getAttribute("data-theme");
    const prevRootOverflow = root.style.overflow;
    const prevRootHeight = root.style.height;
    const prevBodyOverflow = body.style.overflow;
    const prevBodyHeight = body.style.height;
    root.setAttribute("data-theme", "light");
    root.style.overflow = "auto";
    root.style.height = "auto";
    body.style.overflow = "auto";
    body.style.height = "auto";
    return () => {
      if (prev) root.setAttribute("data-theme", prev);
      else root.removeAttribute("data-theme");
      root.style.overflow = prevRootOverflow;
      root.style.height = prevRootHeight;
      body.style.overflow = prevBodyOverflow;
      body.style.height = prevBodyHeight;
    };
  }, []);

  return <div className="ob-shell">{children}</div>;
}
