export class ApiError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}

function baseUrl(): string {
  const fromEnv = process.env.NEXT_PUBLIC_API_URL || "";
  return fromEnv.replace(/\/$/, "");
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

async function apiRequest<T>(method: "GET" | "POST" | "PATCH", path: string, body?: Record<string, unknown>, token?: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      method,
      headers: {
        ...(method !== "GET" ? { "content-type": "application/json" } : {}),
        ...((token || browserToken()) ? { authorization: `Bearer ${token || browserToken()}` } : {}),
        ...(browserTenantContext() ? { "x-tenant-context": browserTenantContext() } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      signal: controller.signal
    });
    if (!res.ok) {
      throw new ApiError(`Request failed (${res.status})`, res.status);
    }
    return (await res.json()) as T;
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

export async function apiPatch<T>(path: string, body?: Record<string, unknown>, token?: string): Promise<T> {
  return apiRequest<T>("PATCH", path, body, token);
}
