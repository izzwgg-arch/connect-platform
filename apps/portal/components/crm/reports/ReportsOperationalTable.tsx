"use client";

import { Inbox } from "lucide-react";
import type { ReactNode } from "react";

export function ReportsOperationalTable({
  cols,
  head,
  children,
  isEmpty,
  emptyLabel = "No data for this period",
}: {
  cols: number;
  head: ReactNode;
  children: ReactNode;
  isEmpty: boolean;
  emptyLabel?: string;
}) {
  return (
    <div className="overflow-x-auto rounded-crm-lg border border-crm-border">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-crm-border bg-crm-surface-2/60 text-[0.65rem] font-bold uppercase tracking-wider text-crm-muted">
            {head}
          </tr>
        </thead>
        <tbody className="divide-y divide-crm-border/50 bg-crm-surface">
          {isEmpty ? (
            <tr>
              <td colSpan={cols} className="py-10 text-center">
                <Inbox className="mx-auto mb-2 h-5 w-5 text-crm-muted/50" />
                <span className="text-sm text-crm-muted">{emptyLabel}</span>
              </td>
            </tr>
          ) : (
            children
          )}
        </tbody>
      </table>
    </div>
  );
}

export function RtTh({
  children,
  align = "left",
}: {
  children: ReactNode;
  align?: "left" | "center" | "right";
}) {
  const cls =
    align === "center" ? "text-center" : align === "right" ? "text-right" : "text-left";
  return <th className={`px-4 py-3 font-bold ${cls}`}>{children}</th>;
}

export function RtTd({
  children,
  className,
  align = "left",
}: {
  children: ReactNode;
  className?: string;
  align?: "left" | "center" | "right";
}) {
  const cls =
    align === "center" ? "text-center" : align === "right" ? "text-right" : "text-left";
  return <td className={`px-4 py-3 ${cls} ${className ?? ""}`}>{children}</td>;
}
