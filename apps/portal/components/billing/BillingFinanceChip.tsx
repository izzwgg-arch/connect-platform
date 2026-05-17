"use client";

import type { CSSProperties } from "react";
import { invoiceFinanceStatusTone, invoiceStatusLabel } from "../../lib/billingUi";

export function BillingFinanceChip({
  status,
  className = "",
  style,
}: {
  status: string | null | undefined;
  className?: string;
  style?: CSSProperties;
}) {
  const tone = invoiceFinanceStatusTone(status);
  const label = invoiceStatusLabel(status);
  return (
    <span
      className={`billing-fin-chip billing-fin-chip--${tone}${className ? ` ${className}` : ""}`}
      style={style}
      data-status={String(status || "").toUpperCase()}
    >
      <span className="billing-fin-chip__dot" aria-hidden />
      {label}
    </span>
  );
}
