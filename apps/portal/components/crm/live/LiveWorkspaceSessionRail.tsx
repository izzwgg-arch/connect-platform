"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ChevronRight,
  ListOrdered,
  Megaphone,
  Radio,
  User,
  Zap,
} from "lucide-react";
import { CRMCard } from "../CRMCard";
import { CRMSection } from "../CRMSection";
import { crm } from "../crmClasses";
import { cn } from "../cn";

export function LiveWorkspaceSessionRail({
  queueBackHref,
  memberId,
  isPowerMode,
  campaignId,
  campaignName,
  contactId,
  contactName,
  onBack,
}: {
  queueBackHref: string | null;
  memberId: string | null;
  isPowerMode: boolean;
  campaignId: string | null;
  campaignName: string | null;
  contactId: string | null;
  contactName: string | null;
  onBack: () => void;
}) {
  return (
    <CRMCard padding="md" className="flex flex-col gap-4">
      <CRMSection title="Session" description="Queue and campaign context for this workspace.">
        <nav className="flex flex-col gap-1">
          <button type="button" onClick={onBack} className={cn(crm.btnGhost, "justify-start px-2")}>
            <ArrowLeft className="h-4 w-4" />
            {memberId ? "Return to queue" : "Back"}
          </button>
          {queueBackHref ? (
            <Link href={queueBackHref} className={cn(crm.btnSecondary, "justify-start text-xs")}>
              <ListOrdered className="h-3.5 w-3.5" />
              {isPowerMode ? "Next lead (power)" : "Next in queue"}
              <ChevronRight className="ml-auto h-3.5 w-3.5 opacity-60" />
            </Link>
          ) : null}
        </nav>
      </CRMSection>

      {isPowerMode ? (
        <div className="flex items-center gap-2 rounded-crm border border-crm-warning/35 bg-crm-warning/10 px-3 py-2 text-xs font-semibold text-crm-warning">
          <Zap className="h-3.5 w-3.5 shrink-0" />
          Power dial session
        </div>
      ) : null}

      <div className="space-y-2">
        <p className={crm.label}>Context</p>
        {campaignId ? (
          <ContextRow
            icon={<Megaphone className="h-3.5 w-3.5" />}
            label="Campaign"
            value={campaignName ?? "Campaign queue"}
            href={`/crm/campaigns/${campaignId}`}
          />
        ) : (
          <p className="text-xs text-crm-muted">No campaign — opened from contact or screen pop.</p>
        )}
        {memberId ? (
          <ContextRow
            icon={<ListOrdered className="h-3.5 w-3.5" />}
            label="Queue member"
            value={memberId.slice(0, 8) + "…"}
            href={queueBackHref ?? "/crm/queue"}
          />
        ) : null}
        {contactId ? (
          <ContextRow
            icon={<User className="h-3.5 w-3.5" />}
            label="Contact"
            value={contactName ?? "Contact"}
            href={`/crm/contacts/${contactId}`}
          />
        ) : null}
      </div>

      <div className="border-t border-crm-border/60 pt-3">
        <p className={crm.label}>Shortcuts</p>
        <div className="mt-2 flex flex-col gap-1">
          <Link href="/crm/queue" className={cn(crm.btnGhost, "justify-start px-2 text-xs")}>
            <ListOrdered className="h-3.5 w-3.5" />
            My Queue
          </Link>
          <Link href="/crm/scripts" className={cn(crm.btnGhost, "justify-start px-2 text-xs")}>
            <Radio className="h-3.5 w-3.5" />
            Scripts library
          </Link>
          <Link href="/crm/checklists" className={cn(crm.btnGhost, "justify-start px-2 text-xs")}>
            Checklists library
          </Link>
        </div>
      </div>
    </CRMCard>
  );
}

function ContextRow({
  icon,
  label,
  value,
  href,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-2 rounded-crm border border-crm-border/80 bg-crm-surface-2/50 px-2.5 py-2 text-xs hover:border-crm-accent/30"
    >
      <span className="text-crm-muted">{icon}</span>
      <span className="text-crm-muted">{label}</span>
      <span className="ml-auto truncate font-medium text-crm-text">{value}</span>
      <ChevronRight className="h-3 w-3 shrink-0 text-crm-muted" />
    </Link>
  );
}
