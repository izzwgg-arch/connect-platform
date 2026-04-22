/**
 * Single authoritative call direction policy for ConnectCdr (incoming / outgoing / internal).
 * PBX routing evidence (dcontext + channel names) first; number heuristics are fallback only.
 *
 * Rules (business):
 * 1) If the logical call touched an outbound trunk / outbound dial route → outgoing
 * 2) Else if the call entered from external / PSTN / inbound trunk path → incoming
 * 3) Else → internal
 *
 * "Missed" is disposition (incoming + not answered), not a direction value.
 */

export type ConnectCallDirection = "incoming" | "outgoing" | "internal" | "unknown";

function digitsOnly(s: string | null | undefined): string {
  if (!s) return "";
  const d = s.replace(/\D/g, "");
  return /^1\d{10}$/.test(d) ? d.slice(1) : d;
}

function isExtension(digits: string): boolean {
  return digits.length >= 2 && digits.length <= 6;
}

function isExternal(digits: string): boolean {
  return digits.length >= 10 && digits.length <= 15;
}

/** Outbound trunk / dial-route evidence in dialplan context */
export function contextSuggestsOutboundTrunk(dcontext: string, toDigits: string): boolean {
  const d = dcontext.toLowerCase();
  if (/^trk-[^-]+-dial/.test(d)) return true;
  if (d.includes("outbound")) return true;
  if (
    d.includes("from-internal") ||
    d.includes("ext-local") ||
    /^t\d+_cos-/.test(d) ||
    d.includes("sub-local-dialing")
  ) {
    if (isExtension(toDigits)) return false;
    if (isExternal(toDigits)) return true;
    return true;
  }
  return false;
}

/** PBX user-originated context dialing another extension (no PSTN trunk on this leg). */
function contextSuggestsInternalExtensionDest(dcontext: string, toDigits: string, fromDigits: string): boolean {
  const d = dcontext.toLowerCase();
  const pbxUser =
    d.includes("ext-local") ||
    d.includes("from-internal") ||
    /^t\d+_cos-/.test(d) ||
    d.includes("sub-local-dialing");
  if (!pbxUser) return false;
  if (!isExtension(toDigits)) return false;
  if (isExtension(fromDigits)) return true;
  if (!fromDigits) return true;
  if (isExternal(fromDigits)) return true;
  return false;
}

/** Inbound / PSTN entry evidence */
export function contextSuggestsInboundEntry(dcontext: string): boolean {
  const d = dcontext.toLowerCase();
  return (
    d.includes("from-trunk") ||
    d.includes("from-pstn") ||
    d.includes("from-external") ||
    d.includes("inbound") ||
    /^ivr-\d/.test(d) ||
    /^trk-[^-]+-in/.test(d) ||
    d.includes("app-ivr") ||
    d.includes("incoming-calls") ||
    d.includes("default-trunk")
  );
}

function channelSuggestsOutboundTrunk(channel: string): boolean {
  const c = channel.toLowerCase();
  if (c.includes("trk-") && c.includes("dial")) return true;
  if (/^local\/.*;2$/i.test(channel) && c.includes("outbound")) return true;
  return false;
}

/**
 * VitalPBX ring-group / queue distribution channels — indicate an inbound call being
 * routed to extensions via a ring group or ACD queue.
 *
 * Patterns:
 *   Local/{ext}@T{n}_ring-group-dial-{hex}[;n]  — ring-group leg ringing an extension
 *   Local/{ext}@T{n}_queue-{anything}            — queue leg distributing to an agent
 *
 * These Local channels are created when VitalPBX distributes an inbound call to
 * individual extensions, so their presence is strong evidence that this linkedId
 * belongs to an inbound call.
 */
function channelSuggestsInboundDistribution(channel: string): boolean {
  if (/^Local\/\d{2,6}@T\d+_ring-group-dial-/i.test(channel)) return true;
  if (/^Local\/\d{2,6}@T\d+_queue-/i.test(channel)) return true;
  return false;
}

export type CallDirectionEvidenceInput = {
  /** All AMI Cdr Destination Context values observed for this linkedid */
  dcontexts: string[];
  /** Channel names (PJSIP/..., Local/..., etc.) */
  channelNames: string[];
  fromNumber?: string | null;
  toNumber?: string | null;
  /** Legacy telephony hint (inbound|outbound|internal|unknown) — lowest priority */
  telephonyDirectionHint?: string | null;
};

function hintToConnect(hint: string | null | undefined): ConnectCallDirection | null {
  const h = String(hint || "").toLowerCase();
  if (h === "inbound") return "incoming";
  if (h === "outbound") return "outgoing";
  if (h === "internal") return "internal";
  if (h === "incoming") return "incoming";
  if (h === "outgoing") return "outgoing";
  return null;
}

/**
 * Classify direction from accumulated PBX evidence for one logical call.
 */
export function classifyCallDirectionByEvidence(input: CallDirectionEvidenceInput): ConnectCallDirection {
  const toDigits = digitsOnly(input.toNumber);
  const fromDigits = digitsOnly(input.fromNumber);

  let sawOutbound = false;
  let sawInbound = false;

  const dcx = input.dcontexts.map((s) => String(s || "").trim()).filter(Boolean);
  for (const dc of dcx) {
    if (contextSuggestsOutboundTrunk(dc, toDigits)) sawOutbound = true;
    if (contextSuggestsInboundEntry(dc)) sawInbound = true;
  }

  for (const ch of input.channelNames) {
    if (channelSuggestsOutboundTrunk(ch)) sawOutbound = true;
    if (channelSuggestsInboundDistribution(ch)) sawInbound = true;
  }

  if (sawOutbound) return "outgoing";
  if (sawInbound) return "incoming";

  if (dcx.some((dc) => contextSuggestsInternalExtensionDest(dc, toDigits, fromDigits))) return "internal";

  if (fromDigits || toDigits) {
    if (isExtension(fromDigits) && isExternal(toDigits)) return "outgoing";
    if (isExternal(fromDigits) && isExtension(toDigits)) return "incoming";
    // Partial PSTN dial: extension originated, destination is 5–6 digits (user started
    // dialing a 10-digit PSTN number but hung up after the area code or first few digits).
    // These are NOT internal calls — real extensions are ≤4 digits on this system.
    // Classify as outgoing (canceled) rather than internal.
    if (fromDigits.length >= 2 && fromDigits.length <= 4 && toDigits.length >= 5 && toDigits.length <= 6) return "outgoing";
    if (isExtension(fromDigits) && isExtension(toDigits)) return "internal";
    // Extension dialing a local 7–9 digit number: PBX may not have expanded the number
    // to a full 10-digit PSTN number yet (e.g. 106 → 2224034 → PBX expands to 8452224034).
    // Treat as outgoing — never classify an extension-originated call as incoming.
    if (isExtension(fromDigits) && toDigits.length >= 7 && toDigits.length <= 9) return "outgoing";
  }

  const fromHint = hintToConnect(input.telephonyDirectionHint);
  if (fromHint && fromHint !== "unknown") return fromHint;

  return "unknown";
}

/** Map Connect Cdr direction to telephony live-call direction */
export function connectDirectionToTelephony(
  d: ConnectCallDirection,
): "inbound" | "outbound" | "internal" | "unknown" {
  if (d === "incoming") return "inbound";
  if (d === "outgoing") return "outbound";
  if (d === "internal") return "internal";
  return "unknown";
}
