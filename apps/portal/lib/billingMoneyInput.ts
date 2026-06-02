/** Pure helpers for billing money/quantity text inputs (no React). */

export function formatCentsAsDollars(cents: number | undefined | null): string {
  return (Number(cents || 0) / 100).toFixed(2);
}

export function parseDollarsInput(value: string): number {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return 0;
  const n = Number(trimmed.replace(/[^0-9. -]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** Allow natural decimal typing without forced reformatting while editing. */
export function sanitizeMoneyDraft(value: string): string {
  let s = String(value ?? "").replace(/[^0-9.]/g, "");
  const dot = s.indexOf(".");
  if (dot >= 0) {
    s = `${s.slice(0, dot + 1)}${s.slice(dot + 1).replace(/\./g, "")}`;
  }
  return s;
}

/** Seed the in-progress money field when focus begins. */
export function centsToMoneyDraft(cents: number | undefined | null): string {
  const n = Number(cents || 0);
  if (!Number.isFinite(n) || n <= 0) return "";
  return formatCentsAsDollars(n);
}

export function sanitizeQuantityDraft(value: string): string {
  return String(value ?? "").replace(/[^0-9]/g, "");
}

export function parseQuantityDraft(value: string, fallback = 0): number {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return fallback;
  const n = Math.round(Number(trimmed));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100_000, n));
}

export function quantityToDraft(value: number | undefined | null): string {
  const n = Math.round(Number(value || 0));
  if (!Number.isFinite(n) || n <= 0) return "";
  return String(n);
}
