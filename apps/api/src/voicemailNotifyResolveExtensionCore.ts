/**
 * Pure logic: choose exactly one Extension row for AMI voicemail notify when
 * multiple Connect tenants share the same mailbox digit string.
 */
export function chooseExtensionForVoicemailNotify<T extends { tenantId: string }>(
  candidates: T[],
  contextRaw: string,
  tenantMatchesVoicemailContext: (tenantId: string) => boolean,
): { choice: T | null; reason: string } {
  if (candidates.length === 0) return { choice: null, reason: "no_active_extension_for_mailbox" };
  if (candidates.length === 1) return { choice: candidates[0]!, reason: "unique_mailbox_across_tenants" };

  const ctx = String(contextRaw ?? "").trim().toLowerCase();
  const matched = candidates.filter((c) => tenantMatchesVoicemailContext(c.tenantId));

  if (matched.length === 1) return { choice: matched[0]!, reason: "disambiguated_by_voicemail_context" };
  if (matched.length > 1) return { choice: null, reason: "ambiguous_multiple_context_matches" };

  // No directory match — refuse to guess (prevents cross-tenant ingest + push).
  if (ctx === "default" || ctx === "") {
    return { choice: null, reason: "ambiguous_default_context_duplicate_mailbox" };
  }
  return { choice: null, reason: "no_tenant_matches_voicemail_context" };
}
