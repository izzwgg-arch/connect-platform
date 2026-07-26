/** Parse "Name" <number> or plain number from Asterisk callerid string */
export function vmExtractCallerNumber(callerid: string): string {
  const m = callerid.match(/<([^>]+)>/);
  const raw = m ? m[1]! : callerid.replace(/"/g, "").trim();
  return raw.replace(/\D/g, "");
}

export function vmExtractCallerName(callerid: string): string {
  const idx = callerid.indexOf("<");
  if (idx <= 0) return "";
  const name = callerid.slice(0, idx).replace(/^\s*"?/, "").replace(/"?\s*$/, "").trim();
  if (!name || /^[\d\s+\-().]+$/.test(name)) return "";
  return name;
}

/**
 * Split a leading ring-group prefix off a voicemail caller name.
 *
 * When a call reaches a mailbox through a ring group, the PBX prepends the group
 * name to the caller-ID name, e.g. "Sales: John Smith", "Sales - John Smith",
 * "[Sales] John Smith", or "Sales | John Smith". This returns the group word on
 * its own (shown as a badge in the voicemail email) plus the remaining caller
 * name.
 *
 * Deliberately conservative: it only treats text as a prefix when there is a
 * clear separator AND a real name follows, so ordinary names ("Smith, John",
 * "Jean-Pierre", a bare number) are never mis-split. No match → { prefix: null,
 * name: <original> }.
 */
export function vmSplitRingGroupPrefix(callerName: string | null | undefined): {
  prefix: string | null;
  name: string;
} {
  const raw = (callerName ?? "").trim();
  if (!raw) return { prefix: null, name: "" };

  // [Group] Name
  const bracket = raw.match(/^\[\s*([\p{L}\p{N}][\p{L}\p{N} &/._-]{0,28})\s*\]\s*(.+)$/u);
  if (bracket) {
    const prefix = bracket[1]!.trim();
    const name = bracket[2]!.trim();
    if (prefix && name) return { prefix, name };
  }

  // Group: Name   /   Group | Name   /   Group – Name   /   Group - Name
  // Prefix must be short and free of the separators that could belong to the
  // name; the separator is required to have a following name.
  const sep = raw.match(/^([\p{L}\p{N}][\p{L}\p{N} &/._']{0,28}?)\s*[:|–—]\s*(.+)$/u)
    // Spaced hyphen only (so "Jean-Pierre" is untouched — needs spaces around it).
    ?? raw.match(/^([\p{L}\p{N}][\p{L}\p{N} &/._']{0,28}?)\s+[-]\s+(.+)$/u);
  if (sep) {
    const prefix = sep[1]!.trim();
    const name = sep[2]!.trim();
    // Guard against splitting "Last, First" style or a numeric-only lead.
    if (prefix && name && !/^[\d\s+().-]+$/.test(prefix)) {
      return { prefix, name };
    }
  }

  return { prefix: null, name: raw };
}

export function vmNormalizeFolder(folder: string): "inbox" | "old" | "urgent" {
  const f = folder.toLowerCase();
  if (f === "inbox" || f === "in") return "inbox";
  if (f === "urgent") return "urgent";
  return "old";
}

/** Stable `pbxMessageId` for voicemail dedupe (matches worker + API upsert logic). */
export function vmStablePbxMessageId(input: {
  msgId?: unknown;
  pbxTenantIdOrTenantCuid: string;
  extNumber: string;
  origtime: string;
  callerDigits: string;
}): string {
  const mid = input.msgId != null ? String(input.msgId).trim() : "";
  if (mid) return mid;
  return `${input.pbxTenantIdOrTenantCuid}|${input.extNumber}|${input.origtime}|${input.callerDigits}`;
}

/** Map PBX helper spool rows into the loose shape consumed by REST-style ingestion loops. */
export function mapHelperVoicemailSpoolToRecordShape(m: {
  folder: string;
  origtime: string;
  callerid: string;
  duration: string;
  filename: string;
  msg_num: string;
  recfile: string;
}): Record<string, unknown> {
  return {
    date: m.origtime,
    origtime: m.origtime,
    clid: m.callerid,
    folder: m.folder,
    filename: m.filename,
    recfile: m.recfile || "",
    duration: m.duration || "0",
    msg_num: m.msg_num,
  };
}
