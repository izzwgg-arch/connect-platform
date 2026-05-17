"use client";

import Link from "next/link";
import type { ReactNode } from "react";

export function BillingEmptyState({
  title,
  message,
  ctaHref,
  ctaLabel,
  secondary,
  compact,
}: {
  title: string;
  message: ReactNode;
  ctaHref?: string;
  ctaLabel?: string;
  secondary?: ReactNode;
  /** Tighter padding when nested inside a table row group */
  compact?: boolean;
}) {
  return (
    <div
      className={`billing-empty-state${compact ? " billing-empty-state--compact" : ""}`}
      role="status"
    >
      <div className="billing-empty-state__icon" aria-hidden>
        ◌
      </div>
      <p className="billing-empty-state__title">{title}</p>
      <p className="billing-empty-state__message">{message}</p>
      {ctaHref && ctaLabel ? (
        <Link className="btn primary billing-empty-state__cta" href={ctaHref}>
          {ctaLabel}
        </Link>
      ) : null}
      {secondary ? <div className="billing-empty-state__secondary">{secondary}</div> : null}
    </div>
  );
}
