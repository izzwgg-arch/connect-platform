type ChipColor = "default" | "neutral" | "success" | "warning" | "danger" | "info";

interface StatusChipProps {
  label: string;
  color?: ChipColor;
  /** Alias for color — used in existing pages */
  tone?: ChipColor;
}

const COLOR_STYLES: Record<ChipColor, { bg: string; text: string; border: string }> = {
  default: { bg: "rgba(142,160,178,0.10)", text: "var(--text-dim)",   border: "var(--border)" },
  neutral: { bg: "rgba(142,160,178,0.10)", text: "var(--text-dim)",   border: "var(--border)" },
  success: { bg: "rgba(52,194,123,0.12)",  text: "var(--success)",   border: "rgba(52,194,123,0.30)" },
  warning: { bg: "rgba(240,182,85,0.12)",  text: "var(--warning)",   border: "rgba(240,182,85,0.30)" },
  danger:  { bg: "rgba(234,96,104,0.12)",  text: "var(--danger)",    border: "rgba(234,96,104,0.30)" },
  info:    { bg: "rgba(34,168,255,0.12)",  text: "var(--info)",      border: "rgba(34,168,255,0.30)" },
};

export function StatusChip({ label, color, tone }: StatusChipProps) {
  const resolved: ChipColor = color ?? tone ?? "default";
  const s = COLOR_STYLES[resolved];
  return (
    <span style={{
      display: "inline-flex",
      alignItems: "center",
      padding: "2px 9px",
      borderRadius: 20,
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: "0.3px",
      background: s.bg,
      color: s.text,
      border: `1px solid ${s.border}`,
      whiteSpace: "nowrap",
    }}>
      {label}
    </span>
  );
}
