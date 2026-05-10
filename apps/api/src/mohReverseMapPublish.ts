// ============================================================================
// MOH reverse tenant-map publish.
//
// The Connect tenant MOH enforcement layer (PBX-side
// `extensions__65_connect_tenant_moh.conf`, installed by
// `scripts/pbx/install-connect-tenant-moh-dialplan.sh`) needs to recover
// the canonical Connect tenant slug from the numeric VitalPBX tenant id
// it can read off PJSIP endpoint prefixes like `T3_302` on outbound /
// internal / bridge legs. To do that without per-tenant dialplan edits,
// the resolver reads two AstDB keys:
//
//   connect/pbx_tenant_map/<pbxTenantId>/slug      → tenant slug
//   connect/pbx_tenant_map/<pbxTenantId>/moh_class → effective MOH class
//
// This module owns building those keys and the small "evidence" envelope
// that gets attached to `MohPublishRecord.nativeSync.tenantMohEnforcement`.
// HTTP delivery is whatever the caller passes as `publish` — server.ts
// reuses its existing `publishMohToAstDb` so all AstDB writes flow through
// the same telephony service path and the same retry/backoff semantics.
//
// Best-effort by design: the calling MOH publish path MUST NOT fail just
// because the reverse map could not be written. The dialplan resolver
// fails safely back to existing PBX behavior on a missing key (bare
// `Return()` with no Set on `CHANNEL(musicclass)`).
// ============================================================================

export type TenantMohReverseMapInput = {
  /** Numeric VitalPBX tenant id from `TenantPbxLink.pbxTenantId`. May be
   *  null/empty if the tenant has not been linked yet — in that case no
   *  keys are emitted and the evidence reports `tenant_pbx_link_missing`. */
  pbxTenantId: string | null | undefined;
  /** Canonical AstDB slug already used for `connect/t_<slug>/...`. */
  canonicalSlug: string;
  /** Effective MOH class string (e.g. `moh8` or `connect_acme_jazz`). */
  mohClass: string;
};

export type TenantMohReverseMapKey = {
  family: string;
  key: "slug" | "moh_class";
  value: string;
};

export type TenantMohEnforcementEvidence = {
  /** True iff `publish(keys)` resolved without throwing. */
  reverseMapPublished: boolean;
  /** Echoed from input, normalized to null when missing/non-numeric. */
  pbxTenantId: string | null;
  /** Echoed from input. */
  canonicalSlug: string;
  /** Echoed from input. */
  mohClass: string;
  /** Set when `reverseMapPublished=false`. Helpful for forensic queries that
   *  ask "why didn't the resolver pick up this tenant?" without rerunning
   *  the publish path. */
  reason?: string;
};

/**
 * Matches the Connect API's existing pbx_tenant_id validation
 * (`/^\d{1,10}$/`). VitalPBX numeric tenant ids fit comfortably in 10
 * digits (it's an unsigned int in `ombu_tenants`). Reject anything else
 * so we never write `connect/pbx_tenant_map/foo` keys that would shadow
 * a future numeric reuse.
 */
const PBX_TENANT_ID_PATTERN = /^\d{1,10}$/;

/**
 * Build the AstDB key/value pairs the resolver dialplan reads. Returns an
 * empty array when `pbxTenantId` is missing or non-numeric — the caller
 * should treat that as "skip publish" and surface the reason in evidence.
 */
export function buildTenantMohReverseMapKeys(
  input: TenantMohReverseMapInput,
): TenantMohReverseMapKey[] {
  const pbxTenantId = String(input.pbxTenantId ?? "").trim();
  if (!PBX_TENANT_ID_PATTERN.test(pbxTenantId)) return [];
  const family = `connect/pbx_tenant_map/${pbxTenantId}`;
  return [
    { family, key: "slug", value: input.canonicalSlug },
    { family, key: "moh_class", value: input.mohClass },
  ];
}

/**
 * Best-effort publish of the reverse tenant map. Never throws. Returns
 * structured evidence the caller attaches to
 * `MohPublishRecord.nativeSync.tenantMohEnforcement`.
 *
 * @param input data to publish (caller supplies the slug + class it just published)
 * @param publish function that performs the AstDB write — typically a closure over server.ts's `publishMohToAstDb(slug, keys)`
 */
export async function publishTenantMohReverseMap(
  input: TenantMohReverseMapInput,
  publish: (keys: TenantMohReverseMapKey[]) => Promise<void>,
): Promise<TenantMohEnforcementEvidence> {
  const pbxTenantId = String(input.pbxTenantId ?? "").trim();
  const evidence: TenantMohEnforcementEvidence = {
    reverseMapPublished: false,
    pbxTenantId: pbxTenantId || null,
    canonicalSlug: input.canonicalSlug,
    mohClass: input.mohClass,
  };
  const keys = buildTenantMohReverseMapKeys(input);
  if (keys.length === 0) {
    evidence.reason = pbxTenantId
      ? `non_numeric_pbx_tenant_id:${pbxTenantId.slice(0, 32)}`
      : "tenant_pbx_link_missing";
    return evidence;
  }
  try {
    await publish(keys);
    evidence.reverseMapPublished = true;
    return evidence;
  } catch (err: any) {
    const msg = (err?.message || String(err)).slice(0, 200);
    evidence.reason = `reverse_map_publish_failed:${msg}`;
    return evidence;
  }
}
