/**
 * The owning PBX tenant code Asterisk stamps into the call itself —
 * dcontext `T102_cos-all`, channel `PJSIP/T102_101_1-0000abcd`,
 * `Local/111@T8_queue-call-to-agents-00009ffb;1`.
 *
 * Added 2026-08-02 after a confirmed CROSS-TENANT LEAK: calls were labelled with
 * the wrong company and written into other tenants' call history — 116 records
 * in 7 days across 11 customers. This service produced those labels and could
 * not read this marker at all; its resolver only understood slug-style contexts
 * (`ext-local-a_plus_center`). The strongest and only unforgeable ownership
 * signal on a call was invisible to the code doing the labelling, which instead
 * guessed from whichever weak leg happened to arrive first.
 *
 * Pure and dependency-free so it is unit-testable without booting the service.
 *
 * Returns null on CONFLICTING markers — a call whose legs disagree about who
 * owns it must never be silently assigned to one of them. Null means "no
 * verdict", and the caller falls back to weaker evidence.
 */
export function extractPbxTenantCodeFromCallFields(
  ...values: Array<string | null | undefined>
): string | null {
  const found = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0) continue;
    const re = /(?:^|[^A-Za-z0-9])(T\d+)_/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(value)) !== null) found.add(m[1]!.toUpperCase());
  }
  if (found.size !== 1) return null;
  return [...found][0]!;
}
