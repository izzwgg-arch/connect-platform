import type { Voicemail } from "../types";

let lastMobileVoicemailScopeKey: string | null = null;

/**
 * True when `scopeKey` (from `voicemailQueryUserScope`) changed vs last run — clear in-memory rows.
 * Survives Voicemail tab unmount so switching tabs does not wipe the list.
 */
export function consumeVoicemailScopeKeyChange(scopeKey: string | null): boolean {
  if (scopeKey == null || scopeKey === "_") {
    const had = lastMobileVoicemailScopeKey != null;
    lastMobileVoicemailScopeKey = null;
    return had;
  }
  if (lastMobileVoicemailScopeKey !== scopeKey) {
    lastMobileVoicemailScopeKey = scopeKey;
    return true;
  }
  return false;
}

export function resetVoicemailScopeKeyGateForTests() {
  lastMobileVoicemailScopeKey = null;
}

/** Fast stable fingerprint so a new login/token rotation gets a fresh React Query partition. */
export function voicemailTokenSessionKey(token: string | null | undefined): string {
  if (!token) return "_";
  let h = 0x811c9dc5;
  const s = String(token);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export type VoicemailApiScopeMeta = {
  voicemailScopeVersion?: string;
  scopedMailboxesForUser?: string[] | null;
};

/** Prefer JSON body; headers are fallback for older responses. */
export function mergeVoicemailScopeMeta(
  json: VoicemailApiScopeMeta | undefined,
  headerVersion: string | null,
  headerMailboxes: string | null,
): VoicemailApiScopeMeta {
  const fromHeaderMb =
    headerMailboxes && headerMailboxes.trim().length > 0
      ? headerMailboxes.split(",").map((x) => x.trim()).filter(Boolean)
      : undefined;
  return {
    voicemailScopeVersion: json?.voicemailScopeVersion ?? headerVersion ?? undefined,
    scopedMailboxesForUser: json?.scopedMailboxesForUser ?? fromHeaderMb ?? undefined,
  };
}

/**
 * Drop rows not in API-declared mailbox allowlist when scope is contained-owned.
 * If server omits scope, pass through (trust JSON); if empty allowlist under contained-owned, drop all.
 */
export function filterVoicemailsToScopedMailboxes(
  vms: Voicemail[],
  meta: VoicemailApiScopeMeta | undefined,
): Voicemail[] {
  if (!meta?.voicemailScopeVersion || meta.voicemailScopeVersion !== "contained-owned") {
    return vms;
  }
  const allow = meta.scopedMailboxesForUser;
  if (!allow || allow.length === 0) return [];
  const allowSet = new Set(allow.map((x) => String(x).trim()).filter(Boolean));
  return vms.filter((v) => allowSet.has(String(v.extension || "").trim()));
}

export function distinctExtensionsFromVoicemails(vms: Voicemail[]): string[] {
  return [...new Set(vms.map((v) => String(v.extension || "").trim()).filter(Boolean))];
}

export function voicemailIdsSample(vms: Voicemail[], n = 5): string[] {
  return vms.slice(0, n).map((v) => v.id);
}
