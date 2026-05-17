"use client";

import type { CSSProperties } from "react";
import { invoiceFinanceStatusTone, invoiceStatusLabel } from "../../lib/billingUi";

export function BillingFinanceChip({
  status,
  label: labelOverride,
  tone: toneOverride,
  className = "",
  style,
}: {
  status?: string | null | undefined;
  label?: string;
  tone?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const tone = toneOverride || invoiceFinanceStatusTone(status);
  const label = labelOverride || invoiceStatusLabel(status);
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
