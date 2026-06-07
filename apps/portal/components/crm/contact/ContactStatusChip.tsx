"use client";

import type { ReactNode } from "react";
import { cn } from "../cn";

export type CrmStatusTone =
  | "orange"
  | "purple"
  | "green"
  | "blue"
  | "teal"
  | "emerald"
  | "darkGreen"
  | "red"
  | "gray";

type StatusPaletteEntry = {
  tone: CrmStatusTone;
  className: string;
};

export const CRM_STATUS_PALETTE: Record<string, StatusPaletteEntry> = {
  "No Answer": { tone: "red", className: "bg-red-50 text-red-600" },
  "Left Voicemail": { tone: "purple", className: "bg-[#F3E8FF] text-[#9333EA]" },
  "VM Left": { tone: "purple", className: "bg-[#F3E8FF] text-[#9333EA]" },
  VM: { tone: "purple", className: "bg-[#F3E8FF] text-[#9333EA]" },
  Interested: { tone: "green", className: "bg-[#ECFDF3] text-[#16A34A]" },
  "Follow Up": { tone: "blue", className: "bg-[#EFF6FF] text-[#2563EB]" },
  "Follow-up": { tone: "blue", className: "bg-[#EFF6FF] text-[#2563EB]" },
  "Follow-Up": { tone: "blue", className: "bg-[#EFF6FF] text-[#2563EB]" },
  Sent: { tone: "blue", className: "bg-[#EFF6FF] text-[#2563EB]" },
  Viewed: { tone: "purple", className: "bg-[#F3E8FF] text-[#9333EA]" },
  Completed: { tone: "green", className: "bg-[#ECFDF3] text-[#16A34A]" },
  Expired: { tone: "orange", className: "bg-[#FFF4E5] text-[#E67E22]" },
  Declined: { tone: "red", className: "bg-red-50 text-red-600" },
  "Appointment Set": { tone: "teal", className: "bg-teal-50 text-teal-700" },
  Qualified: { tone: "emerald", className: "bg-emerald-50 text-emerald-700" },
  Converted: { tone: "darkGreen", className: "bg-green-100 text-green-800" },
  "Do Not Call": { tone: "red", className: "bg-red-50 text-red-700" },
  "Bad Number": { tone: "gray", className: "bg-slate-100 text-slate-600" },
  "Not Interested": { tone: "red", className: "bg-red-50 text-red-700" },
};

export function crmStatusChipClassName(status: string | null | undefined): string {
  return CRM_STATUS_PALETTE[status ?? ""]?.className ?? "bg-slate-100 text-slate-600";
}

export function CRMStatusChip({
  status,
  children,
  className,
}: {
  status: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border-0 px-2.5 py-1 text-[11px] font-bold leading-tight shadow-[inset_0_0_0_1px_rgba(255,255,255,0.5)]",
        crmStatusChipClassName(status),
        className,
      )}
    >
      {children ?? status}
    </span>
  );
}
