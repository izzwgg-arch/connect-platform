"use client";

import type { ReactNode } from "react";
import { cn } from "../cn";
import { mk, KPI_ACCENT, type CampaignKpiAccent } from "./campaignCinemaClasses";
import { CampaignKpiSparkline } from "./CampaignKpiSparkline";

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
    accent?: CampaignKpiAccent;
    sub?: string;
  }[];
}) {
  return (
    <header className={mk.heroShell}>
      <div className={mk.atmosphere} aria-hidden>
        <div className="absolute -left-[10%] top-[-40%] h-[70%] w-[55%] rounded-full bg-[radial-gradient(circle,rgba(59,130,246,0.22),transparent_70%)]" />
        <div className="absolute right-[-5%] top-[-20%] h-[55%] w-[45%] rounded-full bg-[radial-gradient(circle,rgba(139,92,246,0.14),transparent_68%)]" />
      </div>
      <div className={mk.heroInner}>
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <h1 className={mk.heroTitle}>{title}</h1>
            <p className={mk.heroSubtitle}>{subtitle}</p>
          </div>
          {actions ? <div className={mk.heroActions}>{actions}</div> : null}
        </div>

        {kpis.length > 0 ? (
          <div className={mk.kpiGrid}>
            {kpis.map((k) => {
              const accent = k.accent ?? "blue";
              const a = KPI_ACCENT[accent];
              return (
                <div
                  key={k.label}
                  className={cn(mk.kpiCard, a.border, a.glow)}
                >
                  <p className={mk.kpiLabel}>{k.label}</p>
                  <p className={mk.kpiValue}>{k.value}</p>
                  {k.sub ? <p className={cn(mk.kpiSub, a.sub)}>{k.sub}</p> : null}
                  <CampaignKpiSparkline
                    seed={`${k.label}-${k.value}`}
                    color={a.spark}
                    className={mk.kpiSpark}
                  />
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </header>
  );
}
