import type { VitalPbxApiError, VitalPbxErrorCode } from "./types";

export function makeVitalPbxError(
  message: string,
  code: VitalPbxErrorCode,
  httpStatus?: number,
  retryable = false,
  details?: Record<string, unknown>
): VitalPbxApiError {
  const err = new Error(message) as VitalPbxApiError;
  err.code = code;
  err.httpStatus = httpStatus;
  err.retryable = retryable;
  err.details = details;
  return err;
}

export function normalizeVitalPbxError(status?: number, message?: string): { code: VitalPbxErrorCode; retryable: boolean } {
  const msg = String(message || "").toLowerCase();
  if (status === 401 || status === 403) return { code: "PBX_AUTH_FAILED", retryable: false };
  if (status === 400 || status === 422) return { code: "PBX_VALIDATION_FAILED", retryable: false };
  if (status === 404) return { code: "PBX_VALIDATION_FAILED", retryable: false };
  if (status === 408) return { code: "PBX_TIMEOUT", retryable: true };
  if (status === 409) return { code: "PBX_VALIDATION_FAILED", retryable: false };
  if (status === 429) return { code: "PBX_RATE_LIMIT", retryable: true };
  if (msg.includes("tenant")) return { code: "PBX_TENANT_CONTEXT_ERROR", retryable: false };
  if (typeof status === "number" && status >= 500) return { code: "PBX_UNAVAILABLE", retryable: true };
  return { code: "PBX_UNKNOWN_ERROR", retryable: false };
}
