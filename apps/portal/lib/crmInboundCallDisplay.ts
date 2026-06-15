import type { LiveCall } from "../types/liveCall";

export type CrmInboundCallFields = {
  crmContactId?: string;
  crmContactName?: string;
  crmCompanyName?: string;
  crmProfileUrl?: string;
  crmMatchSource?: string;
};

function digitsOnly(raw: string): string {
  return raw.replace(/\D/g, "");
}

type CallerTenantLabelInput = {
  tenantName?: string | null;
  tenantId?: string | null;
  tenantSlug?: string | null;
};

type Token = { value: string; start: number; end: number };

const LEGAL_SUFFIX_ONLY = new Set(["INC", "LLC", "LTD", "CORP", "CORPORATION", "CO", "COMPANY"]);

function tokenizeLabel(value: string): Token[] {
  const tokens: Token[] = [];
  const re = /[A-Za-z0-9]+|[+&]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value)) !== null) {
    const raw = match[0]!;
    const normalized = raw === "+" ? "PLUS" : raw === "&" ? "AND" : raw.toUpperCase();
    tokens.push({ value: normalized, start: match.index, end: match.index + raw.length });
  }
  return tokens;
}

function tenantLabelCandidates(input: CallerTenantLabelInput): string[] {
  const raw = [input.tenantName, input.tenantSlug, input.tenantId]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const labels = new Set<string>();
  for (const value of raw) {
    const withoutPrefix = value.startsWith("vpbx:") ? value.slice(5) : value;
    labels.add(withoutPrefix);
    labels.add(withoutPrefix.replace(/[_-]+/g, " "));
  }
  return [...labels].filter((label) => tokenizeLabel(label).length > 0);
}

function stripLeadingTenantLabel(rawName: string, input: CallerTenantLabelInput): string | null {
  const nameTokens = tokenizeLabel(rawName);
  if (nameTokens.length === 0) return null;

  let bestCut = 0;
  for (const label of tenantLabelCandidates(input)) {
    const labelTokens = tokenizeLabel(label).map((token) => token.value);
    if (labelTokens.length === 0 || labelTokens.length > nameTokens.length) continue;
    const matches = labelTokens.every((token, index) => nameTokens[index]?.value === token);
    if (matches) bestCut = Math.max(bestCut, nameTokens[labelTokens.length - 1]!.end);
  }
  if (bestCut === 0) return rawName.trim() || null;

  const remainder = rawName.slice(bestCut).replace(/^[\s:|·,\-–—]+/, "").trim();
  if (!remainder) return null;
  const remainderTokens = tokenizeLabel(remainder).map((token) => token.value);
  if (remainderTokens.length > 0 && remainderTokens.every((token) => LEGAL_SUFFIX_ONLY.has(token))) {
    return null;
  }
  return remainder;
}

export function cleanIncomingCallerName(
  rawName: string | null | undefined,
  input: CallerTenantLabelInput = {},
): string | null {
  const trimmed = String(rawName || "").trim();
  if (!trimmed) return null;
  return stripLeadingTenantLabel(trimmed, input);
}

export function phonesLikelyMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const da = digitsOnly(a ?? "");
  const db = digitsOnly(b ?? "");
  if (!da || !db) return false;
  if (da === db) return true;
  if (da.length >= 10 && db.length >= 10 && da.slice(-10) === db.slice(-10)) return true;
  return false;
}

/** Prefer CRM lead name in Connect UI; PBX fromName is not overwritten on the wire. */
export function inboundCallerDisplayName(
  call: CrmInboundCallFields & { fromName?: string | null; from?: string | null; tenantName?: string | null; tenantId?: string | null; tenantSlug?: string | null },
  fallbackParty?: string | null,
): string {
  if (call.crmContactName?.trim()) return call.crmContactName.trim();
  const fromName = cleanIncomingCallerName(call.fromName, call);
  if (fromName) return fromName;
  return fallbackParty?.trim() || call.from?.trim() || "Unknown caller";
}

export function inboundCallerDisplayPhone(
  call: { from?: string | null },
  fallbackParty?: string | null,
): string {
  return call.from?.trim() || fallbackParty?.trim() || "";
}

export function findInboundLiveCallForParty(
  activeCalls: LiveCall[],
  party: string | null | undefined,
): LiveCall | null {
  if (!party?.trim()) return null;
  return (
    activeCalls.find(
      (c) =>
        c.direction === "inbound" &&
        (c.state === "ringing" || c.state === "dialing" || c.state === "up" || c.state === "held") &&
        phonesLikelyMatch(c.from, party),
    ) ?? null
  );
}

export function shouldShowCrmInboundQuickAction(
  call: CrmInboundCallFields & { direction?: string },
): boolean {
  return (
    call.direction === "inbound" &&
    !!call.crmContactId &&
    !!call.crmProfileUrl
  );
}

export function shouldShowCrmLiveWorkspaceShortcut(
  call: CrmInboundCallFields & { direction?: string; linkedId?: string | null },
): boolean {
  return (
    (call.direction === "inbound" || call.direction === "outbound") &&
    !!call.crmContactId
  );
}

export function buildCrmContactWorkspaceHref(
  call: CrmInboundCallFields & { linkedId?: string | null },
): string | null {
  if (!call.crmContactId) return null;
  const params = new URLSearchParams({ workspace: "timeline" });
  if (call.linkedId?.trim()) params.set("linkedId", call.linkedId.trim());
  return `/crm/contacts/${encodeURIComponent(call.crmContactId)}?${params.toString()}`;
}

export function buildCrmLiveWorkspaceHref(
  call: CrmInboundCallFields & { linkedId?: string | null; from?: string | null },
): string | null {
  if (!call.crmContactId) return null;
  const params = new URLSearchParams({ contactId: call.crmContactId });
  if (call.linkedId?.trim()) params.set("linkedId", call.linkedId.trim());
  if (call.from?.trim()) params.set("from", call.from.trim());
  return `/crm/live-call?${params.toString()}`;
}
