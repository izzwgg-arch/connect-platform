/**
 * M10 — client for the api service's internal queue door
 * (POST /internal/agent/queue/action, shared-secret header, fail-closed).
 * Never called in simulate mode.
 */
import { postInternalApi } from "./internalApiPost";

export interface QueueApiClient {
  call(body: Record<string, unknown>): Promise<any>;
}

export function makeQueueApiClient(opts: { baseUrl?: string; secret?: string; timeoutMs?: number } = {}): QueueApiClient {
  const baseUrl = (opts.baseUrl ?? process.env.AGENT_API_BASE_URL ?? "http://api:3001").replace(/\/$/, "");
  const timeoutMs = opts.timeoutMs ?? 15_000;
  return {
    async call(body: Record<string, unknown>): Promise<any> {
      const secret = (opts.secret ?? process.env.AGENT_INTERNAL_SECRET ?? "").trim();
      if (!secret) throw new Error("queue_api_secret_unset (AGENT_INTERNAL_SECRET) — fail-closed");
      const resp = await postInternalApi({ url: `${baseUrl}/internal/agent/queue/action`, secret, body, timeoutMs });
      const json: any = await resp.json().catch(() => ({}));
      if (!resp.ok || json?.ok !== true) {
        throw new Error(`queue_api_error status=${resp.status} ${JSON.stringify(json).slice(0, 300)}`);
      }
      return json;
    },
  };
}
