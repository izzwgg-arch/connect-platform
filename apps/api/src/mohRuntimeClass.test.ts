import test from "node:test";
import assert from "node:assert/strict";
import {
  isAsteriskSafePbxFormat,
  isConnectMohRuntimeClass,
  isMohAssetPbxReady,
  isNativeMohRuntimeClass,
  isValidMohRuntimeClass,
  normalizeMohRuntimeClass,
  pickCanonicalTenantSlug,
} from "@connect/shared";

test("native mohN accepted", () => {
  assert.equal(isValidMohRuntimeClass("moh3"), true);
  assert.equal(isNativeMohRuntimeClass("MOH12"), true);
});

test("connect_* accepted", () => {
  assert.equal(isValidMohRuntimeClass("connect_acme_holiday_jazz"), true);
  assert.equal(isConnectMohRuntimeClass("CONNECT_TENANT_NAME"), true);
});

test("path traversal and unsafe chars rejected", () => {
  assert.equal(isValidMohRuntimeClass("../moh1"), false);
  assert.equal(isValidMohRuntimeClass("moh1/../x"), false);
  assert.equal(isValidMohRuntimeClass("connect_a;b"), false);
  assert.equal(isValidMohRuntimeClass("connect_a b"), false);
  assert.equal(isValidMohRuntimeClass("connect_a-b"), false);
});

test("arbitrary class names rejected", () => {
  assert.equal(isValidMohRuntimeClass("default"), false);
  assert.equal(isValidMohRuntimeClass("custom_class"), false);
});

test("normalizeMohRuntimeClass trims", () => {
  assert.equal(normalizeMohRuntimeClass("  moh2  "), "moh2");
});

// ── Asterisk-safe pbxFormat gate (publish-time MohAsset readiness check) ──
//
// This is the smallest, safest knob we use to block publish for legacy
// non-WAV uploads (where conversionStatus=ready but pbxFormat is null/legacy).
// The transcoder only emits "wav_pcm_s16le_8k_mono" today — anything that does
// not look like a wav_* variant is rejected on the same grounds the PBX media
// helper rejects it: it cannot mirror it into /var/lib/asterisk/moh/<class>/.
test("isAsteriskSafePbxFormat: accepts canonical wav variant", () => {
  assert.equal(isAsteriskSafePbxFormat("wav_pcm_s16le_8k_mono"), true);
  assert.equal(isAsteriskSafePbxFormat("WAV_PCM_S16LE_8K_MONO"), true);
});

test("isAsteriskSafePbxFormat: accepts forward-compat wav_* variants", () => {
  assert.equal(isAsteriskSafePbxFormat("wav_pcm_s16le_16k_mono"), true);
});

test("isAsteriskSafePbxFormat: rejects legacy / null / non-wav", () => {
  // Legacy non-WAV uploads (canary tenant Secro Selutions, 2026-05) had
  // conversionStatus="failed" with pbxFormat=null — publish must refuse.
  assert.equal(isAsteriskSafePbxFormat(null), false);
  assert.equal(isAsteriskSafePbxFormat(undefined), false);
  assert.equal(isAsteriskSafePbxFormat(""), false);
  assert.equal(isAsteriskSafePbxFormat("   "), false);
  assert.equal(isAsteriskSafePbxFormat("ulaw_8k_mono"), false);
  assert.equal(isAsteriskSafePbxFormat("sln16"), false);
  assert.equal(isAsteriskSafePbxFormat("mp3"), false);
  assert.equal(isAsteriskSafePbxFormat("opus"), false);
});

// ── MohAsset PBX-ready predicate (publish-time gate) ──
//
// The publish path uses isMohAssetPbxReady to fail with
// "connect_asset_not_pbx_ready" when any of the four invariants is missing.
// These cases were each observed in production at least once.
test("isMohAssetPbxReady: full ready row passes", () => {
  assert.equal(
    isMohAssetPbxReady({
      status: "ready",
      conversionStatus: "ready",
      pbxStorageKey: "tenants/acme/moh/connect_acme_jazz/asset.wav",
      pbxFormat: "wav_pcm_s16le_8k_mono",
    }),
    true,
  );
});

test("isMohAssetPbxReady: failed conversion blocks publish", () => {
  // Real canary: connect_secro_selution_new had conversionStatus="failed",
  // pbxStorageKey=null, pbxFormat=null. Old code allowed publish to claim
  // success while the helper had no file to mirror.
  assert.equal(
    isMohAssetPbxReady({
      status: "ready",
      conversionStatus: "failed",
      pbxStorageKey: null,
      pbxFormat: null,
    }),
    false,
  );
});

test("isMohAssetPbxReady: missing pbxStorageKey blocks publish", () => {
  assert.equal(
    isMohAssetPbxReady({
      status: "ready",
      conversionStatus: "ready",
      pbxStorageKey: null,
      pbxFormat: "wav_pcm_s16le_8k_mono",
    }),
    false,
  );
  assert.equal(
    isMohAssetPbxReady({
      status: "ready",
      conversionStatus: "ready",
      pbxStorageKey: "",
      pbxFormat: "wav_pcm_s16le_8k_mono",
    }),
    false,
  );
});

test("isMohAssetPbxReady: unsafe pbxFormat blocks publish", () => {
  assert.equal(
    isMohAssetPbxReady({
      status: "ready",
      conversionStatus: "ready",
      pbxStorageKey: "x.wav",
      pbxFormat: "ulaw_8k_mono",
    }),
    false,
  );
});

test("isMohAssetPbxReady: status != ready blocks publish", () => {
  assert.equal(
    isMohAssetPbxReady({
      status: "uploading",
      conversionStatus: "ready",
      pbxStorageKey: "x.wav",
      pbxFormat: "wav_pcm_s16le_8k_mono",
    }),
    false,
  );
});

test("isMohAssetPbxReady: null asset blocks publish", () => {
  assert.equal(isMohAssetPbxReady(null), false);
  assert.equal(isMohAssetPbxReady(undefined), false);
});

// ── Canonical tenant slug (must match API getIvrSlugForTenant) ──
//
// Slug drift between API and worker writes to AstDB caused dual-family
// writes for tenants whose PBX directory slug differs from Connect's
// Tenant.name slug. Both code paths now call pickCanonicalTenantSlug —
// PBX directory slug wins, Tenant.name is the fallback.
test("pickCanonicalTenantSlug: PBX directory slug wins over Tenant.name", () => {
  // Real canary: PBX directory slug "secro_selution" vs Tenant.name slug
  // "secro_selutions" — directory slug is the source of truth because
  // VitalPBX inbound routes / DID maps reference it at call time.
  assert.equal(
    pickCanonicalTenantSlug("secro_selution", "Secro Selutions", "tenant-id-123"),
    "secro_selution",
  );
});

test("pickCanonicalTenantSlug: falls back to Tenant.name slug when directory is empty", () => {
  assert.equal(pickCanonicalTenantSlug(null, "Acme Corp", "tenant-id"), "acme_corp");
  assert.equal(pickCanonicalTenantSlug("", "Acme Corp", "tenant-id"), "acme_corp");
  assert.equal(pickCanonicalTenantSlug("   ", "Acme Corp", "tenant-id"), "acme_corp");
});

test("pickCanonicalTenantSlug: falls back to tenantId when name is empty", () => {
  assert.equal(pickCanonicalTenantSlug(null, null, "tnt_42"), "tnt_42");
  assert.equal(pickCanonicalTenantSlug("", "", "tnt_42"), "tnt_42");
});

test("pickCanonicalTenantSlug: slugifies inputs (no spaces / punctuation in output)", () => {
  // Even if the directory slug arrives with spaces / punctuation, the result
  // must be safe for AstDB family names and shell paths.
  assert.equal(
    pickCanonicalTenantSlug("Acme Co!", "Acme Co", "tenant"),
    "acme_co",
  );
  assert.equal(
    pickCanonicalTenantSlug(null, "Hello, World!", "tenant"),
    "hello_world",
  );
});
