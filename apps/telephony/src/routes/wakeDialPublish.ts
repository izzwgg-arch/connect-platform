// Pure request-shape validation + dial-string transform for
// POST /telephony/internal/wake-dial-publish.
//
// This route owns the SECOND half of mobile wake-and-wait enrollment. The first
// half (wake-canary-publish) flips the [connect-wake-core] allowlist key; this
// half rewrites the extension's AstDB `dial` string so calls arriving on the
// NATIVE VitalPBX paths (DID -> VitalPBX IVR -> extension, ring groups, direct
// dials) route the extension's MOBILE leg through [connect-mobile-wake-dial]
// instead of dialling the PJSIP contacts directly:
//
//   PJSIP/T5_101&PJSIP/T5_101_1
//     -> PJSIP/T5_101&Local/T5_101_1@connect-mobile-wake-dial/n
//
// Without this, PJSIP_DIAL_CONTACTS() resolves ONCE at dial time; a sleeping
// app has no contacts, the dial fails in milliseconds with cause 3, and the
// caller is in voicemail before the wake push can possibly land (proven on
// Luxure T5_101, 2026-07-30, and fixed by hand there 2026-07-31).
//
// Same closed-scope model as wake-canary-publish / dnd-publish: the caller
// supplies ONLY numeric pbxTenantId + extension. The mobile endpoint name and
// the wake context are assembled server-side; the transform touches ONLY the
// exact mobile-leg token `PJSIP/T<tid>_<ext>_1` (or its already-enrolled Local
// form) and fails closed on anything unexpected, so no caller input — and no
// surprising dial-string shape — can ever produce a write outside this lane.
//
// The tenant's AstDB family hash (e.g. "da5327df4a24f3a8") is DISCOVERED per
// request from the read-only CLI command `database showkey dial` (a constant
// string, run over the AMI Command action): the one dial key whose value
// carries this extension's mobile-leg token identifies its family. Requiring
// exactly one match fails closed on any ambiguity, and no mapping state has to
// be seeded or maintained on the PBX.

export const WAKE_DIAL_CONTEXT = "connect-mobile-wake-dial";
export const DIAL_DISCOVERY_CLI = "database showkey dial";

const NUMERIC_ID_RE = /^\d{1,10}$/;
/** VitalPBX tenant AstDB family hashes are lowercase hex (observed 16 chars;
 *  accept 8-32 to be safe). Anything else is refused outright. */
const TENANT_HASH_RE = /^[0-9a-f]{8,32}$/;
/** Charset a sane dial-string leg can contain. A leg outside this alphabet
 *  means the dial string is not something we understand — fail closed. */
const SAFE_LEG_RE = /^[A-Za-z0-9_@/.:+*#-]+$/;

export type WakeDialPublishParsed = {
  ok: true;
  pbxTenantId: string;
  extension: string;
  enable: "0" | "1";
  /** PJSIP endpoint name of the extension's mobile leg, e.g. "T5_101_1". */
  mobileEndpoint: string;
};

export type WakeDialPublishRejected = {
  ok: false;
  error: "invalid_pbx_tenant_id" | "invalid_extension" | "invalid_enable_value";
};

export function parseWakeDialPublishRequest(
  body: unknown,
): WakeDialPublishParsed | WakeDialPublishRejected {
  const b = (body ?? {}) as Record<string, unknown>;
  const { pbxTenantId, extension, enable } = b;

  if (typeof pbxTenantId !== "string" || !NUMERIC_ID_RE.test(pbxTenantId)) {
    return { ok: false, error: "invalid_pbx_tenant_id" };
  }
  if (typeof extension !== "string" || !NUMERIC_ID_RE.test(extension)) {
    return { ok: false, error: "invalid_extension" };
  }
  if (enable !== "0" && enable !== "1") {
    return { ok: false, error: "invalid_enable_value" };
  }
  return {
    ok: true,
    pbxTenantId,
    extension,
    enable,
    mobileEndpoint: `T${pbxTenantId}_${extension}_1`,
  };
}

export function isValidTenantHash(value: unknown): value is string {
  return typeof value === "string" && TENANT_HASH_RE.test(value.trim());
}

export type DialKeyDiscovery =
  | { ok: true; tenantHash: string; family: string }
  | { ok: false; error: "extension_not_enrollable" | "ambiguous_extension" };

/** One parsed `/hash/extensions/<ext>/dial : <value>` line of showkey output. */
const SHOWKEY_LINE_RE = /^\/([0-9a-f]{8,32})\/extensions\/(\d{1,10})\/dial\s*: (.*?)\s*$/;

/**
 * Pure: locate the AstDB family for an extension's dial key in the output of
 * `database showkey dial`. The match is by CONTENT, not position: the line must
 * be for the requested extension number AND its value must contain the
 * extension's mobile leg in either form (raw PJSIP or already-enrolled Local).
 * Exactly one line may qualify; zero means the extension has no enrollable
 * mobile leg anywhere (desk-only, deleted tenant, never provisioned), more than
 * one is an ambiguity we refuse to guess about.
 */
export function discoverDialKeyFamily(
  showkeyOutput: string,
  extension: string,
  mobileEndpoint: string,
): DialKeyDiscovery {
  const pjsipForm = `PJSIP/${mobileEndpoint}`;
  const localForm = `Local/${mobileEndpoint}@${WAKE_DIAL_CONTEXT}/n`;
  const matches: string[] = [];
  for (const line of (showkeyOutput ?? "").split("\n")) {
    const m = SHOWKEY_LINE_RE.exec(line.trim());
    if (!m) continue;
    const [, hash, ext, value] = m;
    if (ext !== extension) continue;
    const legs = value.split("&").map((l) => l.trim());
    if (legs.includes(pjsipForm) || legs.includes(localForm)) matches.push(hash);
  }
  if (matches.length === 1) {
    return { ok: true, tenantHash: matches[0], family: `${matches[0]}/extensions/${extension}` };
  }
  return { ok: false, error: matches.length === 0 ? "extension_not_enrollable" : "ambiguous_extension" };
}

export type DialTransformResult =
  | { ok: true; changed: boolean; value: string }
  | {
      ok: false;
      error: "empty_dial_value" | "unexpected_dial_value" | "no_mobile_leg";
      /** Which leg failed the charset check, when applicable. */
      leg?: string;
    };

/**
 * Pure: rewrite ONLY the mobile leg of an extension's dial string.
 *
 * enable="1": `PJSIP/<ep>` -> `Local/<ep>@connect-mobile-wake-dial/n`
 * enable="0": the reverse.
 *
 * Guarantees:
 *  - every other leg is preserved byte-for-byte, in order;
 *  - already-in-desired-state returns { changed: false } (idempotent — the
 *    autonomous worker re-asserts every cycle, and a panel edit that reverted
 *    the key simply gets re-enrolled on the next pass);
 *  - a dial string containing NO mobile leg in either form, or any leg with
 *    unexpected characters, is refused without modification.
 */
export function transformDialValue(
  current: string,
  mobileEndpoint: string,
  enable: "0" | "1",
): DialTransformResult {
  const trimmed = (current ?? "").trim();
  if (!trimmed) return { ok: false, error: "empty_dial_value" };

  const pjsipForm = `PJSIP/${mobileEndpoint}`;
  const localForm = `Local/${mobileEndpoint}@${WAKE_DIAL_CONTEXT}/n`;
  const wanted = enable === "1" ? localForm : pjsipForm;
  const other = enable === "1" ? pjsipForm : localForm;

  const legs = trimmed.split("&").map((l) => l.trim());
  for (const leg of legs) {
    if (!leg || !SAFE_LEG_RE.test(leg)) {
      return { ok: false, error: "unexpected_dial_value", leg };
    }
  }

  if (!legs.includes(other) && !legs.includes(wanted)) {
    return { ok: false, error: "no_mobile_leg" };
  }

  // Replace the undesired form with the desired one in place; if both forms
  // are somehow present, collapse them to a single desired leg.
  const next: string[] = [];
  for (const leg of legs) {
    const mapped = leg === other ? wanted : leg;
    if (mapped === wanted && next.includes(wanted)) continue;
    next.push(mapped);
  }
  const value = next.join("&");
  return { ok: true, changed: value !== legs.join("&"), value };
}
