"use client";

import { useEffect } from "react";
import type { ReactNode } from "react";
import "./onboarding.css";

export default function OnboardingLayout({ children }: { children: ReactNode }) {
  useEffect(() => {
    const root = document.documentElement;
    const prev = root.getAttribute("data-theme");
    root.setAttribute("data-theme", "light");
    const prevHtmlOverflow = root.style.overflow;
    const prevBodyOverflow = document.body.style.overflow;
    root.style.overflow = "auto";
    document.body.style.overflow = "auto";
    return () => {
      if (prev) root.setAttribute("data-theme", prev);
      else root.removeAttribute("data-theme");
      root.style.overflow = prevHtmlOverflow;
      document.body.style.overflow = prevBodyOverflow;
    };
  }, []);

  return <div className="ob-shell">{children}</div>;
}
