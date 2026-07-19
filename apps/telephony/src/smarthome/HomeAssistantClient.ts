// HomeAssistantClient — thin wrapper over the Home Assistant REST API.
//   POST {baseUrl}/api/services/{domain}/{service}   body: { entity_id, ... }
//   GET  {baseUrl}/api/states/{entityId}
// Auth: long-lived access token as Bearer.

export type HaErrorKind = "unreachable" | "auth" | "service" | "timeout";

export class HaError extends Error {
  readonly kind: HaErrorKind;
  constructor(kind: HaErrorKind, message: string) {
    super(message);
    this.name = "HaError";
    this.kind = kind;
  }
}

export interface HaTarget {
  baseUrl: string;
  token: string;
}

export interface HaServiceCall {
  domain: string;
  service: string;
  entityId: string;
  serviceData?: Record<string, unknown>;
}

export class HomeAssistantClient {
  private readonly timeoutMs: number;

  constructor(opts: { timeoutMs?: number } = {}) {
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  /** Call a HA service. Retries once on network failure. */
  async callService(target: HaTarget, call: HaServiceCall): Promise<void> {
    const url = `${target.baseUrl.replace(/\/+$/, "")}/api/services/${encodeURIComponent(call.domain)}/${encodeURIComponent(call.service)}`;
    const body = JSON.stringify({ entity_id: call.entityId, ...(call.serviceData ?? {}) });
    let lastErr: HaError | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.request(target, url, { method: "POST", body });
        return;
      } catch (err) {
        lastErr = err instanceof HaError ? err : new HaError("unreachable", String(err));
        // Only network-ish failures are worth one retry.
        if (lastErr.kind === "auth" || lastErr.kind === "service") throw lastErr;
      }
    }
    throw lastErr ?? new HaError("unreachable", "unknown failure");
  }

  /** Read back an entity state, e.g. "on" / "off". Returns null on any failure. */
  async getState(target: HaTarget, entityId: string): Promise<string | null> {
    const url = `${target.baseUrl.replace(/\/+$/, "")}/api/states/${encodeURIComponent(entityId)}`;
    try {
      const json = (await this.request(target, url, { method: "GET" })) as { state?: string } | null;
      return typeof json?.state === "string" ? json.state : null;
    } catch {
      return null;
    }
  }

  private async request(
    target: HaTarget,
    url: string,
    init: { method: string; body?: string },
  ): Promise<unknown> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: init.method,
        body: init.body,
        signal: ac.signal,
        headers: {
          Authorization: `Bearer ${target.token}`,
          "Content-Type": "application/json",
        },
      });
      if (res.status === 401 || res.status === 403) {
        throw new HaError("auth", `Home Assistant rejected token (${res.status})`);
      }
      if (!res.ok) {
        throw new HaError("service", `Home Assistant returned ${res.status}`);
      }
      const text = await res.text();
      try {
        return text ? JSON.parse(text) : null;
      } catch {
        return null;
      }
    } catch (err) {
      if (err instanceof HaError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new HaError("timeout", `Home Assistant timed out after ${this.timeoutMs}ms`);
      }
      throw new HaError("unreachable", err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }
  }
}
