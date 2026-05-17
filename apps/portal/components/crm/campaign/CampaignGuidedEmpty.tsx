"use client";

import type { ReactNode } from "react";
import { cn } from "../cn";
import { crm } from "../crmClasses";

export type CampaignGuidedStep = {
  label: string;
  hint?: string;
};

export function CampaignGuidedEmpty({
  icon,
  title,
  steps,
  action,
  className,
  compact,
}: {
  icon?: ReactNode;
  title: string;
  steps?: CampaignGuidedStep[];
  action?: ReactNode;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div className={cn(crm.campaignGuidedEmpty, compact && "py-4", className)}>
      <div className="flex flex-col sm:flex-row sm:items-start gap-3 sm:gap-4">
        {icon ? (
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-crm bg-crm-surface text-crm-muted">
            {icon}
          </div>
        ) : null}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-crm-text">{title}</p>
          {steps && steps.length > 0 ? (
            <ol className="mt-2.5 space-y-1.5">
              {steps.map((step, i) => (
                <li key={step.label} className="flex gap-2 text-xs text-crm-muted leading-snug">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-crm-border bg-crm-surface text-[10px] font-bold tabular-nums">
                    {i + 1}
                  </span>
                  <span>
                    <span className="font-medium text-crm-text">{step.label}</span>
                    {step.hint ? <span> — {step.hint}</span> : null}
                  </span>
                </li>
              ))}
            </ol>
          ) : null}
          {action ? <div className="mt-3 flex flex-wrap gap-2">{action}</div> : null}
        </div>
      </div>
    </div>
  );
}
