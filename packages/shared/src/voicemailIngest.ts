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

export function vmNormalizeFolder(folder: string): "inbox" | "old" | "urgent" {
  const f = folder.toLowerCase();
  if (f === "inbox" || f === "in") return "inbox";
  if (f === "urgent") return "urgent";
  return "old";
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
