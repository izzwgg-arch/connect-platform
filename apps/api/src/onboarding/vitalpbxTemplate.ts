/**
 * VitalPBX CSV generator for onboarding exports. No upload/side-effects.
 * Escapes commas/quotes/newlines and validates duplicates.
 */

function csvEscapeCell(raw: string | number | null | undefined): string {
  const s = raw == null ? "" : String(raw);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export type CsvExtensionRow = {
  extNumber: string; // numeric-only string already validated
  name?: string | null;
  email?: string | null;
  device?: string | null; // reserved for future use
  password?: string | null; // reserved for future use
  voicemail?: string | null; // e.g. "enabled"/"disabled"
  class_of_service?: string | null;
};

export function generateVitalPbxCsv(rows: CsvExtensionRow[]): { filename: string; mime: string; body: string } {
  // Validate duplicates
  const seen = new Set<string>();
  for (const r of rows) {
    const k = String(r.extNumber || "");
    if (!k) throw new Error("missing_ext_number");
    if (seen.has(k)) throw new Error("duplicate_extension");
    seen.add(k);
  }
  const header = [
    "extension",
    "name",
    "email",
    "device",
    "password",
    "voicemail",
    "class_of_service",
  ];
  const lines: string[] = [header.join(",")];
  for (const r of rows) {
    const rec = [
      csvEscapeCell(r.extNumber),
      csvEscapeCell(r.name || ""),
      csvEscapeCell(r.email || ""),
      csvEscapeCell(r.device || ""),
      csvEscapeCell(r.password || ""),
      csvEscapeCell(r.voicemail ?? "enabled"),
      csvEscapeCell(r.class_of_service || ""),
    ];
    lines.push(rec.join(","));
  }
  const body = lines.join("\n");
  const filename = `vitalpbx_extensions_${Date.now()}.csv`;
  return { filename, mime: "text/csv; charset=utf-8", body };
}
