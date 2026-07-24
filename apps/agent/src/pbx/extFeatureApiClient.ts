/**
 * M11 — client for the api service's internal extension-feature door
 * (POST /internal/agent/extfeature/action, shared-secret header, fail-closed).
 * Never called in simulate mode.
 */
export interface ExtFeatureApiClient {
  call(body: Record<string, unknown>): Promise<any>;
}

export function makeExtFeatureApiClient(opts: { baseUrl?: string; secret?: string; timeoutMs?: number } = {}): ExtFeatureApiClient {
  const baseUrl = (opts.baseUrl ?? process.env.AGENT_API_BASE_URL ?? "http://api:3001").replace(/\/$/, "");
  const timeoutMs = opts.timeoutMs ?? 15_000;
  return {
    async call(body: Record<string, unknown>): Promise<any> {
      const secret = (opts.secret ?? process.env.AGENT_INTERNAL_SECRET ?? "").trim();
      if (!secret) throw new Error("extfeature_api_secret_unset (AGENT_INTERNAL_SECRET) — fail-closed");
      const resp = await fetch(`${baseUrl}/internal/agent/extfeature/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-agent-internal-secret": secret },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const json: any = await resp.json().catch(() => ({}));
      if (!resp.ok || json?.ok !== true) {
        throw new Error(`extfeature_api_error status=${resp.status} ${JSON.stringify(json).slice(0, 300)}`);
      }
      return json;
    },
  };
}
