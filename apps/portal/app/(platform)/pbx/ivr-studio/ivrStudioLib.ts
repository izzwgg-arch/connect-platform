// Shared, framework-agnostic helpers for the IVR Studio page. Extracted so the
// page component stays focused on UI and so these pure functions are unit-testable.
// The CEP (context,exten,priority) encodings MUST stay identical to the publisher
// in apps/api/src/server.ts (ivrValidateDestinationRef) or published AstDB keys
// will point the dialplan at the wrong place.

export type DestinationType =
  | "extension" | "queue" | "ring_group" | "voicemail" | "ivr"
  | "announcement" | "external_number" | "terminate" | "custom";

export const DESTINATION_TYPES: DestinationType[] = [
  "extension", "queue", "ring_group", "voicemail", "ivr",
  "announcement", "external_number", "terminate", "custom",
];

export const DESTINATION_TYPE_LABELS: Record<DestinationType, string> = {
  extension: "Extension",
  queue: "Queue",
  ring_group: "Ring group",
  voicemail: "Voicemail",
  ivr: "Sub-menu",
  announcement: "Announcement",
  external_number: "External #",
  terminate: "Hang up",
  custom: "Custom",
};

// The 12 keypad slots, in phone order (mockup layout).
export const OPTION_DIGIT_ORDER = ["1","2","3","4","5","6","7","8","9","star","0","hash"] as const;
export const DIGIT_GLYPH: Record<string, string> = { star: "*", hash: "#" };
export const DIGIT_SUBLABEL: Record<string, string> = { star: "star", hash: "pound" };

export interface ExtensionSuggestion {
  extension: string;
  name: string | null;
  pbxDeviceName?: string | null;
  pbxSipUsername?: string | null;
}
export interface NumberSuggestion { number: string; name: string | null }

/** Best-effort parse of a stored CEP ref back into the picker's selection. */
export function parseDestinationRef(type: DestinationType | "", ref: string): { selected: string; free: string } {
  const r = (ref ?? "").trim();
  if (!r) return { selected: "", free: "" };
  if (type === "extension") {
    const m = r.match(/^(?:from-internal|T\d+_cos-all),([^,]+),\d+$/i);
    if (m) return { selected: m[1], free: "" };
  }
  if (type === "queue") {
    const m = r.match(/^(?:ext-queues|T\d+_cos-all),([^,]+),\d+$/i);
    if (m) return { selected: m[1], free: "" };
  }
  if (type === "ring_group") {
    const m = r.match(/^(?:ext-group|T\d+_cos-all),([^,]+),\d+$/i);
    if (m) return { selected: m[1], free: "" };
    return { selected: "", free: r };
  }
  if (type === "voicemail") {
    const m = r.match(/^ext-local,vmu([^,]+),\d+$/i);
    if (m) return { selected: m[1], free: "" };
  }
  if (type === "external_number") return { selected: "", free: r };
  if (type === "terminate") return { selected: "", free: "" };
  return { selected: "", free: r };
}

export function tenantDialContextForExtension(row: ExtensionSuggestion | undefined): string | null {
  const values = [row?.pbxDeviceName, row?.pbxSipUsername].filter(Boolean).map(String);
  for (const value of values) {
    const m = value.match(/^T(\d+)_/i);
    if (m) return `T${m[1]}_cos-all`;
  }
  return null;
}

export function tenantDialContextFromSuggestions(rows: ExtensionSuggestion[]): string | null {
  for (const row of rows) {
    const ctx = tenantDialContextForExtension(row);
    if (ctx) return ctx;
  }
  return null;
}

/** Turn a picker selection into the exact CEP the publisher writes to AstDB. */
export function buildDestinationRef(
  type: DestinationType | "",
  selected: string,
  free: string,
  opts: { extensionRow?: ExtensionSuggestion; tenantDialContext?: string | null } = {},
): string {
  const s = (selected ?? "").trim();
  const f = (free ?? "").trim();
  const tenantDialContext = opts.tenantDialContext ?? null;
  if (type === "extension" && s) return `${tenantDialContextForExtension(opts.extensionRow) ?? tenantDialContext ?? "from-internal"},${s},1`;
  if (type === "queue" && s) return `${tenantDialContext ?? "ext-queues"},${s},1`;
  if (type === "ring_group" && s) return `${tenantDialContext ?? "ext-group"},${s},1`;
  if (type === "ring_group") return f;
  if (type === "voicemail" && s) return `ext-local,vmu${s},1`;
  if (type === "ivr") return f;
  if (type === "announcement") return f;
  if (type === "external_number") return f;
  if (type === "terminate") return "connect-default-fallback,s,1";
  if (type === "custom") return f;
  return f;
}

/** Client-side mirror of the server's ivrValidateDestinationRef — gives instant
 *  feedback so Save never posts a ref the API will 400 on. Returns null when OK. */
// EXACT mirror of the server (apps/api/src/server.ts IVR_CEP_REGEX / IVR_E164_REGEX)
// so the client never lets through a ref the API will 400 on, and never rejects
// one the API would accept.
const E164 = /^\+?[1-9]\d{1,14}$/;
const CEP = /^[a-zA-Z0-9_\-]{1,64},[a-zA-Z0-9_\-+*#]{1,80},\d{1,4}$/;
export function validateDestinationRef(type: DestinationType | "", ref: string): string | null {
  if (!type) return "Pick a destination type";
  const r = (ref ?? "").trim();
  if (type === "terminate") return null; // ref is fixed by buildDestinationRef
  if (!r) return "Choose where this goes";
  if (type === "external_number") return E164.test(r) ? null : "Enter a phone number like +18455551234";
  return CEP.test(r) ? null : "That destination isn't set up yet — pick one from the list";
}

/** Human summary of a destination for keypad cards + call-flow. */
export function describeDestination(type: DestinationType | "", ref: string, label?: string | null): string {
  if (label && label.trim()) return label.trim();
  if (type === "terminate") return "Hang up";
  if (type === "external_number") return `External ${ref}`;
  const t: DestinationType = type || "custom";
  const p = parseDestinationRef(t, ref);
  if (p.selected) return `${DESTINATION_TYPE_LABELS[t]} ${p.selected}`;
  return DESTINATION_TYPE_LABELS[t];
}
