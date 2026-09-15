/** Search metadata dates are UTC days; include the whole day in the viewer's local date filters. */
export function searchDayRange(day: string, timeZone?: string): { startDate: string; endDate: string } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const start = new Date(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(start.getTime()) || start.toISOString().slice(0, 10) !== day) return null;
  const format = new Intl.DateTimeFormat("en", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const localDay = (date: Date) => {
    const parts = format.formatToParts(date);
    return ["year", "month", "day"].map(type => parts.find(part => part.type === type)!.value).join("-");
  };
  return { startDate: localDay(start), endDate: localDay(new Date(start.getTime() + 86_400_000 - 1)) };
}
