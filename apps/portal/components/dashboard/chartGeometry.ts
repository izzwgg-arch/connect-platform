type Point = { x: number; y: number };

/** Keep the existing cardinal curve, but bound its controls to each data segment.
 * A cubic stays in its control-point hull, so it cannot invent negative calls
 * (or peaks above the observed counts). Flat zero runs stay exactly flat. */
export function smoothLine(points: Point[], tension = 0.5): string {
  if (!points.length) return "";
  const segments = [`M ${points[0]!.x} ${points[0]!.y}`];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2] ?? p2;
    const boundY = (y: number) => Math.max(Math.min(p1.y, p2.y), Math.min(Math.max(p1.y, p2.y), y));
    const cp1x = p1.x + ((p2.x - p0.x) / 6) * tension;
    const cp2x = p2.x - ((p3.x - p1.x) / 6) * tension;
    const cp1y = boundY(p1.y + ((p2.y - p0.y) / 6) * tension);
    const cp2y = boundY(p2.y - ((p3.y - p1.y) / 6) * tension);
    segments.push(`C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`);
  }
  return segments.join(" ");
}

/** Reserve enough room for full date labels, always including both endpoints. */
export function chartTickIndices(count: number, width: number): number[] {
  if (count <= 0) return [];
  if (count === 1) return [0];
  const slots = Math.min(count, 8, Math.max(2, Math.floor(width / 120)));
  return Array.from({ length: slots }, (_, i) => Math.round(i * (count - 1) / (slots - 1)));
}

export function trafficWindowLabel(data: { windowFrom?: string; windowTo?: string; timezone: string } | null): string | null {
  if (!data?.windowFrom || !data.windowTo) return null;
  const from = new Date(data.windowFrom);
  // API windowTo is exclusive: midnight belongs to the previous day's window.
  const to = new Date(new Date(data.windowTo).getTime() - 1);
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to) return null;
  const format = new Intl.DateTimeFormat(undefined, { timeZone: data.timezone, month: "short", day: "numeric", year: "numeric" });
  const start = format.format(from);
  const end = format.format(to);
  return `${start === end ? start : `${start} – ${end}`} · ${data.timezone}`;
}
