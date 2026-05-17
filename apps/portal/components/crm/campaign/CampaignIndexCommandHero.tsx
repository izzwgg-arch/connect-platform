"use client";

import type { ReactNode } from "react";
import { cn } from "../cn";
import { crm } from "../crmClasses";

export function CampaignIndexCommandHero({
  title,
  subtitle,
  actions,
  kpis,
}: {
  title: string;
  subtitle: string;
  actions?: ReactNode;
  kpis: {
    label: string;
    value: number | string;
    tone?: "default" | "warn" | "accent";
  }[];
}) {
  return (
    <header className={crm.campaignCommandHero}>
      <div className={crm.campaignCommandHeroInner}>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-crm-accent/90">Outbound desk</p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight text-crm-text sm:text-3xl">{title}</h1>
            <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-crm-muted">{subtitle}</p>
          </div>
          {actions ? <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div> : null}
        </div>

        {kpis.length > 0 ? (
          <dl className={crm.campaignCommandHeroKpiGrid}>
            {kpis.map((k) => (
              <div
                key={k.label}
                className={cn(
                  crm.campaignCommandHeroKpi,
                  k.tone === "warn" && crm.campaignCommandHeroKpiUrgent,
                  k.tone === "accent" && crm.campaignCommandHeroKpiAccent,
                )}
              >
                <dt className={crm.campaignCommandHeroKpiLabel}>{k.label}</dt>
                <dd className={cn(crm.campaignCommandHeroKpiValue, k.tone === "warn" && "text-crm-warning")}>
                  {k.value}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
    </header>
  );
}
