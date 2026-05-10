/**
 * Validates Asterisk/VitalPBX MOH runtime class strings used in profiles,
 * schedules, AstDB, and PBX sync — blocks path traversal, shell metacharacters,
 * and arbitrary class names. Only native `mohN` or Connect uploads `connect_*`.
 */

const NATIVE_RE = /^moh\d+$/i;
const CONNECT_RE = /^connect_[a-z0-9_]+$/i;
/** Allowed identifier charset after normalization (no spaces, slashes, shell meta). */
const SAFE_SEGMENT_RE = /^[a-zA-Z0-9_]+$/;

export function normalizeMohRuntimeClass(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

export function isNativeMohRuntimeClass(value: string): boolean {
  const v = normalizeMohRuntimeClass(value);
  return SAFE_SEGMENT_RE.test(v) && NATIVE_RE.test(v);
}

export function isConnectMohRuntimeClass(value: string): boolean {
  const v = normalizeMohRuntimeClass(value);
  return SAFE_SEGMENT_RE.test(v) && CONNECT_RE.test(v);
}

/** True only for `moh1`…`mohN` or `connect_<tenantSlug>_<name>` style classes. */
export function isValidMohRuntimeClass(value: string | null | undefined): boolean {
  const v = normalizeMohRuntimeClass(value);
  if (!v) return false;
  if (/[\s\\/]/.test(v)) return false;
  if (v.includes("..")) return false;
  if (!SAFE_SEGMENT_RE.test(v)) return false;
  return isNativeMohRuntimeClass(v) || isConnectMohRuntimeClass(v);
}

/**
 * True only for `MohAsset.pbxFormat` values that the PBX sync helper can safely
 * mirror into `/var/lib/asterisk/moh/<class>/asset.wav` and that Asterisk can
 * decode without re-transcoding. The transcoder in `apps/api/src/mohStorage.ts`
 * currently only writes `wav_pcm_s16le_8k_mono`, but accepting any `wav_*`
 * keeps this gate forward-compatible without rewriting it whenever a new
 * transcoded variant is introduced. ulaw/sln/mp3/opus are rejected — Connect
 * does not produce them today, so they would indicate a malformed / legacy row.
 *
 * Used as the publish-time gate so we never write `connect/t_<slug>/moh_class`
 * pointing at a class whose backing file the helper will refuse to mirror.
 */
export function isAsteriskSafePbxFormat(format: string | null | undefined): boolean {
  const v = String(format ?? "").trim().toLowerCase();
  if (!v) return false;
  return v.startsWith("wav_");
}

/**
 * Pure predicate combining all four MohAsset gates the publish path enforces
 * for `connect_*` runtime classes. Centralised here so the API readiness
 * evaluator and any future caller agree on the exact "PBX-ready" definition.
 *
 * Returns false for legacy / failed conversions, missing artifacts, or any
 * unsafe pbxFormat. A `false` result corresponds to the API publish error
 * code `connect_asset_not_pbx_ready`.
 */
export function isMohAssetPbxReady(asset: {
  status?: string | null;
  conversionStatus?: string | null;
  pbxStorageKey?: string | null;
  pbxFormat?: string | null;
} | null | undefined): boolean {
  if (!asset) return false;
  if (asset.status !== "ready") return false;
  if (asset.conversionStatus !== "ready") return false;
  if (!asset.pbxStorageKey) return false;
  if (!isAsteriskSafePbxFormat(asset.pbxFormat ?? null)) return false;
  return true;
}
