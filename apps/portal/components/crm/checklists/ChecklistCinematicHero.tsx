"use client";

import { ClipboardList, Layers, Plus, Sparkles } from "lucide-react";
import { cn } from "../cn";
import { crm } from "../crmClasses";
import { CHECKLIST_TEMPLATES } from "./ChecklistTemplates";

const PARTICLES = [
  { className: "left-[12%] top-[18%] h-1 w-1", delay: "0s" },
  { className: "right-[14%] top-[22%] h-1.5 w-1.5", delay: "0.8s" },
  { className: "left-[22%] bottom-[28%] h-1 w-1", delay: "1.4s" },
  { className: "right-[20%] bottom-[32%] h-1 w-1", delay: "2.1s" },
  { className: "left-[48%] top-[12%] h-0.5 w-0.5", delay: "0.4s" },
  { className: "right-[38%] bottom-[18%] h-1 w-1", delay: "1.8s" },
] as const;

type Props = {
  templateCount: number;
  onBrowseTemplates: () => void;
  onBlank: () => void;
};

export function ChecklistCinematicHero({
  templateCount,
  onBrowseTemplates,
  onBlank,
}: Props) {
  return (
    <section className={crm.checklistCinematicHero} aria-label="Get started">
      <div className={crm.checklistCinematicHeroVignette} aria-hidden />
      <div className={crm.checklistCinematicHeroGlowTop} aria-hidden />
      <div className={crm.checklistCinematicHeroGlowFloor} aria-hidden />
      <div className={crm.checklistCinematicHeroGrid} aria-hidden />

      {PARTICLES.map((p, i) => (
        <span
          key={i}
          className={cn("checklist-particle", p.className)}
          style={{ animationDelay: p.delay }}
          aria-hidden
        />
      ))}

      <div className="relative z-[2] flex flex-col items-center px-4 py-10 sm:py-12">
        <span className="mb-5 inline-flex items-center gap-1.5 rounded-full border border-crm-accent/30 bg-crm-accent/8 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-crm-accent shadow-[0_0_24px_-8px_rgba(56,189,248,0.45)]">
          <Sparkles size={11} className="opacity-90" />
          Operational command center
        </span>

        <div className="relative mb-6">
          <span className={crm.checklistOrbRingOuter} aria-hidden />
          <span className={crm.checklistOrbRingMid} aria-hidden />
          <span className={crm.checklistOnboardingOrbPulse} aria-hidden />
          <span className={cn(crm.checklistOnboardingOrb, "checklist-hero-orb")}>
            <ClipboardList size={40} className="text-crm-accent drop-shadow-[0_0_12px_rgba(56,189,248,0.5)]" />
          </span>
        </div>

        <h2 className="max-w-lg text-center text-xl font-semibold tracking-tight text-crm-text sm:text-2xl">
          Choose a playbook to begin
        </h2>
        <p className="mt-2.5 max-w-md text-center text-sm leading-relaxed text-crm-muted/95">
          Start with proven outreach workflows built for live calls — or craft a
          custom checklist your team runs on every dial.
        </p>

        <div className="mt-7 flex flex-wrap items-center justify-center gap-2.5">
          <button
            type="button"
            onClick={onBrowseTemplates}
            className={cn(crm.btnPrimary, crm.checklistCtaGlow)}
          >
            <Layers size={15} />
            Browse templates
          </button>
          <button
            type="button"
            onClick={onBlank}
            className={cn(crm.btnSecondary, "border-crm-border/60 bg-crm-surface-2/80 backdrop-blur-sm")}
          >
            <Plus size={15} />
            Start from blank
          </button>
        </div>

        <p className="mt-4 text-[11px] font-medium tabular-nums text-crm-muted/80">
          {templateCount} starter playbooks · live-call ready
        </p>
      </div>
    </section>
  );
}
