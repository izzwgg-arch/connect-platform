export function StatusChip({ tone = "neutral", label }: { tone?: "success" | "warning" | "danger" | "info" | "neutral"; label: string }) {
  return <span className={`chip ${tone}`}>{label}</span>;
}
