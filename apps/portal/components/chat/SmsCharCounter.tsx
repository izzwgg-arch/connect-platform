"use client";

import { analyzeSmsText, formatSmsCounterLabel } from "@connect/shared";

export function SmsCharCounter({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const analysis = analyzeSmsText(text);
  const { label, hint, overLimit } = formatSmsCounterLabel(analysis);

  if (!text.trim()) return null;

  return (
    <div className={className} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span
        style={{
          fontSize: "inherit",
          color: overLimit ? "var(--danger, #ef4444)" : "var(--text-dim, #94a3b8)",
          fontWeight: overLimit ? 600 : 400,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {label}
      </span>
      {hint ? (
        <span style={{ fontSize: "0.92em", color: "var(--text-dim, #94a3b8)" }}>{hint}</span>
      ) : null}
    </div>
  );
}

export function isSmsTextOverLimit(text: string): boolean {
  return analyzeSmsText(text).overLimit;
}
