"use client";

import { useEffect } from "react";
import type { ReactNode } from "react";
import "./onboarding.css";

export default function OnboardingLayout({ children }: { children: ReactNode }) {
  useEffect(() => {
    const root = document.documentElement;
    const prev = root.getAttribute("data-theme");
    root.setAttribute("data-theme", "light");
    return () => {
      if (prev) root.setAttribute("data-theme", prev);
      else root.removeAttribute("data-theme");
    };
  }, []);

  return <div className="ob-shell">{children}</div>;
}
