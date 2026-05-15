"use client";

import Link from "next/link";
import type { ReactNode } from "react";

export function BillingEmptyState({
  title,
  message,
  ctaHref,
  ctaLabel,
  secondary,
}: {
  title: string;
  message: ReactNode;
  ctaHref?: string;
  ctaLabel?: string;
  secondary?: ReactNode;
}) {
  return (
    <div
      className="billing-empty-state"
      style={{
        padding: "28px 24px",
        borderRadius: 12,
        border: "1px dashed color-mix(in srgb, var(--border, #cbd5e1) 75%, transparent)",
        background: "var(--surface-alt, #fafafa)",
        textAlign: "center",
        maxWidth: 480,
        margin: "12px auto",
      }}
    >
      <p style={{ margin: "0 0 6px", fontWeight: 700, fontSize: 16 }}>{title}</p>
      <p className="muted" style={{ margin: "0 0 16px", fontSize: 14, lineHeight: 1.55 }}>
        {message}
      </p>
      {ctaHref && ctaLabel ? (
        <Link className="btn primary" href={ctaHref} style={{ fontSize: 14 }}>
          {ctaLabel}
        </Link>
      ) : null}
      {secondary ? <div style={{ marginTop: 14 }}>{secondary}</div> : null}
    </div>
  );
}
