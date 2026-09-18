/** Pure — no imports — so it's testable under plain Node. See src/api/realtime.ts. */
export function backoffSchedule(attempt: number, base = 1000, cap = 30_000): number {
  if (attempt < 0) return base;
  return Math.min(base * 2 ** attempt, cap);
}
