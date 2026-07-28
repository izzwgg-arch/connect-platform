/**
 * M3 — client for the api service's internal inbound-route door
 * (route inspect / list-destinations / retarget / restore), which fronts the
 * PBX route helper. The live path is UNAVAILABLE until H2 (the tenant-scoped
 * destination resolver) is installed: the default factory throws on any live
 * call, so M3 can be fully built + certified in simulate with zero live surface.
 */
import { postInternalApi } from "./internalApiPost";

export interface RouteApiClient {
  call(body: Record<string, unknown>): Promise<any>;
}

/**
 * H2-GATED stub. Until H2 is installed and this factory is replaced with a real
 * client in server.ts, ANY live route call throws — M3 live is structurally
 * impossible. Simulate never calls this (the op short-circuits on ctx.simulate).
 */
export function makeH2PendingRouteApiClient(): RouteApiClient {
  return {
    async call(): Promise<any> {
      throw new Error("route_api_unavailable: M3 live path is fenced until the H2 destination resolver is installed + verified");
    },
  };
}

/** The real client (wired only once H2 exists). Mirrors makeMohApiClient. */
export function makeRouteApiClient(opts: { baseUrl?: string; secret?: string; timeoutMs?: number } = {}): RouteApiClient {
  const baseUrl = (opts.baseUrl ?? process.env.AGENT_API_BASE_URL ?? "http://api:3001").replace(/\/$/, "");
  const timeoutMs = opts.timeoutMs ?? 20_000;
  return {
    async call(body: Record<string, unknown>): Promise<any> {
      const secret = (opts.secret ?? process.env.AGENT_INTERNAL_SECRET ?? "").trim();
      if (!secret) throw new Error("route_api_secret_unset (AGENT_INTERNAL_SECRET) — fail-closed");
      const resp = await postInternalApi({ url: `${baseUrl}/internal/agent/route/action`, secret, body, timeoutMs });
      const json: any = await resp.json().catch(() => ({}));
      if (!resp.ok || json?.ok !== true) {
        throw new Error(`route_api_error status=${resp.status} ${JSON.stringify(json).slice(0, 300)}`);
      }
      return json;
    },
  };
}
