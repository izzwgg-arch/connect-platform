import { getVisualQaMockResponse } from "./visualQaMockApi";

export class ApiError extends Error {
  status: number;
  /** Parsed JSON body returned by the server on non-2xx responses, if any.
   *  Callers that need structured error details (e.g. the IVR publish
   *  endpoint returns `{ error: "prompt_refs_not_in_catalog", missing: [...] }`
   *  on 422) can read this without re-parsing the message. */
  body: unknown | null;
  constructor(message: string, status = 500, body: unknown | null = null) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

/**
 * API origin for browser calls.
 * - If NEXT_PUBLIC_API_URL is set (non-empty), use it (local dev: http://localhost:3001).
 * - If unset/empty at build time, use same-origin `/api` so the portal works on every
 *   hostname nginx serves (avoids hard-coding one domain when users hit a typo/alias host).
 */
function baseUrl(): string {
  const baked = process.env.NEXT_PUBLIC_API_URL;
  const fromEnv = baked != null && String(baked).trim() !== "" ? String(baked).trim().replace(/\/$/, "") : "";
  if (fromEnv) return fromEnv;
  if (typeof window !== "undefined") {
    return `${window.location.origin.replace(/\/$/, "")}/api`;
  }
  return (process.env.PORTAL_API_INTERNAL_URL || "http://127.0.0.1:3001").replace(/\/$/, "");
}

/** Same origin the portal uses for API calls — suitable for displaying public webhook URLs in the browser. */
export function getPortalApiBaseUrl(): string {
  return baseUrl();
}

function parseJsonResponse<T>(res: Response, text: string): T {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new ApiError(`Empty response body (${res.status})`, res.status);
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const snippet = trimmed.length > 160 ? `${trimmed.slice(0, 160)}…` : trimmed;
    throw new ApiError(
      `Expected JSON from API but got ${res.headers.get("content-type") || "unknown type"} (starts with: ${snippet.replace(/\s+/g, " ")})`,
      res.status,
    );
  }
}

function browserToken(): string {
  if (typeof window === "undefined") return "";
  return (
    localStorage.getItem("token") ||
    localStorage.getItem("cc-token") ||
    localStorage.getItem("authToken") ||
    ""
  );
}

function browserTenantContext(): string {
  if (typeof window === "undefined") return "";
  const scope = localStorage.getItem("cc-admin-scope") || "TENANT";
  if (scope === "GLOBAL") return "";
  return localStorage.getItem("cc-tenant-id") || "";
}

type ApiRequestOptions = {
  timeoutMs?: number;
};

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException
    ? err.name === "AbortError" || /abort/i.test(err.message)
    : /abort/i.test(String((err as { name?: unknown; message?: unknown } | null)?.name || (err as { message?: unknown } | null)?.message || err));
}

async function apiRequest<T>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
  token?: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  const visualQaMock = getVisualQaMockResponse(method, path, body);
  if (visualQaMock.handled) return visualQaMock.data as T;

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 10000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...((token || browserToken()) ? { authorization: `Bearer ${token || browserToken()}` } : {}),
        ...(browserTenantContext() ? { "x-tenant-context": browserTenantContext() } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      signal: controller.signal
    });
    const text = await res.text();
    if (!res.ok) {
      let errPayload: any = null;
      try {
        errPayload = text.trim() ? JSON.parse(text) : null;
      } catch {
        errPayload = null;
      }
      const errCode = String(errPayload?.error || "").trim();
      const errMessage = String(errPayload?.message || "").trim();
      const detail = [errCode, errMessage].filter(Boolean).join(": ");
      const fallback =
        !errPayload && text.trim()
          ? text.trim().length > 200
            ? `${text.trim().slice(0, 200)}…`
            : text.trim()
          : "";
      throw new ApiError(detail || fallback || `Request failed (${res.status})`, res.status, errPayload);
    }
    return parseJsonResponse<T>(res, text);
  } catch (err) {
    if (isAbortError(err)) {
      throw new ApiError(`Request timed out after ${Math.round(timeoutMs / 1000)}s`, 408);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export async function apiGet<T>(path: string, token?: string, options: ApiRequestOptions = {}): Promise<T> {
  return apiRequest<T>("GET", path, undefined, token, options);
}

export async function apiPost<T>(path: string, body?: Record<string, unknown>, token?: string, options?: ApiRequestOptions): Promise<T> {
  return apiRequest<T>("POST", path, body, token, options);
}

export async function apiPut<T>(path: string, body?: Record<string, unknown>, token?: string): Promise<T> {
  return apiRequest<T>("PUT", path, body, token);
}

export async function apiPatch<T>(path: string, body?: Record<string, unknown>, token?: string): Promise<T> {
  return apiRequest<T>("PATCH", path, body, token);
}

export async function apiDelete<T>(path: string, token?: string): Promise<T> {
  return apiRequest<T>("DELETE", path, undefined, token);
}

/**
 * Fetches a binary resource at an absolute URL with the current user's Bearer
 * token included as an Authorization header.
 *
 * Use this for authenticated document streaming — the server requires BOTH a
 * valid JWT and a valid HMAC-signed URL. Passing `window.open(signedUrl)` alone
 * would lose the Authorization header and be rejected with 401.
 *
 * Usage:
 *   const blob = await apiFetchBlob(signedUrl);
 *   const blobUrl = URL.createObjectURL(blob);
 *   window.open(blobUrl, "_blank", "noopener,noreferrer");
 *   setTimeout(() => URL.revokeObjectURL(blobUrl), 30_000);
 *
 * @param absoluteUrl  Full URL (e.g. from /crm/documents/:id/open-url response).
 * @param timeoutMs    Abort timeout (default 60 s for potentially large files).
 */
export async function apiFetchBlob(absoluteUrl: string, timeoutMs = 60_000): Promise<Blob> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const token = browserToken();
    const headers: Record<string, string> = {};
    if (token) headers["authorization"] = `Bearer ${token}`;
    const tenantCtx = browserTenantContext();
    if (tenantCtx) headers["x-tenant-context"] = tenantCtx;

    const res = await fetch(absoluteUrl, {
      method: "GET",
      headers,
      cache: "no-store",
      signal: controller.signal,
    });

    if (!res.ok) {
      let errCode = `http_${res.status}`;
      try {
        const json = await res.json();
        errCode = json?.error ?? errCode;
      } catch { /* non-JSON error body */ }
      throw new ApiError(`Document fetch failed: ${errCode}`, res.status);
    }
    return await res.blob();
  } catch (err) {
    if (isAbortError(err)) {
      throw new ApiError(`Document fetch timed out after ${Math.round(timeoutMs / 1000)}s`, 408);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export async function apiUploadCrmVoicemailDrop(
  input: {
    name: string;
    description?: string;
    campaignId?: string;
    isDefault?: boolean;
    file: File;
  },
  token?: string,
): Promise<{
  voicemailDrop: unknown;
}> {
  const fd = new FormData();
  fd.append("name", input.name);
  if (input.description) fd.append("description", input.description);
  if (input.campaignId) fd.append("campaignId", input.campaignId);
  if (input.isDefault) fd.append("isDefault", "true");
  fd.append("file", input.file);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const res = await fetch(`${baseUrl()}/crm/voicemail-drops`, {
      method: "POST",
      headers: {
        ...((token || browserToken()) ? { authorization: `Bearer ${token || browserToken()}` } : {}),
        ...(browserTenantContext() ? { "x-tenant-context": browserTenantContext() } : {}),
      },
      body: fd,
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      let errPayload: any = null;
      try {
        errPayload = text.trim() ? JSON.parse(text) : null;
      } catch {
        errPayload = null;
      }
      const detail = [errPayload?.error, errPayload?.message].filter(Boolean).join(": ");
      throw new ApiError(detail || `Upload failed (${res.status})`, res.status, errPayload);
    }
    return parseJsonResponse(res, text);
  } finally {
    clearTimeout(timeout);
  }
}

/** Multipart upload for Connect chat attachments (field name `file`). */
export async function apiUploadChatAttachment(
  threadId: string,
  file: File,
  token?: string,
): Promise<{
  ok: boolean;
  storageKey: string;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  fileName: string;
  /** Server-classified media kind: "image" | "audio" | "video" | "file". */
  mediaKind?: string | null;
  /** ffprobe-derived duration for audio/video (milliseconds). */
  durationMs?: number | null;
  /** image-size / ffprobe pixel dimensions for image/video. */
  width?: number | null;
  height?: number | null;
}> {
  const fd = new FormData();
  fd.append("file", file);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const res = await fetch(`${baseUrl()}/chat/threads/${encodeURIComponent(threadId)}/attachments/upload`, {
      method: "POST",
      headers: {
        ...((token || browserToken()) ? { authorization: `Bearer ${token || browserToken()}` } : {}),
        ...(browserTenantContext() ? { "x-tenant-context": browserTenantContext() } : {}),
      },
      body: fd,
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      let errPayload: unknown = null;
      try {
        errPayload = text.trim() ? JSON.parse(text) : null;
      } catch {
        errPayload = null;
      }
      const ep = errPayload as { error?: string; message?: string } | null;
      const detail = [ep?.error, ep?.message].filter(Boolean).join(": ");
      throw new ApiError(detail || `Upload failed (${res.status})`, res.status);
    }
    return parseJsonResponse(res, text);
  } finally {
    clearTimeout(timeout);
  }
}

/** Multipart upload for tenant-scoped contact avatars (field name `file`). */
export async function apiUploadContactAvatar(
  contactId: string,
  file: File,
  token?: string,
): Promise<{ ok: boolean; avatarUrl: string }> {
  const fd = new FormData();
  fd.append("file", file);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const res = await fetch(`${baseUrl()}/contacts/${encodeURIComponent(contactId)}/avatar`, {
      method: "POST",
      headers: {
        ...((token || browserToken()) ? { authorization: `Bearer ${token || browserToken()}` } : {}),
        ...(browserTenantContext() ? { "x-tenant-context": browserTenantContext() } : {}),
      },
      body: fd,
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      let errPayload: unknown = null;
      try {
        errPayload = text.trim() ? JSON.parse(text) : null;
      } catch {
        errPayload = null;
      }
      const ep = errPayload as { error?: string; message?: string } | null;
      const detail = [ep?.error, ep?.message].filter(Boolean).join(": ");
      throw new ApiError(detail || `Upload failed (${res.status})`, res.status);
    }
    return parseJsonResponse(res, text);
  } finally {
    clearTimeout(timeout);
  }
}

/** Multipart upload for the signed-in user's own profile photo (field name `file`). */
export async function apiUploadUserAvatar(
  file: File,
  token?: string,
): Promise<{ ok: boolean; avatarUrl: string }> {
  const fd = new FormData();
  fd.append("file", file);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const res = await fetch(`${baseUrl()}/me/avatar`, {
      method: "POST",
      headers: {
        ...((token || browserToken()) ? { authorization: `Bearer ${token || browserToken()}` } : {}),
        ...(browserTenantContext() ? { "x-tenant-context": browserTenantContext() } : {}),
      },
      body: fd,
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      let errPayload: unknown = null;
      try { errPayload = text.trim() ? JSON.parse(text) : null; } catch { errPayload = null; }
      const ep = errPayload as { error?: string; message?: string } | null;
      throw new ApiError(ep?.error || ep?.message || `Upload failed (${res.status})`, res.status);
    }
    return parseJsonResponse(res, text);
  } finally {
    clearTimeout(timeout);
  }
}

/** Delete the signed-in user's profile photo. */
export async function apiDeleteUserAvatar(): Promise<{ ok: boolean }> {
  return apiDelete("/me/avatar");
}

/** Multipart upload for the signed-in user's extension voicemail greeting. */
export async function apiUploadVoicemailGreeting(
  file: File,
  token?: string,
): Promise<{
  ok: boolean;
  status: "default" | "custom";
  durationSec: number | null;
  updatedAt: string | null;
  originalFilename: string | null;
  previewUrl: string | null;
  publishStatus: string;
  publishDetail: string | null;
}> {
  const fd = new FormData();
  fd.append("file", file);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const res = await fetch(`${baseUrl()}/voicemail/greeting/upload`, {
      method: "POST",
      headers: {
        ...((token || browserToken()) ? { authorization: `Bearer ${token || browserToken()}` } : {}),
        ...(browserTenantContext() ? { "x-tenant-context": browserTenantContext() } : {}),
      },
      body: fd,
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      let errPayload: unknown = null;
      try {
        errPayload = text.trim() ? JSON.parse(text) : null;
      } catch {
        errPayload = null;
      }
      const ep = errPayload as { error?: string; message?: string } | null;
      const detail = [ep?.error, ep?.message].filter(Boolean).join(": ");
      throw new ApiError(detail || `Upload failed (${res.status})`, res.status);
    }
    return parseJsonResponse(res, text);
  } finally {
    clearTimeout(timeout);
  }
}
