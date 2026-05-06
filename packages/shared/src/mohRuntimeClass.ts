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
