/**
 * M1 — client for the api service's internal MOH-override door
 * (POST /internal/agent/moh/override, shared-secret header, fail-closed).
 * The ONLY network call the M1 op ever makes, and never in simulate mode.
 */
export interface MohApiClient {
  call(body: Record<string, unknown>): Promise<any>;
}

export function makeMohApiClient(opts: { baseUrl?: string; secret?: string; timeoutMs?: number } = {}): MohApiClient {
  const baseUrl = (opts.baseUrl ?? process.env.AGENT_API_BASE_URL ?? "http://api:3001").replace(/\/$/, "");
  const timeoutMs = opts.timeoutMs ?? 15_000;
  return {
    async call(body: Record<string, unknown>): Promise<any> {
      const secret = (opts.secret ?? process.env.AGENT_INTERNAL_SECRET ?? "").trim();
      if (!secret) throw new Error("moh_api_secret_unset (AGENT_INTERNAL_SECRET) — fail-closed");
      const resp = await fetch(`${baseUrl}/internal/agent/moh/override`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agent-internal-secret": secret },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const json: any = await resp.json().catch(() => ({}));
      if (!resp.ok || json?.ok !== true) {
        throw new Error(`moh_api_error status=${resp.status} ${JSON.stringify(json).slice(0, 300)}`);
      }
      return json;
    },
  };
}
