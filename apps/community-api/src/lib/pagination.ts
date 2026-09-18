/** Cursor pagination: opaque base64url of `${sortValue}|${id}`. */
export type Cursor = { value: string; id: string };

export function encodeCursor(value: string | Date | number, id: string): string {
  const v = value instanceof Date ? value.toISOString() : String(value);
  return Buffer.from(`${v}|${id}`).toString("base64url");
}

export function decodeCursor(raw: string | undefined | null): Cursor | null {
  if (!raw) return null;
  try {
    const s = Buffer.from(raw, "base64url").toString("utf8");
    const i = s.lastIndexOf("|");
    if (i <= 0) return null;
    return { value: s.slice(0, i), id: s.slice(i + 1) };
  } catch {
    return null;
  }
}

export function clampLimit(raw: unknown, def = 20, max = 50): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}
