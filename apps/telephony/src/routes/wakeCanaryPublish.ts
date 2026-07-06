// Pure request-shape validation for POST /telephony/internal/wake-canary-publish.
// Extracted from telephony.ts (same pattern as dndPublish.ts) so the validation
// contract — which AstDB families/keys can EVER be produced, and which values are
// accepted — is unit-testable without booting express or an AMI connection.
//
// This route writes ONLY the four Connect-owned wake-canary AstDB families that
// scripts/pbx/wake-canary-reconcile.mjs already owns and that [connect-wake-core]
// / the T<id>_cos-all overlay read:
//   connect/wake_canary/T<pbxTenantId>_<extension>            = "1"  (enable) | deleted (disable)
//   connect/wake_canary_owner/T<pbxTenantId>_<extension>      = "connect-mobile"
//   connect/wake_canary_source/T<pbxTenantId>_<extension>     = "mobile-provisioning"
//   connect/wake_canary_updated_at/T<pbxTenantId>_<extension> = <unix epoch seconds>
//
// Like dnd-publish, there is deliberately NO generic "family"/"key" input:
// pbxTenantId and extension are validated independently as bare digit strings and
// the AstDB key is assembled server-side, so no caller input can ever select a
// different family or smuggle a path-like key (e.g. "../connect/system"). This is
// what keeps the autonomous worker strictly in its own lane: it can only ever
// touch the wake_canary key space, never any other PBX runtime key.

export const WAKE_CANARY_FAMILY = "connect/wake_canary";
export const WAKE_CANARY_OWNER_FAMILY = "connect/wake_canary_owner";
export const WAKE_CANARY_SOURCE_FAMILY = "connect/wake_canary_source";
export const WAKE_CANARY_UPDATED_FAMILY = "connect/wake_canary_updated_at";
export const WAKE_CANARY_OWNER_VALUE = "connect-mobile";
export const WAKE_CANARY_SOURCE_VALUE = "mobile-provisioning";

export type WakeCanaryPublishParsed = {
  ok: true;
  pbxTenantId: string;
  extension: string;
  enable: "0" | "1";
  ts: string;
  /** The AstDB key shared by all four wake_canary families. */
  key: string;
};

export type WakeCanaryPublishRejected = {
  ok: false;
  error:
    | "invalid_pbx_tenant_id"
    | "invalid_extension"
    | "invalid_enable_value"
    | "invalid_timestamp";
};

const NUMERIC_ID_RE = /^\d{1,10}$/;
const TIMESTAMP_RE = /^\d{1,20}$/;

export function parseWakeCanaryPublishRequest(
  body: unknown,
): WakeCanaryPublishParsed | WakeCanaryPublishRejected {
  const b = (body ?? {}) as Record<string, unknown>;
  const { pbxTenantId, extension, enable, ts } = b;

  if (typeof pbxTenantId !== "string" || !NUMERIC_ID_RE.test(pbxTenantId)) {
    return { ok: false, error: "invalid_pbx_tenant_id" };
  }
  if (typeof extension !== "string" || !NUMERIC_ID_RE.test(extension)) {
    return { ok: false, error: "invalid_extension" };
  }
  if (enable !== "0" && enable !== "1") {
    return { ok: false, error: "invalid_enable_value" };
  }
  if (typeof ts !== "string" || !TIMESTAMP_RE.test(ts)) {
    return { ok: false, error: "invalid_timestamp" };
  }

  return {
    ok: true,
    pbxTenantId,
    extension,
    enable,
    ts,
    key: `T${pbxTenantId}_${extension}`,
  };
}

export type WakeCanaryKeyWrite =
  | { op: "put"; family: string; key: string; value: string }
  | { op: "del"; family: string; key: string };

/**
 * Pure: expand a parsed request into the exact ordered AstDB mutations.
 * enable="1" → put all four families. enable="0" → delete all four families.
 * The value-family write is ordered first on enable so the control key exists
 * before the ownership metadata, and deleted first on disable so the extension
 * loses wake immediately even if a later metadata delete fails.
 */
export function buildWakeCanaryKeyWrites(
  parsed: WakeCanaryPublishParsed,
): WakeCanaryKeyWrite[] {
  const { key, enable, ts } = parsed;
  if (enable === "1") {
    return [
      { op: "put", family: WAKE_CANARY_FAMILY, key, value: "1" },
      { op: "put", family: WAKE_CANARY_OWNER_FAMILY, key, value: WAKE_CANARY_OWNER_VALUE },
      { op: "put", family: WAKE_CANARY_SOURCE_FAMILY, key, value: WAKE_CANARY_SOURCE_VALUE },
      { op: "put", family: WAKE_CANARY_UPDATED_FAMILY, key, value: ts },
    ];
  }
  return [
    { op: "del", family: WAKE_CANARY_FAMILY, key },
    { op: "del", family: WAKE_CANARY_OWNER_FAMILY, key },
    { op: "del", family: WAKE_CANARY_SOURCE_FAMILY, key },
    { op: "del", family: WAKE_CANARY_UPDATED_FAMILY, key },
  ];
}
