export class ApiError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
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

async function apiRequest<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: Record<string, unknown>, token?: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
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
      throw new ApiError(detail || fallback || `Request failed (${res.status})`, res.status);
    }
    return parseJsonResponse<T>(res, text);
  } finally {
    clearTimeout(timeout);
  }
}

export async function apiGet<T>(path: string, token?: string): Promise<T> {
  return apiRequest<T>("GET", path, undefined, token);
}

export async function apiPost<T>(path: string, body?: Record<string, unknown>, token?: string): Promise<T> {
  return apiRequest<T>("POST", path, body, token);
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
