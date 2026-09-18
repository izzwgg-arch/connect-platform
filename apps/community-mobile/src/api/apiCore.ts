/**
 * Pure api-request core: no react-native, no expo-* imports, so it can be
 * unit tested directly under plain Node (src/api/client.test.ts) the same
 * way apps/mobile keeps its pure-logic modules import-free of native code.
 * src/api/client.ts wires this up to the real fetch + SecureStore for the app.
 */

export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type ApiRequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  form?: unknown;
  idempotencyKey?: string;
  signal?: AbortSignal;
  auth?: boolean;
};

export type ApiClientDeps = {
  baseUrl: string;
  fetchImpl: typeof fetch;
  getAccessToken: () => string | null;
  getRefreshToken: () => string | null;
  /** Called with the raw refresh-token network response; returns whether refresh succeeded. */
  doRefresh: () => Promise<boolean>;
  onUnauthorized: () => void | Promise<void>;
};

export type ApiClient = {
  request: <T = any>(path: string, opts?: ApiRequestOptions, _retried?: boolean) => Promise<T>;
};

/**
 * Creates an api client bound to the given deps. Refresh is serialised
 * through a single in-flight promise so N concurrent 401s trigger exactly
 * one POST /auth/refresh — that invariant is what client.test.ts asserts.
 */
export function createApiClient(deps: ApiClientDeps): ApiClient {
  async function request<T = any>(path: string, opts: ApiRequestOptions = {}, _retried = false): Promise<T> {
    const headers: Record<string, string> = {};
    const token = deps.getAccessToken();
    if (token && opts.auth !== false) headers.authorization = `Bearer ${token}`;
    if (opts.idempotencyKey) headers["idempotency-key"] = opts.idempotencyKey;
    let body: BodyInit | undefined;
    if (opts.form !== undefined) body = opts.form as BodyInit;
    else if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.body);
    }
    const res = await deps.fetchImpl(`${deps.baseUrl}${path}`, {
      method: opts.method ?? (body ? "POST" : "GET"),
      headers,
      body,
      signal: opts.signal,
    });
    if (res.status === 401 && !_retried && deps.getRefreshToken() && !path.startsWith("/auth/refresh")) {
      const ok = await deps.doRefresh();
      if (ok) return request<T>(path, opts, true);
    }
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      if (res.status === 401 && opts.auth !== false) await deps.onUnauthorized();
      throw new ApiError(res.status, data?.error ?? "error", data?.message ?? `Request failed (${res.status})`, data?.details);
    }
    return data as T;
  }
  return { request };
}

/** Wraps a raw refresh call so N concurrent callers share one in-flight request. */
export function serializeRefresh(doRefresh: () => Promise<boolean>): () => Promise<boolean> {
  let inFlight: Promise<boolean> | null = null;
  return () => {
    if (inFlight) return inFlight;
    inFlight = doRefresh().finally(() => {
      // Cleared on the next microtask so a burst of synchronous callers all
      // observe the same in-flight promise before it's released.
      setTimeout(() => (inFlight = null), 0);
    });
    return inFlight;
  };
}
