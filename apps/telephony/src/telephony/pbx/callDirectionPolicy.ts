/**
 * Mirror of packages/integrations/src/vitalpbx/callDirectionPolicy.ts — keep in sync.
 * Duplicated here so telephony can compile without pulling integrations into its rootDir.
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

export type CallDirectionEvidenceInput = {
  dcontexts: string[];
  channelNames: string[];
  fromNumber?: string | null;
  toNumber?: string | null;
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
  }

  if (sawOutbound) return "outgoing";
  if (sawInbound) return "incoming";

  if (dcx.some((dc) => contextSuggestsInternalExtensionDest(dc, toDigits, fromDigits))) return "internal";

  if (fromDigits || toDigits) {
    if (isExtension(fromDigits) && isExternal(toDigits)) return "outgoing";
    if (isExternal(fromDigits) && isExtension(toDigits)) return "incoming";
    if (isExtension(fromDigits) && isExtension(toDigits)) return "internal";
  }

  const fromHint = hintToConnect(input.telephonyDirectionHint);
  if (fromHint && fromHint !== "unknown") return fromHint;

  return "unknown";
}

export function connectDirectionToTelephony(
  d: ConnectCallDirection,
): "inbound" | "outbound" | "internal" | "unknown" {
  if (d === "incoming") return "inbound";
  if (d === "outgoing") return "outbound";
  if (d === "internal") return "internal";
  return "unknown";
}
