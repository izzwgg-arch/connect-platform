"use client";

import { CheckSquare, Copy, Keyboard, Lightbulb, Zap } from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";

const TIPS = [
  { icon: Keyboard, label: "Press N", detail: "Create a new script anytime" },
  { icon: CheckSquare, label: "Checklist mode", detail: "Structured call flows per section" },
  { icon: Copy, label: "Copy sections", detail: "Reuse proven language on live calls" },
  { icon: Zap, label: "Go live", detail: "Open in Live Call Workspace" },
] as const;

export function ScriptQuickTipsStrip() {
  return (
    <div className={crm.scriptsTipsStrip} role="note" aria-label="Quick tips">
      <span className="flex items-center gap-1.5 font-semibold uppercase tracking-wider text-crm-muted">
        <Lightbulb className="h-3.5 w-3.5 text-crm-warning" aria-hidden />
        Quick tips
      </span>
      {TIPS.map((tip) => (
        <span key={tip.label} className="flex items-center gap-1.5">
          <tip.icon className="h-3 w-3 shrink-0 text-crm-accent/80" aria-hidden />
          <span className="font-medium text-crm-text">{tip.label}</span>
          <span className="text-crm-muted/90">— {tip.detail}</span>
        </span>
      ))}
    </div>
  );
}
