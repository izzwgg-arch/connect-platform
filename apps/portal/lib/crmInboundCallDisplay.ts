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
  call: CrmInboundCallFields & { fromName?: string | null; from?: string | null },
  fallbackParty?: string | null,
): string {
  if (call.crmContactName?.trim()) return call.crmContactName.trim();
  if (call.fromName?.trim()) return call.fromName.trim();
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
