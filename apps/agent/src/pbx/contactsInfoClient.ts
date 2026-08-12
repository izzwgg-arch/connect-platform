/**
 * Client for the api's read-only contacts door
 * (POST /internal/agent/contacts-info, shared-secret header, fail-closed).
 * Lets the assistant answer "who is in my contacts" / "what's X's number"
 * instead of "Cannot view contacts" — the trainer's red rows 12/25.
 */
import { postInternalApi } from "./internalApiPost";
import type { AgentContactsInfo } from "../tools/contactsTools";

export function makeContactsInfoClient(
  opts: { baseUrl?: string; secret?: string; timeoutMs?: number } = {},
): (tenantId: string, search?: string) => Promise<AgentContactsInfo> {
  const baseUrl = (opts.baseUrl ?? process.env.AGENT_API_BASE_URL ?? "http://api:3001").replace(/\/$/, "");
  const timeoutMs = opts.timeoutMs ?? 15_000;
  return async (tenantId: string, search?: string): Promise<AgentContactsInfo> => {
    const secret = (opts.secret ?? process.env.AGENT_INTERNAL_SECRET ?? "").trim();
    if (!secret) throw new Error("contacts_info_secret_unset (AGENT_INTERNAL_SECRET) — fail-closed");
    const resp = await postInternalApi({
      url: `${baseUrl}/internal/agent/contacts-info`,
      secret,
      body: search ? { tenantId, search } : { tenantId },
      timeoutMs,
    });
    const json: any = await resp.json().catch(() => ({}));
    if (!resp.ok || json?.ok !== true || !json?.info) {
      throw new Error(`contacts_info_error status=${resp.status} ${JSON.stringify(json).slice(0, 200)}`);
    }
    return json.info as AgentContactsInfo;
  };
}
